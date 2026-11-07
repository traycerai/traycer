import { appLogger, describeLogError } from "@/lib/logger";
import { MIX_TUNING } from "./mix-tuning";
import type { OutputGain, OutputVoice, SoundtrackOutput } from "./output";
import {
  drawSeconds,
  snapUp,
  TrackScheduler,
  type RandomSource,
  type ScheduledPlay,
} from "./scheduler";
import type {
  LayerGainCause,
  LoggedRole,
  PlayerSnapshot,
  RunEnding,
  SoundtrackLog,
  TrackGainCause,
} from "./session-log";
import type { StemSource } from "./stems";
import { spanOf } from "./variant-groups";
import type {
  Bookend,
  Layer,
  PooledLayer,
  Range,
  State,
  VariableTrack,
} from "./variable-sound";

const LOOKAHEAD_INTERVAL_MS = 120;
const LOOKAHEAD_HORIZON_SECONDS = 0.6;
// A sample on the very first tick still gets its fade in ahead of it.
const START_LEAD_SECONDS = 0.05;
const SAMPLE_FADE_SECONDS = 0.01;
const LAYER_RAMP_SECONDS = 1.5;
// Two ramps whose ends are this close end together.
const RAMP_END_TOLERANCE_SECONDS = 1e-6;
export const CROSSFADE_SECONDS = 2;

export interface TrackPlayerOptions {
  readonly track: VariableTrack;
  readonly output: SoundtrackOutput;
  readonly stems: StemSource;
  readonly random: RandomSource;
  /** Told what the player does, while anything listens. */
  readonly log: SoundtrackLog;
  /** How long the silence between two plays of the track lasts. */
  readonly silenceSeconds: Range;
  /** What `elapsed` answers until the first start; 0 for a track from its top. */
  readonly resumeAt: number;
  /**
   * Once per run, with the state it opens in: after the roll and before its
   * first grid tick, so what is set from here lands on that tick. A start that
   * resumes a run, or opens partway into the track, is not a run's start.
   */
  readonly onRunStart: (state: State) => void;
  /**
   * Once per run, as its silence begins; the next run starts when the silence
   * is over unless the player is stopped meanwhile.
   */
  readonly onRunEnd: (silenceSeconds: number) => void;
}

/** A phase of the track with its time drawn, for one run. */
interface TimedPhase {
  readonly at: number;
  readonly state: State;
  readonly fadeSeconds: number;
}

/** One run of the track, from its start to its end; a stop and start keep it. */
interface RunArc {
  /** The phases still to come, soonest first. */
  phases: readonly TimedPhase[];
  /** Track time the layers start from, after the intro; null until known. */
  gridFrom: number | null;
}

interface PlayingPhase {
  readonly kind: "playing";
  readonly scheduler: TrackScheduler;
  readonly run: RunArc;
  /** Clock time of track time 0. */
  readonly trackStart: number;
  /** The position this start began at, which holds through the start lead. */
  readonly fromElapsed: number;
  /** Whether this start has asked for the outro yet. */
  outroAsked: boolean;
  /**
   * Clock time the outro ends, and the run with it; null until placed. From
   * then on the layers' gains are the outro's fade.
   */
  outroEndsAt: number | null;
  /**
   * Clock time a run that rings out past the track's length ends at the
   * latest: the cap past the length for a track with no outro, past the later
   * of the length and the failure for one whose outro would not load. Null
   * while the run is to end on its outro.
   */
  ringOutCapAt: number | null;
  /** The plays the scheduler counted since this start, played or skipped. */
  readonly placed: PlacedPlay[];
}

/** A play the scheduler counted, at the track time it starts. */
interface PlacedPlay {
  readonly play: ScheduledPlay;
  readonly startAt: number;
}

type PlayerPhase =
  | { readonly kind: "stopped" }
  /** The silence after the track's end, before a fresh state starts it again. */
  | { readonly kind: "silence"; readonly endsAt: number }
  | PlayingPhase;

