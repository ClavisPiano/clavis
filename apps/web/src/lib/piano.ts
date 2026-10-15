import { asset } from "$app/paths";
import { SmplrPianoInstrument, StimulusPlayer, getAudioContextManager } from "@clavis/audio";
import type { StimulusSpec } from "@clavis/core";

/** A piano that plays on tap, for pages that make sound outside a session. */
export interface Piano {
  /** Call from a tap before the first sound (browsers keep audio locked until then). */
  unlock(): Promise<void>;
  /** One note now. */
  tone(midi: number): void;
  /** A short phrase now, stopping anything already sounding. */
  play(spec: StimulusSpec): void;
  stop(): void;
}

export function createPiano(): Piano {
  const audio = getAudioContextManager();
  const instrument = new SmplrPianoInstrument({
    getContext: () => audio.getContext() as unknown as BaseAudioContext,
    baseUrl: asset("samples/piano/manifest.json").replace(/\/manifest\.json$/, ""),
  });
  const player = new StimulusPlayer(
    {
      get currentTime(): number {
        return audio.getContext().currentTime;
      },
    },
    instrument,
  );
  const whenLoaded = (fn: () => void): void => {
    void player
      .load()
      .then(fn)
      .catch(() => undefined);
  };
  return {
    unlock: async () => {
      await audio.unlock();
    },
    tone(midi) {
      whenLoaded(() => {
        instrument.start({
          midi,
          time: audio.getContext().currentTime,
          duration: 0.8,
          velocity: 0.8,
        });
      });
    },
    play(spec) {
      whenLoaded(() => {
        player.stop();
        player.play(spec);
      });
    },
    stop() {
      player.stop();
    },
  };
}
