import { asset } from "$app/paths";
import {
  FakeInstrument,
  SmplrPianoInstrument,
  StimulusPlayer,
  getAudioContextManager,
  type FakeClock,
  type Instrument,
  type TapInputAdapter,
} from "@clavis/audio";
import {
  composeSession,
  createUlidGenerator,
  getGenerator,
  type LearningEvent,
  type StimulusSpec,
} from "@clavis/core";
import { scoreAttempt } from "@clavis/scoring";
import { getLearnerState } from "../learner";
import { getNotationClient } from "../notation/shared";
import { createNotationViewPort, type NotationViewPort } from "../notation/view-port";
import { createInput, detachFakeInput } from "../input";
import { SessionMachine, type SessionDeps } from "./machine";
import { findOpenSessions } from "./open";
import { parseLatency, type SessionParams } from "./params";

export const HEADPHONES_META_KEY = "headphones";
export const LATENCY_META_KEY = "latency";
/** Device meta: the warm-up concept card has been shown in full once. */
export const ORIENT_CARD_META_KEY = "seen.orient-card";

export interface SessionRuntime {
  machine: SessionMachine;
  /** The on-screen keyboard feeds this in Away mode. */
  tap: TapInputAdapter | undefined;
  /** Short piano note for key presses. No-op when silent. */
  tone(midi: number): void;
  /** Call from a user gesture before `machine.start()` or `resume()`. */
  unlock(): Promise<void>;
  /** The session's notation port. `NotationView` subscribes to it to draw reading items. */
  readonly notation: NotationViewPort;
  /** Play a concept card example. Call from a tap; stops anything already sounding. */
  playExample(spec: StimulusSpec): void;
  /** True once the warm-up card has been shown in full on this device. */
  readonly orientCardSeen: boolean;
  markOrientCardSeen(): void;
  teardown(): void;
}

export type RuntimeResult = { ok: true; runtime: SessionRuntime } | { ok: false; message: string };

/**
 * Wire the machine to the browser: learner state and store, piano (or a silent fake), input
 * adapters and the clock. All the logic lives in `SessionMachine`; this only builds its deps.
 */
