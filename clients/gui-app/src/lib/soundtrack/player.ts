import { appLogger, describeLogError } from "@/lib/logger";
import type { OutputGain, OutputVoice, SoundtrackOutput } from "./output";
import {
  drawSeconds,
  TrackScheduler,
  type RandomSource,
  type ScheduledPlay,
} from "./scheduler";
import type { StemSource } from "./stems";
import type { Range, State, VariableTrack } from "./variable-sound";

const LOOKAHEAD_INTERVAL_MS = 120;
const LOOKAHEAD_HORIZON_SECONDS = 0.6;
// A sample on the very first tick still gets its fade in ahead of it.
const START_LEAD_SECONDS = 0.05;
const SAMPLE_FADE_SECONDS = 0.01;
const LAYER_RAMP_SECONDS = 1.5;
const CROSSFADE_SECONDS = 2;

export interface TrackPlayerOptions {
  readonly track: VariableTrack;
  readonly output: SoundtrackOutput;
  readonly stems: StemSource;
  readonly random: RandomSource;
  /** How long the silence between two plays of the track lasts. */
  readonly silenceSeconds: Range;
}

interface PlayingPhase {
  readonly kind: "playing";
  readonly scheduler: TrackScheduler;
  /** Clock time of track time 0. */
  readonly trackStart: number;
  /** The position this run began at, which holds through the start lead. */
  readonly fromElapsed: number;
}

type PlayerPhase =
  | { readonly kind: "stopped" }
  /** The silence after the track's end, before a fresh state starts it again. */
  | { readonly kind: "silence"; readonly endsAt: number }
  | PlayingPhase;

interface ActiveVoice {
  readonly voice: OutputVoice;
  readonly endsAt: number;
}

/**
 * Plays one track, for one view. Stopping remembers the position, and `elapsed`
 * answers it while stopped, so a view resumes with `start(player.elapsed(), …)`.
 * The state and its enabled layers are kept across a stop; the track's end
 * discards them and a fresh state is rolled after the silence.
 */
export class TrackPlayer {
  private readonly track: VariableTrack;
  private readonly output: SoundtrackOutput;
  private readonly stems: StemSource;
  private readonly random: RandomSource;
  private readonly silenceSeconds: Range;
  private readonly bus: OutputGain;
  private readonly layerGains: readonly OutputGain[];
  private readonly layerTargets: number[];
  private readonly reportedMissing = new Set<string>();
  private phase: PlayerPhase = { kind: "stopped" };
  private scheduler: TrackScheduler | null = null;
  /** Taken instead of a random roll when the next play begins. */
  private chosenState: State | null = null;
  private pauseMultiplier = 1;
  private position = 0;
  private voices: ActiveVoice[] = [];
  private timer: number | null = null;
  private fadeOutEndsAt: number | null = null;

  constructor(options: TrackPlayerOptions) {
    this.track = options.track;
    this.output = options.output;
    this.stems = options.stems;
    this.random = options.random;
    this.silenceSeconds = options.silenceSeconds;
    this.bus = options.output.createBus(0);
    this.layerGains = options.track.layers.map(() => this.bus.createChild(0));
    this.layerTargets = options.track.layers.map(() => 1);
  }

  /**
   * Plays from `fromElapsed`, the player's gain rising over `fadeInSeconds`. On
   * a player already running, including one fading out or in its silence, it
   * only takes the fade back up and keeps its place.
   */
  start(fromElapsed: number, fadeInSeconds: number): void {
    this.fadeOutEndsAt = null;
    this.bus.ramp(1, fadeInSeconds);
    if (this.phase.kind !== "stopped") return;
    this.beginRun(fromElapsed, this.output.currentTime());
    this.timer = window.setInterval(() => {
      this.tick();
    }, LOOKAHEAD_INTERVAL_MS);
    this.tick();
  }

