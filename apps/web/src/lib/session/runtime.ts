import { asset } from "$app/paths";
import {
  CompositeInputAdapter,
  FakeInstrument,
  SmplrPianoInstrument,
  StimulusPlayer,
  TapInputAdapter,
  getAudioContextManager,
  isMidiSupported,
  type FakeClock,
  type InputAdapter,
  type Instrument,
} from "@clavis/audio";
import {
  composePieceRun,
  composeSession,
  createRng,
  createUlidGenerator,
  type LearningEvent,
  type StimulusSpec,
} from "@clavis/core";
import { loadMilestones } from "@clavis/content";
import { scoreAttempt } from "@clavis/scoring";
import { AUTO_CONTINUE_META_KEY, parseAutoContinueSec } from "../auto-continue";
import { effectiveSettings } from "../home";
import { nextSteps as computeNextSteps, type NextSteps } from "../next-steps";
import { getLearnerState } from "../learner";
import { getNotationClient } from "../notation/shared";
import { appGenerators, appPieces, generatorFor, pieceInputs } from "../pieces";
import { createNotationViewPort, type NotationViewPort } from "../notation/view-port";
import { MIDI_INPUT_META_KEY, createInput, detachFakeInput, parseMidiInputId } from "../input";
import { placementPlanFor } from "../placement";
import { createPractisedReporter } from "../practice-cue-browser";
import { SessionMachine, type SessionDeps } from "./machine";
import { findOpenSessions } from "./open";
import { parseLatency, type SessionParams } from "./params";

export const HEADPHONES_META_KEY = "headphones";
export const LATENCY_META_KEY = "latency";
/** Device meta: the warm-up concept card has been shown in full once. */
export const ORIENT_CARD_META_KEY = "seen.orient-card";