export async function createSessionRuntime(params: SessionParams): Promise<RuntimeResult> {
  const learner = await getLearnerState();
  if (!learner.ok) return { ok: false, message: "Local storage is unavailable on this device." };
  const { store, deviceId, graph, service } = learner;

  const fake = params.inputKind === "fake";
  const audio = getAudioContextManager();

  // Fake input has no audio context: use performance.now for everything so nothing depends on the
  // browser starting an AudioContext (headless WebKit may not). Silent audio with tap input has
  // nothing that needs the context clock either. The mic and audible stimuli share the context.
  const performanceClock = fake || (params.silent && params.inputKind === "tap");
  const contextNowMs = performanceClock
    ? (): number => performance.now()
    : (): number => audio.getContext().currentTime * 1000;
  const schedule: FakeClock["schedule"] = (delayMs, fn) => {
    const id = setTimeout(fn, Math.max(0, delayMs));
    return () => {
      clearTimeout(id);
    };
  };
  const clockSource = {
    get currentTime(): number {
      return contextNowMs() / 1000;
    },
  };

  let instrument: Instrument;
  if (params.silent) {
    instrument = new FakeInstrument();
  } else {
    instrument = new SmplrPianoInstrument({
      getContext: () => audio.getContext() as unknown as BaseAudioContext,
      baseUrl: asset("samples/piano/manifest.json").replace(/\/manifest\.json$/, ""),
    });
  }
  const stimulusPlayer = new StimulusPlayer(clockSource, instrument);

  const handle = createInput(params.inputKind, {
    clock: { now: contextNowMs, schedule },
    ...(performanceClock ? { tapClockMs: contextNowMs } : {}),
  });
  const tap = handle.tap;

  const newId = createUlidGenerator({
    now: () => Date.now(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  });

  const storedHeadphones = await store.getMeta(HEADPHONES_META_KEY);
  const known =
    typeof storedHeadphones === "boolean"
      ? storedHeadphones
      : typeof service.state.settings.headphones === "boolean"
        ? service.state.settings.headphones
        : undefined;
  const headphones = params.headphones === "ask" ? undefined : (params.headphones ?? known);
  const latency = parseLatency(await store.getMeta(LATENCY_META_KEY));
  let orientCardSeen = (await store.getMeta(ORIENT_CARD_META_KEY)) === true;

  // Reading items draw through this port (R17: `show` resolves after the paint). The worker only
  // starts when the machine first preloads, which it does only for plans with notation items.
  const notation = createNotationViewPort(getNotationClient());

  const seedBytes = crypto.getRandomValues(new Uint32Array(1));
  const deps: SessionDeps = {
    deviceId,
    mode: params.mode,
    ...(params.practice ? { practice: true } : {}),
    graph,
    compose: composeSession,
    generate: (item, ctx) => {
      const node = graph.nodes.find((n) => n.id === item.nodeId);
      if (!node) throw new Error(`Unknown skill node ${item.nodeId}`);
      return getGenerator(item.generator).generate(node, item.params, ctx);
    },
    player: {
      play: (spec) => stimulusPlayer.play(spec),
      stop: () => {
        stimulusPlayer.stop();
      },
      load: () => stimulusPlayer.load(),
    },
    input: handle.adapter,
    notation,
    createSingInput: () => createInput("mic").adapter,
    score: scoreAttempt,
    append: async (events: LearningEvent[]) => {
      await service.append(events);
    },
    getState: () => service.state,
    clock: { contextNowMs, wallNow: () => Date.now(), schedule },
    newId,
    seed: seedBytes[0] ?? Date.now() % 0x7fffffff,
    // R6: minutes east of UTC, the opposite sign of getTimezoneOffset (`|| 0` turns -0 into 0).
    tzOffsetMin: -new Date().getTimezoneOffset() || 0,
    ...(params.budgetSec === undefined ? {} : { budgetSec: params.budgetSec }),
    latency,
    headphones,
    askHeadphones: !fake || params.headphones === "ask",
    saveHeadphones: async (value) => {
      await store.setMeta(HEADPHONES_META_KEY, value);
      await service.append([
        {
          id: newId(),
          deviceId,
          at: Date.now(),
          type: "settings.changed",
          v: 2,
          patch: { headphones: value },
        },
      ]);
    },
    openSessions: async () => findOpenSessions(await store.list(), deviceId),
  };
  const machine = new SessionMachine(deps);

  if (fake) {
    // Test hook: lets Playwright see what the current item expects. Never exposed otherwise.
    Object.defineProperty(window, "__clavisSession", {
      configurable: true,
      get: () => machine.debug(),
    });
  }

  return {
    ok: true,
    runtime: {
      machine,
      tap,
      notation,
      tone(midi) {
        if (params.silent) return;
        void stimulusPlayer
          .load()
          .then(() => {
            instrument.start({
              midi,
              time: audio.getContext().currentTime,
              duration: 0.8,
              velocity: 0.8,
            });
          })
          .catch(() => undefined);
      },
      async unlock() {
        // Every mode can ask for sung answers, so set up capture now: changing the iOS audio
        // session category later would interrupt the running context.
        if (!fake) await audio.unlock({ capture: true });
      },
      playExample(spec) {
        if (!fake) void audio.unlock({ capture: true });
        if (fake) {
          const w = window as unknown as { __clavisExamplesPlayed?: number };
          w.__clavisExamplesPlayed = (w.__clavisExamplesPlayed ?? 0) + 1;
        }
        void stimulusPlayer
          .load()
          .then(() => {
            stimulusPlayer.stop();
            stimulusPlayer.play(spec);
          })
          .catch(() => undefined);
      },
      get orientCardSeen() {
        return orientCardSeen;
      },
      markOrientCardSeen() {
        if (orientCardSeen) return;
        orientCardSeen = true;
        void store.setMeta(ORIENT_CARD_META_KEY, true).catch(() => undefined);
      },
      teardown() {
        // Leaving mid-session closes it now; a killed tab is cleaned up by the next start.
        machine.finish();
        notation.hide();
        handle.adapter.stop();
        if (fake) {
          detachFakeInput();
          Reflect.deleteProperty(window, "__clavisSession");
          Reflect.deleteProperty(window, "__clavisExamplesPlayed");
        }
      },
    },
  };
}