/** Where a sample plays, and what the log calls it. */
interface VoiceSound {
  readonly gain: OutputGain;
  /** The layer it plays on; null for an intro or outro. */
  readonly layerIndex: number | null;
  /** The layer the stems know it by, an intro's or outro's included. */
  readonly layer: Layer;
  readonly role: LoggedRole;
}

interface ActiveVoice {
  readonly voice: OutputVoice;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly sound: VoiceSound;
  readonly variant: number;
}

/** A sample on a layer that a stop or a run's end is fading out. */
interface FadingVoice {
  readonly voice: OutputVoice;
  readonly layerIndex: number;
  /** Clock time its fade has taken it to silence. */
  readonly silentAt: number;
}

/** An intro or outro, as a layer the stems know by its name, and its gain. */
interface BookendChannel extends VoiceSound {
  readonly layer: PooledLayer;
  readonly layerIndex: null;
  readonly role: "intro" | "outro";
}

/** A layer's last gain ramp, so that restating its target can tell. */
interface LayerRamp {
  readonly target: number;
  readonly endsAt: number;
}

function bookendChannel(
  bus: OutputGain,
  bookend: Bookend | null,
  role: "intro" | "outro",
): BookendChannel | null {
  if (bookend === null) return null;
  return {
    role,
    layerIndex: null,
    layer: {
      name: bookend.name,
      role: null,
      variants: bookend.variants,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: bookend.pan,
    },
    gain: bus.createChild(1, bookend.pan),
  };
}

/**
 * Plays one track. Stopping remembers the position, and `elapsed` answers it
 * while stopped, so a view resumes with `start(player.elapsed(), …)`.
 * The state and its enabled layers are kept across a stop; the track's end
 * discards them and a fresh state is rolled after the silence. A run is shaped
 * by the track's intro, phases and outro, as `VariableTrack` describes them.
 */
export class TrackPlayer {
  private readonly track: VariableTrack;
  private readonly output: SoundtrackOutput;
  private readonly stems: StemSource;
  private readonly random: RandomSource;
  private readonly log: SoundtrackLog;
  private readonly silenceSeconds: Range;
  private readonly onRunStart: (state: State) => void;
  private readonly onRunEnd: (silenceSeconds: number) => void;
  private readonly bus: OutputGain;
  private readonly layerGains: readonly OutputGain[];
  /** By layer, built once so that placing a sample allocates no more. */
  private readonly layerSounds: readonly VoiceSound[];
  private readonly layerTargets: number[];
  private readonly layerRamps: (LayerRamp | null)[];
  private readonly intro: BookendChannel | null;
  private readonly outro: BookendChannel | null;
  private readonly phases: readonly {
    readonly afterSeconds: Range;
    readonly state: State;
    readonly fadeSeconds: number;
  }[];
  private readonly reportedMissing = new Set<string>();
  private phase: PlayerPhase = { kind: "stopped" };
  private scheduler: TrackScheduler | null = null;
  private run: RunArc | null = null;
  /** Taken instead of a random roll when the next play begins. */
  private chosenState: State | null = null;
  private pauseMultiplier = 1;
  private position: number;
  private voices: ActiveVoice[] = [];
  /** What the last cut is still fading, which a layer's gain must not raise. */
  private fading: FadingVoice[] = [];
  private timer: number | null = null;
  private fadeOutEndsAt: number | null = null;

