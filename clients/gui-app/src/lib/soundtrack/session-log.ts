import type { MixDirectorId } from "./directors";
import type { SoundtrackView } from "./signals";
import type { LayerRole } from "./variable-sound";

/**
 * What a sample is to the log: its layer's role, or the edge of the run it
 * plays at for an intro or an outro.
 */
export type LoggedRole = LayerRole | "intro" | "outro" | null;

/** Why a layer's gain moved. */
export type LayerGainCause =
  /** A director's plan: a gain, a layer switched, a state it chose. */
  | "director"
  /** A phase of the track moving its state. */
  | "phase"
  /** A start putting back the gains a stop or an outro took down. */
  | "restore"
  /** The layers fading out under the outro. */
  | "outro-fade";

/** Why a whole track's gain moved. */
export type TrackGainCause = "start" | "fade-out" | "stop";

/**
 * How a run ended: on its outro's end, with the last sample it rang out on, or
 * at the ring-out cap with something still sounding.
 */
export type RunEnding = "outro" | "rang-out" | "cap";

/** Why the music stopped where it was. */
export type PauseCause =
  /** The person's Pause, in this window or another. */
  | "person"
  /** The device would not start for a Play, so the music never went on. */
  | "refused-resume";

/** Why the music went on from a pause. */
export type PlayCause =
  /** The person's Play, in this window or another. */
  | "person"
  /** A Next or Previous, which plays. */
  | "skip";

export type SkipDirection = "next" | "previous";

/** Why a Next or Previous went where it did. */
export type SkipCause =
  /** Along the tracks the view has been on. */
  | "history"
  /** On to a track picked from the view's pool. */
  | "pick"
  /** Nowhere else to go, so back to the top of the track. */
  | "restart"
  /** Out of the silence, to the track the run's end picked. */
  | "silence";

/** A sample sounding, or due to, as a snapshot lists it. */
interface SoundingSample {
  readonly layer: string;
  readonly role: LoggedRole;
  readonly variant: number;
  readonly start: number;
  readonly end: number;
  readonly pan: number | null;
}

interface SoundingLayer {
  readonly layer: string;
  readonly role: LayerRole | null;
  readonly enabled: boolean;
  /** The gain it goes to while enabled. */
  readonly target: number;
}

/** What a player is sounding, and how its layers stand. */
export interface PlayerSnapshot {
  readonly track: string;
  /** Null in the silence after a run. */
  readonly state: string | null;
  /** Where the track has got to, in its own time. */
  readonly trackTime: number;
  readonly layers: readonly SoundingLayer[];
  readonly samples: readonly SoundingSample[];
}

/**
 * One thing the engine did, as it did it. Every time is on the audio clock in
 * seconds, under the keys `t` (when it was decided), `start` and `end`; the
 * recording writes them counted from its first audio frame. No event carries a
 * name or id of a person, an account, a chat or a task: signals are the five
 * values a director reads.
 *
 * A new kind of event is one more member here, with its times under those keys.
 */
export type SoundtrackLogEvent =
  | {
      readonly type: "run-start";
      readonly t: number;
      readonly track: string;
      readonly state: string;
    }
  | {
      readonly type: "run-end";
      readonly t: number;
      readonly track: string;
      readonly ending: RunEnding;
      /** What still sounded faded out over this long. */
      readonly fade: number;
      readonly silence: number;
    }
  | {
      readonly type: "sample";
      readonly t: number;
      readonly track: string;
      readonly layer: string;
      readonly role: LoggedRole;
      readonly variant: number;
      readonly start: number;
      readonly pan: number | null;
    }
  | {
      /** A stop cut the sample before it started: it was never heard. */
      readonly type: "sample-cancel";
      readonly t: number;
      readonly track: string;
      readonly layer: string;
      readonly variant: number;
      readonly start: number;
    }
  | {
      readonly type: "layer-gain";
      readonly t: number;
      readonly track: string;
      readonly layer: string;
      readonly target: number;
      readonly ramp: number;
      readonly cause: LayerGainCause;
    }
  | {
      readonly type: "track-gain";
      readonly t: number;
      readonly track: string;
      readonly target: number;
      readonly ramp: number;
      readonly cause: TrackGainCause;
    }
  | {
      readonly type: "state";
      readonly t: number;
      readonly track: string;
      readonly state: string;
      readonly cause: "director" | "phase";
    }
  | {
      readonly type: "signals";
      readonly t: number;
      readonly view: SoundtrackView;
      readonly working: number;
      readonly blocking: number;
      readonly failure: number;
      readonly done: number;
    }
  | {
      readonly type: "plan";
      readonly t: number;
      readonly view: SoundtrackView;
      readonly track: string;
      readonly state: string | null;
      readonly layerCount: number | null;
      readonly heldLayers: readonly string[];
      readonly pauseMultiplier: number;
      /** By layer name. */
      readonly layerGains: Readonly<Record<string, number>>;
      readonly dim: boolean;
    }
  | {
      readonly type: "director";
      readonly t: number;
      readonly director: MixDirectorId;
    }
  | {
      /**
       * What is sounding as a recording starts, so that its first minute
       * reads; null while the view in front has no track.
       */
      readonly type: "sounding";
      readonly t: number;
      readonly view: SoundtrackView | null;
      /** Whether the session is held, so that no audio follows until a Play. */
      readonly paused: boolean;
      readonly player: PlayerSnapshot | null;
    }
  | {
      readonly type: "pause";
      readonly t: number;
      readonly cause: PauseCause;
    }
  | {
      readonly type: "play";
      readonly t: number;
      readonly cause: PlayCause;
    }
  | {
      /** A Next or Previous, ahead of the moves it makes. */
      readonly type: "skip";
      readonly t: number;
      readonly direction: SkipDirection;
      /** The track it goes to, which a restart leaves the same. */
      readonly to: string;
      readonly cause: SkipCause;
    };

/** The keys whose values are audio clock times. */
export const LOG_CLOCK_KEYS: ReadonlySet<string> = new Set([
  "t",
  "start",
  "end",
]);

/**
 * Where the engine says what it does. Ask `listening()` before building an
 * event, so a session nothing records allocates nothing for it.
 */
export interface SoundtrackLog {
  listening(): boolean;
  write(event: SoundtrackLogEvent): void;
}

/**
 * The log a session's ports carry for as long as it lasts: silent until a
 * recording listens, and silent again when it stops.
 */
export class SoundtrackLogRelay implements SoundtrackLog {
  private listener: ((event: SoundtrackLogEvent) => void) | null = null;

  listening(): boolean {
    return this.listener !== null;
  }

  write(event: SoundtrackLogEvent): void {
    this.listener?.(event);
  }

  /** One listener at a time; a second replaces the first. */
  listen(listener: (event: SoundtrackLogEvent) => void): void {
    this.listener = listener;
  }

  /** Lets go of `listener`, if it is still the one listening. */
  unlisten(listener: (event: SoundtrackLogEvent) => void): void {
    if (this.listener === listener) this.listener = null;
  }
}