  /**
   * Cuts every sample over `fadeSeconds` and remembers the position. Every cut
   * takes at least the 10 ms fade, whatever the caller asks, so none clicks.
   */
  stop(fadeSeconds: number): void {
    if (this.phase.kind === "stopped") return;
    const fade = Math.max(fadeSeconds, SAMPLE_FADE_SECONDS);
    this.position = this.elapsed();
    this.phase = { kind: "stopped" };
    this.fadeOutEndsAt = null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.cutVoices(fade);
    this.bus.ramp(0, fade);
  }

  /**
   * Takes the player's gain down over `seconds`, then stops it. It keeps
   * playing under the fade, and `start` called meanwhile takes it back up.
   */
  fadeOut(seconds: number): void {
    if (this.phase.kind === "stopped") return;
    this.bus.ramp(0, seconds);
    this.fadeOutEndsAt = this.output.currentTime() + seconds;
  }

  /** Track time now; while not playing, where the next start would resume. */
  elapsed(): number {
    if (this.phase.kind !== "playing") return this.position;
    return Math.max(
      this.phase.fromElapsed,
      this.output.currentTime() - this.phase.trackStart,
    );
  }

  /**
   * The state in force now, and never one still on its way: a move counts from
   * the tick it lands on. Null before the first play and in the silence.
   */
  currentState(): State | null {
    return this.scheduler === null
      ? null
      : this.scheduler.stateAt(this.elapsed());
  }

  /**
   * Chooses the state by name, for one play: the track's end rolls at random
   * again. While playing, the move lands on the next grid tick and cuts nothing.
   * Enabled layers are rolled and their gains ramp at once, so call
   * `setLayerEnabled` after this, not before. Otherwise the next play takes it,
   * which is the next start or the end of the silence. Choosing the state already
   * in force changes nothing, so a plan can restate it freely.
   */
  enterState(name: string): void {
    const state = this.track.states.find(
      (candidate) => candidate.name === name,
    );
    if (state === undefined) {
      throw new Error(`Track "${this.track.name}" has no state "${name}"`);
    }
    if (this.scheduler?.decidingState() === state) {
      this.chosenState = null;
      return;
    }
    if (this.phase.kind !== "playing") {
      this.chosenState = state;
      return;
    }
    this.phase.scheduler.enterState(state, this.elapsed());
    this.layerGains.forEach((_, layerIndex) => {
      this.applyLayerGain(layerIndex, LAYER_RAMP_SECONDS);
    });
  }

  /** Per layer; empty when there is no state. */
  enabledLayers(): readonly boolean[] {
    return this.scheduler === null ? [] : this.scheduler.enabledLayers();
  }

  /**
   * Overrides what the state rolled, for the rest of this play: the layer takes
   * the next grid tick and its gain ramps. No effect when there is no state.
   */
  setLayerEnabled(layerIndex: number, enabled: boolean): void {
    if (this.scheduler === null) return;
    this.scheduler.setLayerEnabled(layerIndex, enabled);
    this.applyLayerGain(layerIndex, LAYER_RAMP_SECONDS);
  }

  /** The gain an enabled layer ramps to; it stands across states. */
  setLayerTarget(layerIndex: number, target: number): void {
    this.layerTargets[layerIndex] = target;
    if (this.scheduler !== null) {
      this.applyLayerGain(layerIndex, LAYER_RAMP_SECONDS);
    }
  }

  /** Scales the pauses drawn from here on; it stands across states. */
  setPauseMultiplier(multiplier: number): void {
    this.pauseMultiplier = multiplier;
    this.scheduler?.setPauseMultiplier(multiplier);
  }

  private tick(): void {
    const now = this.output.currentTime();
    if (this.fadeOutEndsAt !== null && now >= this.fadeOutEndsAt) {
      this.stop(SAMPLE_FADE_SECONDS);
      return;
    }
    if (this.phase.kind === "silence" && now >= this.phase.endsAt) {
      this.beginRun(0, now);
    }
    if (this.phase.kind === "playing") this.lookAhead(this.phase, now);
  }