  constructor(options: TrackPlayerOptions) {
    this.track = options.track;
    this.output = options.output;
    this.stems = options.stems;
    this.random = options.random;
    this.log = options.log;
    this.silenceSeconds = options.silenceSeconds;
    this.onRunStart = options.onRunStart;
    this.onRunEnd = options.onRunEnd;
    this.position = options.resumeAt;
    this.bus = options.output.createBus(0);
    this.layerGains = options.track.layers.map((layer) =>
      this.bus.createChild(0, layer.pan),
    );
    this.layerSounds = options.track.layers.map((layer, layerIndex) => ({
      gain: this.layerGains[layerIndex],
      layerIndex,
      layer,
      role: layer.role,
    }));
    this.layerTargets = options.track.layers.map(() => 1);
    this.layerRamps = options.track.layers.map(() => null);
    this.intro = bookendChannel(this.bus, options.track.intro, "intro");
    this.outro = bookendChannel(this.bus, options.track.outro, "outro");
    this.phases = options.track.phases.map((phase) => ({
      ...phase,
      state: this.stateNamed(phase.state),
    }));
  }

  /**
   * Plays from `fromElapsed`, the player's gain rising over `fadeInSeconds`. On
   * a player already running, including one fading out or in its silence, it
   * only takes the fade back up and keeps its place.
   */
  start(fromElapsed: number, fadeInSeconds: number): void {
    this.fadeOutEndsAt = null;
    this.rampBus(1, fadeInSeconds, "start");
    if (this.phase.kind !== "stopped") return;
    this.beginRun(fromElapsed, this.output.currentTime());
    this.timer = window.setInterval(() => {
      this.tick();
    }, LOOKAHEAD_INTERVAL_MS);
    this.tick();
  }

  /**
   * Cuts every sample over `fadeSeconds` and remembers the position. Every cut
   * takes at least the 10 ms fade, whatever the caller asks, so none clicks. A
   * sample cut before it started has not been played, and the run still owes
   * it; one that started has, wherever the next start resumes.
   */
  stop(fadeSeconds: number): void {
    if (this.phase.kind === "stopped") return;
    const fade = Math.max(fadeSeconds, SAMPLE_FADE_SECONDS);
    const position = this.elapsed();
    this.position = position;
    if (this.phase.kind === "playing") {
      this.phase.scheduler.takeBack(
        this.phase.placed
          .filter((placed) => placed.startAt >= position)
          .map((placed) => placed.play),
      );
      this.logCancelled();
      // A phase due since the last tick belongs to the run a resume goes on with.
      this.takePhasesDue(this.phase, position);
    }
    this.phase = { kind: "stopped" };
    this.fadeOutEndsAt = null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.cutVoices(fade);
    this.rampBus(0, fade, "stop");
  }

  /**
   * Stops the player as `stop` does and forgets the run it was in, so the next
   * start opens a fresh run from the track's top.
   */
  rewind(fadeSeconds: number): void {
    this.stop(fadeSeconds);
    this.scheduler = null;
    this.run = null;
    this.position = 0;
  }