export interface SessionRuntime {
  machine: SessionMachine;
  /** The on-screen keyboard feeds this: the only input in Away mode, an extra one at the piano. */
  tap: TapInputAdapter | undefined;
  /** What to offer after the session (Keep going, Learn something new), from the current state. */
  nextSteps(elapsedSec: number): NextSteps;
  /** Title of a piece, library or imported, for the run summary. */
  pieceTitle(pieceId: string): string | undefined;
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
export async function createSessionRuntime(
  params: SessionParams,
  opts: { placement?: boolean } = {},
): Promise<RuntimeResult> {
  const placement = opts.placement === true;
  const learner = await getLearnerState();
  if (!learner.ok) return { ok: false, message: "Local storage is unavailable on this device." };
  const { store, deviceId, graph, service } = learner;

  const fake = params.inputKind === "fake";
  const audio = getAudioContextManager();

  // Fake input has no audio context: use performance.now for everything so nothing depends on the
  // browser starting an AudioContext (headless WebKit may not). Silent audio with tap input has
  // nothing that needs the context clock either. The mic and audible stimuli share the context.
  const performanceClock =
    fake || (params.silent && (params.inputKind === "tap" || params.inputKind === "midi"));
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

  // MIDI is chosen in settings, but a browser without Web MIDI (or a stored choice from another
  // browser profile) falls back to the mic.
  const inputKind = params.inputKind === "midi" && !isMidiSupported() ? "mic" : params.inputKind;
  const midiInputId = parseMidiInputId(await store.getMeta(MIDI_INPUT_META_KEY));
  const handle = createInput(inputKind, {
    clock: { now: contextNowMs, schedule },
    ...(performanceClock ? { tapClockMs: contextNowMs } : {}),
    ...(midiInputId === undefined ? {} : { midiInputId }),
  });
  // At the piano the on-screen keys answer too, so the learner can practise anywhere. Away mode's
  // main input already is the keyboard, and placement is for the instrument alone.
  const keys =
    handle.kind === "tap" || placement
      ? undefined
      : new TapInputAdapter({
          getContext: performanceClock
            ? () => ({ currentTime: contextNowMs() / 1000 })
            : () => audio.getContext(),
        });
  const input: InputAdapter = keys
    ? new CompositeInputAdapter(handle.adapter, keys)
    : handle.adapter;
  const tap = handle.tap ?? keys;

  const newId = createUlidGenerator({
    now: () => Date.now(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  });

  // Skips today's practice cue once a minute of practice is logged (T6.4).
  const reportPractised = createPractisedReporter(store);

  const storedHeadphones = await store.getMeta(HEADPHONES_META_KEY);
  const known =
    typeof storedHeadphones === "boolean"
      ? storedHeadphones
      : typeof service.state.settings.headphones === "boolean"
        ? service.state.settings.headphones
        : undefined;
  const headphones = params.headphones === "ask" ? undefined : (params.headphones ?? known);
  const latency = parseLatency(await store.getMeta(LATENCY_META_KEY));
  const autoContinueSec = parseAutoContinueSec(await store.getMeta(AUTO_CONTINUE_META_KEY));
  let orientCardSeen = (await store.getMeta(ORIENT_CARD_META_KEY)) === true;

  // Reading items draw through this port (R17: `show` resolves after the paint). The worker only
  // starts when the machine first preloads, which it does only for plans with notation items.
  const notation = createNotationViewPort(getNotationClient());

  const seedBytes = crypto.getRandomValues(new Uint32Array(1));
  const seed = seedBytes[0] ?? Date.now() % 0x7fffffff;
  const deps: SessionDeps = {
    deviceId,
    mode: placement ? "instrument" : params.mode,
    ...(params.practice ? { practice: true } : {}),
    ...(params.practice && params.skills ? { skills: params.skills } : {}),
    practiceStep: !placement,
    autoContinueMs: autoContinueSec * 1000,
    ...(params.learn && !placement
      ? { extraNewItems: effectiveSettings(service.state.settings).newItemsPerDay }
      : {}),
    graph,
    milestones: loadMilestones(),
    // Placement (R19): the plan replaces the composer and nothing but its result is stored. Its
    // HANDS section runs only with MIDI (R27), as HANDS items do in sessions.
    ...(placement
      ? { placement: { plan: placementPlanFor(graph, createRng(seed), inputKind) } }
      : {}),
    compose: (input) =>
      params.run !== undefined && !placement
        ? composePieceRun({
            state: input.state,
            graph: input.graph,
            pieces: appPieces(input.state),
            pieceId: params.run,
            now: input.now,
            tzOffsetMin: input.tzOffsetMin,
            generators: appGenerators(input.state),
            // A hands-together piece (T5.6) can only be run on a MIDI keyboard.
            polyphonic: inputKind === "midi",
          })
        : // Chords (HANDS) need an input that can hear them: only MIDI does, today.
          composeSession({
            ...input,
            ...pieceInputs(input.state),
            polyphonic: inputKind === "midi",
          }),
    generate: (item, ctx) => {
      const node = graph.nodes.find((n) => n.id === item.nodeId);
      if (!node) throw new Error(`Unknown skill node ${item.nodeId}`);
      return generatorFor(item.generator, service.state).generate(node, item.params, ctx);
    },
    player: {
      play: (spec) => stimulusPlayer.play(spec),
      stop: () => {
        stimulusPlayer.stop();
      },
      load: () => stimulusPlayer.load(),
    },
    input,
    notation,
    score: scoreAttempt,
    append: async (events: LearningEvent[]) => {
      reportPractised(await service.append(events));
    },
    getState: () => service.state,
    clock: { contextNowMs, wallNow: () => Date.now(), schedule },
    newId,
    seed,
    // R6: minutes east of UTC, the opposite sign of getTimezoneOffset (`|| 0` turns -0 into 0).
    tzOffsetMin: -new Date().getTimezoneOffset() || 0,
    ...(params.budgetSec === undefined ? {} : { budgetSec: params.budgetSec }),
    latency,
    headphones,
    // The answer is saved as an event, and placement writes only `placement.completed`.
    askHeadphones: !placement && (!fake || params.headphones === "ask"),
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
    ...(placement
      ? {}
      : { openSessions: async () => findOpenSessions(await store.list(), deviceId) }),
  };
  const machine = new SessionMachine(deps);

  if (fake || (params.silent && params.inputKind === "midi")) {
    // Test hook: lets Playwright see what the current item expects. Never exposed otherwise
    // (MIDI exposes it only with `?audio=silent`, which real use never sets).
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
      pieceTitle(pieceId) {
        return appPieces(service.state).find((p) => p.id === pieceId)?.title;
      },
      nextSteps(elapsedSec) {
        return computeNextSteps({
          state: service.state,
          graph,
          now: Date.now(),
          tzOffsetMin: deps.tzOffsetMin,
          mode: params.mode,
          budgetSec: machine.budgetSec,
          elapsedSec,
          polyphonic: inputKind === "midi",
        });
      },
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
        // Only a microphone answer needs capture. Set it up now: changing the iOS audio session
        // category later would interrupt the running context.
        if (!fake) await audio.unlock({ capture: inputKind === "mic" });
      },
      playExample(spec) {
        if (!fake) void audio.unlock({ capture: inputKind === "mic" });
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
        input.stop();
        if (fake) detachFakeInput();
        if (fake || (params.silent && params.inputKind === "midi")) {
          Reflect.deleteProperty(window, "__clavisSession");
          Reflect.deleteProperty(window, "__clavisExamplesPlayed");
        }
      },
    },
  };
}