  private beginRun(fromElapsed: number, now: number): void {
    const scheduler =
      this.chosenState === null && this.scheduler !== null
        ? this.scheduler
        : this.rollScheduler();
    scheduler.restartAt(fromElapsed);
    this.scheduler = scheduler;
    this.phase = {
      kind: "playing",
      scheduler,
      trackStart: now - fromElapsed + START_LEAD_SECONDS,
      fromElapsed,
    };
    this.layerGains.forEach((_, layerIndex) => {
      this.applyLayerGain(layerIndex, SAMPLE_FADE_SECONDS);
    });
  }

  private rollScheduler(): TrackScheduler {
    const { states } = this.track;
    const state =
      this.chosenState ?? states[Math.floor(this.random() * states.length)];
    this.chosenState = null;
    return new TrackScheduler({
      track: this.track,
      state,
      random: this.random,
      pauseMultiplier: this.pauseMultiplier,
    });
  }

  private lookAhead(phase: PlayingPhase, now: number): void {
    const trackTime = now - phase.trackStart;
    if (trackTime >= this.track.lengthSeconds) {
      this.endTrack(now);
      return;
    }
    this.voices = this.voices.filter((active) => active.endsAt > now);
    const plays = phase.scheduler.advance(
      trackTime + LOOKAHEAD_HORIZON_SECONDS,
    );
    for (const play of plays) void this.place(phase, play);
  }

  private endTrack(now: number): void {
    this.cutVoices(SAMPLE_FADE_SECONDS);
    this.scheduler = null;
    this.position = 0;
    this.phase = {
      kind: "silence",
      endsAt: now + drawSeconds(this.silenceSeconds, this.random),
    };
  }

  /**
   * Each play waits for its own audio, so a slow decode holds back only its
   * sublayer. A run that ended meanwhile drops what arrives for it.
   */
  private async place(phase: PlayingPhase, play: ScheduledPlay): Promise<void> {
    const layer = this.track.layers[play.layerIndex];
    try {
      const buffer = await this.stems.load(this.track, layer, play.variant);
      if (this.phase !== phase) return;
      const startAt = phase.scheduler.confirm(
        play,
        buffer.duration,
        this.output.currentTime() - phase.trackStart,
      );
      if (startAt === null) return;
      const when = phase.trackStart + startAt;
      this.voices.push({
        voice: this.layerGains[play.layerIndex].play(
          buffer,
          when,
          SAMPLE_FADE_SECONDS,
        ),
        endsAt: when + buffer.duration,
      });
    } catch (error) {
      if (this.phase !== phase) return;
      this.reportMissing(layer.name, play.variant, error);
      phase.scheduler.skip(play);
    }
  }

  // Once per sample: a missing stem comes up again at every turn of its layer,
  // every few seconds for as long as the track plays.
  private reportMissing(
    layerName: string,
    variant: number,
    error: unknown,
  ): void {
    const key = `${layerName}/${String(variant)}`;
    if (this.reportedMissing.has(key)) return;
    this.reportedMissing.add(key);
    appLogger.warn("[soundtrack] skipping a sample that would not load", {
      track: this.track.name,
      layer: layerName,
      variant,
      error: describeLogError(error),
    });
  }

  private cutVoices(fadeSeconds: number): void {
    for (const { voice } of this.voices) voice.cut(fadeSeconds);
    this.voices = [];
  }

  private applyLayerGain(layerIndex: number, seconds: number): void {
    const enabled = this.enabledLayers()[layerIndex];
    this.layerGains[layerIndex].ramp(
      enabled ? this.layerTargets[layerIndex] : 0,
      seconds,
    );
  }
}

/**
 * A view switch: `from` fades out and stops, `to` fades in from where it left
 * off. Reversing it midway takes each player back from wherever its gain is.
 */
export function crossfadePlayers(from: TrackPlayer, to: TrackPlayer): void {
  if (from !== to) from.fadeOut(CROSSFADE_SECONDS);
  to.start(to.elapsed(), CROSSFADE_SECONDS);
}