  /**
   * Takes the player's gain down over `seconds`, then stops it. It keeps
   * playing under the fade, and `start` called meanwhile takes it back up.
   */
  fadeOut(seconds: number): void {
    if (this.phase.kind === "stopped") return;
    this.rampBus(0, seconds, "fade-out");
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
   * which is the next start, going on with the same run and what it has played,
   * or the end of the silence. While the intro sounds, the layers still wait for
   * its end. Choosing the state already
   * in force changes nothing, so a plan can restate it freely. A phase of the
   * track moves the state the same way, its gains taking the phase's fade.
   */
  enterState(name: string): void {
    const state = this.stateNamed(name);
    if (this.scheduler?.decidingState() === state) {
      this.chosenState = null;
      return;
    }
    if (this.phase.kind !== "playing") {
      this.chosenState = state;
      return;
    }
    this.moveTo(this.phase.scheduler, state, LAYER_RAMP_SECONDS, "director");
  }

  /** Per layer; empty when there is no state. */
  enabledLayers(): readonly boolean[] {
    return this.scheduler === null ? [] : this.scheduler.enabledLayers();
  }

  /**
   * Per layer, whether the state fixes it on or off, which `setLayerEnabled`
   * cannot change; empty when there is no state.
   */
  fixedLayers(): readonly boolean[] {
    return this.scheduler === null
      ? []
      : this.scheduler
          .decidingState()
          .layersProperties.map((properties) => properties.enabled !== null);
  }

  /**
   * Overrides what the state rolled, for the rest of this play: the layer takes
   * the next grid tick and its gain ramps. No effect when there is no state, or
   * on a layer the state fixes the other way.
   */
  setLayerEnabled(layerIndex: number, enabled: boolean): void {
    if (this.scheduler === null) return;
    this.scheduler.setLayerEnabled(layerIndex, enabled);
    if (this.scheduler.enabledLayers()[layerIndex] !== enabled) return;
    this.applyLayerGain(layerIndex, LAYER_RAMP_SECONDS, "director");
  }

  /**
   * The gain an enabled layer ramps to; it stands across states. Restating the
   * target it has changes nothing, so a plan can restate it freely.
   */
  setLayerTarget(layerIndex: number, target: number): void {
    if (this.layerTargets[layerIndex] === target) return;
    this.layerTargets[layerIndex] = target;
    if (this.scheduler !== null) {
      this.applyLayerGain(layerIndex, LAYER_RAMP_SECONDS, "director");
    }
  }

  /** Scales the pauses drawn from here on; it stands across states. */
  setPauseMultiplier(multiplier: number): void {
    this.pauseMultiplier = multiplier;
    this.scheduler?.setPauseMultiplier(multiplier);
  }

  /** What it sounds now and has placed to come, and how its layers stand. */
  describe(): PlayerSnapshot {
    const now = this.output.currentTime();
    const enabled = this.enabledLayers();
    return {
      track: this.track.name,
      state: this.currentState()?.name ?? null,
      trackTime: this.elapsed(),
      layers: this.track.layers.map((layer, layerIndex) => ({
        layer: layer.name,
        role: layer.role,
        enabled: enabled.at(layerIndex) ?? false,
        target: this.layerTargets[layerIndex],
      })),
      samples: this.voices
        .filter((active) => active.endsAt > now)
        .map((active) => ({
          layer: active.sound.layer.name,
          role: active.sound.role,
          variant: active.variant,
          start: active.startsAt,
          end: active.endsAt,
          pan: active.sound.layer.pan,
        })),
    };
  }

  private stateNamed(name: string): State {
    const state = this.track.states.find(
      (candidate) => candidate.name === name,
    );
    if (state === undefined) {
      throw new Error(`Track "${this.track.name}" has no state "${name}"`);
    }
    return state;
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
    if (
      this.phase.kind === "playing" &&
      this.phase.outroEndsAt !== null &&
      now >= this.phase.outroEndsAt
    ) {
      this.voices = this.voices.filter((active) => active.endsAt > now);
      this.endRun(now, MIX_TUNING.outroRingOutSeconds, "outro");
    }
    if (this.phase.kind === "playing") this.lookAhead(this.phase, now);
  }

  private beginRun(fromElapsed: number, now: number): void {
    const runStarts = this.run === null && fromElapsed === 0;
    let opening: State | null = null;
    if (this.run === null) {
      const drawn = this.phases
        .map((phase) => ({
          at: drawSeconds(phase.afterSeconds, this.random),
          state: phase.state,
          fadeSeconds: phase.fadeSeconds,
        }))
        .toSorted((a, b) => a.at - b.at);
      const passed = drawn.filter((phase) => phase.at < fromElapsed);
      if (drawn.length > 0) {
        opening = passed.at(-1)?.state ?? this.track.states[0];
      }
      this.run = {
        phases: drawn.filter((phase) => phase.at >= fromElapsed),
        gridFrom: this.intro !== null && fromElapsed === 0 ? null : fromElapsed,
      };
    }
    const { run } = this;
    const scheduler = this.scheduler ?? this.rollScheduler(opening);
    // A state chosen while stopped moves the run on, keeping what it has played.
    if (this.chosenState !== null) {
      scheduler.enterState(this.chosenState, fromElapsed);
      this.logState(this.chosenState, "director");
      this.chosenState = null;
    }
    scheduler.restartAt(fromElapsed);
    this.scheduler = scheduler;
    // Ahead of the gains it restores, so the log reads in the order heard.
    this.logRunStart(runStarts, now, scheduler.decidingState());
    // Due on a run's start, or again when a stop cut it short.
    const introDue =
      this.intro !== null &&
      (run.gridFrom === null || fromElapsed < run.gridFrom);
    if (introDue) run.gridFrom = null;
    const trackStart = now - fromElapsed + START_LEAD_SECONDS;
    const phase: PlayingPhase = {
      kind: "playing",
      scheduler,
      run,
      trackStart,
      fromElapsed,
      outroAsked: false,
      outroEndsAt: null,
      // Counted from the length, so a tick that comes late does not move it.
      ringOutCapAt:
        this.outro === null
          ? trackStart + this.track.lengthSeconds + MIX_TUNING.ringOutCapSeconds
          : null,
      placed: [],
    };
    this.phase = phase;
    this.layerGains.forEach((_, layerIndex) => {
      this.applyLayerGain(layerIndex, SAMPLE_FADE_SECONDS, "restore");
    });
    if (introDue) void this.placeIntro(phase, this.intro);
    // Last, so the gains it moves are not set back by the ones above.
    if (runStarts) this.onRunStart(scheduler.decidingState());
  }

  /** The chosen state, else the one a run of a phased track opens in, else any. */
  private rollScheduler(opening: State | null): TrackScheduler {
    const { states } = this.track;
    const state =
      this.chosenState ??
      opening ??
      states[Math.floor(this.random() * states.length)];
    this.chosenState = null;
    return new TrackScheduler({
      track: this.track,
      state,
      random: this.random,
      pauseMultiplier: this.pauseMultiplier,
    });
  }

  private moveTo(
    scheduler: TrackScheduler,
    state: State,
    rampSeconds: number,
    cause: "director" | "phase",
  ): void {
    scheduler.enterState(state, this.elapsed());
    this.logState(state, cause);
    this.layerGains.forEach((_, layerIndex) => {
      this.applyLayerGain(layerIndex, rampSeconds, cause);
    });
  }

  /** Phases wait for the intro's end, so the layers never start inside it. */
  private takePhasesDue(phase: PlayingPhase, trackTime: number): void {
    const { run } = phase;
    if (run.gridFrom === null || trackTime < run.gridFrom) return;
    while (run.phases.length > 0 && run.phases[0].at <= trackTime) {
      const [due, ...rest] = run.phases;
      run.phases = rest;
      if (phase.scheduler.decidingState() !== due.state) {
        this.moveTo(phase.scheduler, due.state, due.fadeSeconds, "phase");
      }
    }
  }

  private lookAhead(phase: PlayingPhase, now: number): void {
    const trackTime = now - phase.trackStart;
    const { lengthSeconds, alignmentSeconds } = this.track;
    this.voices = this.voices.filter((active) => active.endsAt > now);
    if (phase.ringOutCapAt !== null && trackTime >= lengthSeconds) {
      this.ringOut(phase.ringOutCapAt, now);
      return;
    }
    if (
      this.outro !== null &&
      !phase.outroAsked &&
      trackTime + LOOKAHEAD_HORIZON_SECONDS >=
        snapUp(lengthSeconds, alignmentSeconds)
    ) {
      phase.outroAsked = true;
      void this.placeOutro(phase, this.outro);
    }
    if (phase.run.gridFrom === null) return;
    this.takePhasesDue(phase, trackTime);
    const plays = phase.scheduler.advance(
      trackTime + LOOKAHEAD_HORIZON_SECONDS,
    );
    for (const play of plays) void this.place(phase, play);
  }

  /**
   * Past the track's length nothing new starts: the samples sounding play on to
   * their own ends, and the run ends with the last one heard, or at the cap,
   * fading what still sounds. One on a layer switched off is not heard, so it
   * holds nothing up.
   */
  private ringOut(capAt: number, now: number): void {
    const heard = this.voices.some(
      (active) =>
        active.sound.layerIndex === null ||
        this.layerLevel(active.sound.layerIndex) > 0,
    );
    if (heard && now < capAt) return;
    this.endRun(now, MIX_TUNING.ringOutFadeSeconds, heard ? "cap" : "rang-out");
  }

  /** The run is over: what still sounds fades out, and the silence begins. */
  private endRun(now: number, fadeSeconds: number, ending: RunEnding): void {
    this.cutVoices(fadeSeconds);
    this.scheduler = null;
    this.run = null;
    this.position = 0;
    const silenceSeconds = drawSeconds(this.silenceSeconds, this.random);
    this.phase = { kind: "silence", endsAt: now + silenceSeconds };
    if (this.log.listening()) {
      this.log.write({
        type: "run-end",
        t: now,
        track: this.track.name,
        ending,
        fade: fadeSeconds,
        silence: silenceSeconds,
      });
    }
    // Last, so the owner may stop the player from it.
    this.onRunEnd(silenceSeconds);
  }

  /**
   * Each play waits for its own audio, so a slow decode holds back its sublayer,
   * and on a layer of two variants the layer's other sublayers too: a pending
   * play can leave them nothing to draw until it reports. A run that ended
   * meanwhile drops what arrives for it. A report frees the sublayer, so it looks
   * ahead again at once: on a fine grid its next sample may fall inside this
   * window, and waiting for the timer would miss it.
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
      if (startAt !== null) {
        phase.placed.push({ play, startAt });
        this.startVoice(
          this.layerSounds[play.layerIndex],
          play.variant,
          buffer,
          phase.trackStart + startAt,
        );
      }
    } catch (error) {
      if (this.phase !== phase) return;
      this.reportMissing(layer, play.variant, error);
      phase.scheduler.skip(play);
      phase.placed.push({ play, startAt: play.startAt });
    }
    this.lookAhead(phase, this.output.currentTime());
  }

  /**
   * The intro takes the first tick it can, and the layers start from its end;
   * one that will not load leaves them to start from where the run has got to.
   * Like a layer's sample, one whose tick is at or past the track's length does
   * not start at all.
   */
  private async placeIntro(
    phase: PlayingPhase,
    intro: BookendChannel,
  ): Promise<void> {
    const variant = this.bookendVariant(intro);
    let gridFrom: number;
    try {
      const buffer = await this.stems.load(this.track, intro.layer, variant);
      if (this.phase !== phase) return;
      const startAt = this.bookendStartAt(phase, phase.fromElapsed);
      gridFrom = startAt;
      if (startAt < this.track.lengthSeconds) {
        this.startVoice(intro, variant, buffer, phase.trackStart + startAt);
        gridFrom += buffer.duration;
      }
    } catch (error) {
      if (this.phase !== phase) return;
      this.reportMissing(intro.layer, variant, error);
      gridFrom = Math.max(
        phase.fromElapsed,
        this.output.currentTime() - phase.trackStart,
      );
    }
    phase.run.gridFrom = gridFrom;
    phase.scheduler.restartAt(gridFrom);
    this.lookAhead(phase, this.output.currentTime());
  }

  /**
   * The outro takes the first tick at or after the track's length that it can,
   * the layers fade out under it, and the run ends with it. A run whose outro
   * will not load rings out from the later of now and the track's length.
   */
  private async placeOutro(
    phase: PlayingPhase,
    outro: BookendChannel,
  ): Promise<void> {
    const variant = this.bookendVariant(outro);
    try {
      const buffer = await this.stems.load(this.track, outro.layer, variant);
      if (this.phase !== phase) return;
      const when =
        phase.trackStart + this.bookendStartAt(phase, this.track.lengthSeconds);
      this.startVoice(outro, variant, buffer, when);
      phase.outroEndsAt = when + buffer.duration;
      this.fadeLayersOut(phase.outroEndsAt);
    } catch (error) {
      if (this.phase !== phase) return;
      this.reportMissing(outro.layer, variant, error);
      phase.ringOutCapAt =
        Math.max(
          this.output.currentTime(),
          phase.trackStart + this.track.lengthSeconds,
        ) + MIX_TUNING.ringOutCapSeconds;
    }
  }

  /**
   * Every layer's gain down to 0 by `endsAt`, from now: a ramp, so the samples
   * ringing on are faded and not cut. Placed at most a grid tick ahead of the
   * outro, so it takes the outro's length, near enough.
   */
  private fadeLayersOut(endsAt: number): void {
    const seconds = endsAt - this.output.currentTime();
    this.layerGains.forEach((gain, layerIndex) => {
      gain.ramp(0, seconds);
      this.logLayerGain(layerIndex, 0, seconds, "outro-fade");
      this.layerRamps[layerIndex] = { target: 0, endsAt };
    });
  }

  private bookendVariant(bookend: BookendChannel): number {
    const { variants } = bookend.layer;
    return variants === 1 ? 1 : 1 + Math.floor(this.random() * variants);
  }

  /** The grid tick at or after `notBefore` that has not gone by. */
  private bookendStartAt(phase: PlayingPhase, notBefore: number): number {
    return snapUp(
      Math.max(notBefore, this.output.currentTime() - phase.trackStart),
      this.track.alignmentSeconds,
    );
  }

  private startVoice(
    sound: VoiceSound,
    variant: number,
    buffer: AudioBuffer,
    when: number,
  ): void {
    this.voices.push({
      voice: sound.gain.play(buffer, when, SAMPLE_FADE_SECONDS),
      startsAt: when,
      endsAt: when + buffer.duration,
      sound,
      variant,
    });
    if (!this.log.listening()) return;
    this.log.write({
      type: "sample",
      t: this.output.currentTime(),
      track: this.track.name,
      layer: sound.layer.name,
      role: sound.role,
      variant,
      start: when,
      pan: sound.layer.pan,
    });
  }

  private rampBus(
    target: number,
    seconds: number,
    cause: TrackGainCause,
  ): void {
    this.bus.ramp(target, seconds);
    if (!this.log.listening()) return;
    this.log.write({
      type: "track-gain",
      t: this.output.currentTime(),
      track: this.track.name,
      target,
      ramp: seconds,
      cause,
    });
  }

  /** When this start opens a run, which a resume does not. */
  private logRunStart(runStarts: boolean, now: number, state: State): void {
    if (!runStarts || !this.log.listening()) return;
    this.log.write({
      type: "run-start",
      t: now,
      track: this.track.name,
      state: state.name,
    });
  }

  private logState(state: State, cause: "director" | "phase"): void {
    if (!this.log.listening()) return;
    this.log.write({
      type: "state",
      t: this.output.currentTime(),
      track: this.track.name,
      state: state.name,
      cause,
    });
  }

  /**
   * Only a move: a ramp to where the gain was already going is not one. Called
   * ahead of the ramp's record, which it compares with.
   */
  private logLayerGain(
    layerIndex: number,
    target: number,
    seconds: number,
    cause: LayerGainCause,
  ): void {
    if (!this.log.listening()) return;
    if (this.layerRamps[layerIndex]?.target === target) return;
    this.log.write({
      type: "layer-gain",
      t: this.output.currentTime(),
      track: this.track.name,
      layer: this.track.layers[layerIndex].name,
      target,
      ramp: seconds,
      cause,
    });
  }

  /** What a stop cuts before it started was never heard; called as it cuts. */
  private logCancelled(): void {
    if (!this.log.listening()) return;
    const now = this.output.currentTime();
    for (const active of this.voices) {
      if (active.startsAt < now) continue;
      this.log.write({
        type: "sample-cancel",
        t: now,
        track: this.track.name,
        layer: active.sound.layer.name,
        variant: active.variant,
        start: active.startsAt,
      });
    }
  }

  // Once per sample: a missing stem comes up again at every turn of its layer,
  // every few seconds for as long as the track plays.
  private reportMissing(layer: Layer, variant: number, error: unknown): void {
    const { group, first } = spanOf(layer, variant);
    const inGroup = variant - first + 1;
    const key = `${layer.name}/${String(group)}/${String(inGroup)}`;
    if (this.reportedMissing.has(key)) return;
    this.reportedMissing.add(key);
    appLogger.warn("[soundtrack] skipping a sample that would not load", {
      track: this.track.name,
      layer: layer.name,
      group,
      variant: inGroup,
      error: describeLogError(error),
    });
  }

  private cutVoices(fadeSeconds: number): void {
    const now = this.output.currentTime();
    this.fading = this.fading.filter((fading) => fading.silentAt > now);
    for (const active of this.voices) {
      active.voice.cut(fadeSeconds);
      // One cut before it started stops there and then, with nothing to fade.
      if (
        active.sound.layerIndex !== null &&
        active.startsAt < now &&
        active.endsAt > now
      ) {
        this.fading.push({
          voice: active.voice,
          layerIndex: active.sound.layerIndex,
          silentAt: Math.min(active.endsAt, now + fadeSeconds),
        });
      }
    }
    this.voices = [];
  }

  /**
   * Ends over the edge fade what a cut is still fading on the layer, from
   * wherever the layer's gain holds it, and answers whether there was any.
   */
  private silenceFading(layerIndex: number, now: number): boolean {
    this.fading = this.fading.filter((fading) => fading.silentAt > now);
    const onLayer = this.fading.filter(
      (fading) => fading.layerIndex === layerIndex,
    );
    for (const fading of onLayer) fading.voice.cut(SAMPLE_FADE_SECONDS);
    this.fading = this.fading.filter(
      (fading) => fading.layerIndex !== layerIndex,
    );
    return onLayer.length > 0;
  }

  /** The gain a layer is going to, outside an outro's fade. */
  private layerLevel(layerIndex: number): number {
    return this.enabledLayers()[layerIndex] ? this.layerTargets[layerIndex] : 0;
  }

  /**
   * Under the outro, nothing but its fade moves a layer: a target or a switch
   * set meanwhile waits for the next start.
   */
  private applyLayerGain(
    layerIndex: number,
    seconds: number,
    cause: LayerGainCause,
  ): void {
    if (this.phase.kind === "playing" && this.phase.outroEndsAt !== null) {
      return;
    }
    const target = this.layerLevel(layerIndex);
    const now = this.output.currentTime();
    const last = this.layerRamps[layerIndex];
    // A ramp to where the gain is already going keeps a longer ramp's end, so
    // a move that leaves a layer where a phase's fade takes it cannot cut it.
    let length =
      last !== null &&
      last.target === target &&
      last.endsAt > now + seconds + RAMP_END_TOLERANCE_SECONDS
        ? last.endsAt - now
        : seconds;
    // A gain that rises would take up what a stop is still fading on it, as a
    // start after an outro's fade would: those end over the edge fade, from
    // where the gain holds them, and the gain rises slowly enough that they
    // cannot come up meanwhile.
    if (
      last !== null &&
      target > last.target &&
      this.silenceFading(layerIndex, now)
    ) {
      length = Math.max(length, LAYER_RAMP_SECONDS);
    }
    this.layerGains[layerIndex].ramp(target, length);
    this.logLayerGain(layerIndex, target, length, cause);
    this.layerRamps[layerIndex] = { target, endsAt: now + length };
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
