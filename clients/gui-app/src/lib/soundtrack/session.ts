import type { MixDirector, MixPlan } from "./directors";
import type { SoundtrackManifest, SoundtrackTrack } from "./manifest";
import { ComposedPlayer } from "./composed-player";
import { MIX_TUNING } from "./mix-tuning";
import type { SoundtrackOutput } from "./output";
import {
  CROSSFADE_SECONDS,
  crossfadePlayers,
  TrackPlayer,
  type PlaybackLifecycle,
} from "./player";
import type { MixCapture, RecordingQuality } from "./recording";
import { drawSeconds, type RandomSource } from "./scheduler";
import type {
  PauseCause,
  PlayCause,
  SkipCause,
  SkipDirection,
  SoundtrackLogRelay,
} from "./session-log";
import {
  sameMixSignals,
  type MixSignals,
  type SoundtrackView,
} from "./signals";
import type { StemSource } from "./stems";
import type { VariableTrack } from "./variable-sound";

/** The ports a session plays through, for as long as it lasts. */
export interface SoundtrackPorts {
  readonly output: SoundtrackOutput;
  readonly stems: StemSource;
  /** Takes the whole mix through the low-pass, or out of it. */
  setDimmed(dimmed: boolean): void;
  /** The soundtrack's level, moved with nothing reopened. */
  setVolume(volume: number): void;
  /** Drops the music for as long as a chime of `chimeSeconds` sounds. */
  duck(chimeSeconds: number): void;
  /** Lets go of the audio device once `afterSeconds` have gone by. */
  close(afterSeconds: number): void;
  /** Where the engine says what it does; nothing listens until a recording. */
  readonly log: SoundtrackLogRelay;
  /**
   * A copy of the mix as it leaves the low-pass, ahead of the volume and a
   * chime's duck, encoded as `quality` asks. Nothing is added to the graph
   * until this is called, and the speakers' path never changes. Rejects where
   * the capture cannot be made.
   */
  captureMix(quality: RecordingQuality): Promise<MixCapture>;
  /**
   * Fades the mix out, then stops the output's clock, and every voice and ramp
   * on it with it, until `resume`.
   */
  pause(): void;
  /**
   * Starts the clock again and fades the mix back up. `onRefused` runs later if
   * the device will not start, the clock still stopped.
   */
  resume(onRefused: () => void): void;
}

/** Where a view's track had got to, so that it comes back there. */
interface ResumePosition {
  readonly trackName: string;
  readonly elapsedSeconds: number;
}

export type ResumePositions = Readonly<
  Partial<Record<SoundtrackView, ResumePosition>>
>;

/** What is sounding now; null while the view in front has no track. */
interface SoundingMix {
  readonly view: SoundtrackView;
  readonly plan: MixPlan | null;
}

interface SoundtrackSessionOptions {
  readonly manifest: SoundtrackManifest;
  readonly ports: SoundtrackPorts;
  readonly random: RandomSource;
  readonly director: MixDirector;
  readonly resumePositions: ResumePositions;
  readonly onSounding: (sounding: SoundingMix | null) => void;
  /** The device would not start for the latest Play, so the music cannot go on. */
  readonly onResumeRefused: () => void;
}

/** The tracks a view has been on, as a browser keeps its pages. */
interface TrackHistory {
  readonly tracks: readonly SoundtrackTrack[];
  /** Where in `tracks` the view is. */
  readonly at: number;
}

/** The track a view is on, the track's player, and how it got there. */
interface ViewPlayer {
  readonly view: SoundtrackView;
  readonly track: SoundtrackTrack;
  readonly player: PlaybackLifecycle;
  readonly history: TrackHistory;
}

/**
 * The silence before the track a view moved on to, running down on a timer or
 * held by a pause with what is left of it.
 */
type PendingStart =
  | {
      readonly player: PlaybackLifecycle;
      readonly timer: number;
      readonly endsAt: number;
    }
  | {
      readonly player: PlaybackLifecycle;
      readonly timer: null;
      readonly secondsLeft: number;
    };

function startFromSilence(player: PlaybackLifecycle): void {
  player.start(
    player.elapsed(),
    player instanceof ComposedPlayer ? 0.01 : MIX_TUNING.fadeInSeconds,
  );
}

/** `track` next after where `history` is, which clears anything ahead of it. */
function visited(history: TrackHistory, track: SoundtrackTrack): TrackHistory {
  const tracks = [...history.tracks.slice(0, history.at + 1), track].slice(
    -MIX_TUNING.trackHistoryLength,
  );
  return { tracks, at: tracks.length - 1 };
}

interface AppliedPlan {
  readonly view: SoundtrackView;
  readonly track: VariableTrack;
  readonly plan: MixPlan;
}

function pickRandom<T>(
  items: readonly T[],
  count: number,
  random: RandomSource,
): readonly T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < count && pool.length > 0) {
    const [item] = pool.splice(Math.floor(random() * pool.length), 1);
    picked.push(item);
  }
  return picked;
}

/**
 * Moves the layers on by no more than the plan asks: held layers on, then the
 * count made up or trimmed at random, so the engine's roll stands wherever the
 * plan does not need to touch it and a restated plan changes nothing. A layer
 * the state fixes on or off stays so, and counts as it is.
 */
function settleEnabledLayers(
  player: TrackPlayer,
  plan: MixPlan,
  random: RandomSource,
): void {
  const current = player.enabledLayers();
  // In the silence there are none to move; the next restatement sets them.
  if (current.length === 0) return;
  const fixed = player.fixedLayers();
  const enabled = [...current];
  for (const layerIndex of plan.heldLayers) {
    if (!fixed[layerIndex]) enabled[layerIndex] = true;
  }
  if (plan.enabledLayerCount !== null) {
    const indices = enabled.map((_, layerIndex) => layerIndex);
    const on = indices.filter((layerIndex) => enabled[layerIndex]);
    const off = indices.filter(
      (layerIndex) => !enabled[layerIndex] && !fixed[layerIndex],
    );
    const trimmable = on.filter(
      (layerIndex) =>
        !plan.heldLayers.includes(layerIndex) && !fixed[layerIndex],
    );
    const missing = plan.enabledLayerCount - on.length;
    for (const layerIndex of pickRandom(off, missing, random)) {
      enabled[layerIndex] = true;
    }
    for (const layerIndex of pickRandom(trimmable, -missing, random)) {
      enabled[layerIndex] = false;
    }
  }
  enabled.forEach((on, layerIndex) => {
    if (on !== current[layerIndex]) player.setLayerEnabled(layerIndex, on);
  });
}

/**
 * One run of the soundtrack, from being switched on to being switched off: a
 * player per track, shared by the views on it, the view in front crossfaded to,
 * and every plan the director answers applied to the player in front. A view
 * moving onto the track already sounding takes its player over with nothing
 * faded. A player fading out keeps the last plan it had. A track's end
 * discards the layers a plan set, and the plan is restated as the next run
 * starts. At the end of a run in front, the view moves on to another track of
 * its pool, if it has one, which plays from its top after the silence.
 *
 * A pause holds all of it: the clock stops at the ports, and everything on a
 * wall-clock timer stops here or in the players. Signals and a director arrive
 * as ever and are first acted on at `play`.
 */
export class SoundtrackSession {
  readonly ports: SoundtrackPorts;
  private readonly manifest: SoundtrackManifest;
  private readonly random: RandomSource;
  private readonly resumePositions: ResumePositions;
  private readonly onSounding: (sounding: SoundingMix | null) => void;
  private readonly onResumeRefused: () => void;
  /** The track each view is on. */
  private readonly players = new Map<SoundtrackView, ViewPlayer>();
  /** By track name. */
  private readonly trackPlayers = new Map<string, PlaybackLifecycle>();
  private timer: number;
  private director: MixDirector;
  private signals: MixSignals | null = null;
  /** The view last brought to front, which a pause leaves behind `signals`. */
  private frontView: SoundtrackView | null = null;
  private inFront: ViewPlayer | null = null;
  /** Starts the track a view moved on to, once the silence is over. */
  private pendingStart: PendingStart | null = null;
  private paused = false;
  /** Moves on at each Play, pause and end, so a refusal answers only the latest. */
  private resumeAttempt = 0;
  /** The plan last applied, and the view and track it was for. */
  private applied: AppliedPlan | null = null;

  constructor(options: SoundtrackSessionOptions) {
    this.manifest = options.manifest;
    this.ports = options.ports;
    this.random = options.random;
    this.resumePositions = options.resumePositions;
    this.onSounding = options.onSounding;
    this.onResumeRefused = options.onResumeRefused;
    this.director = options.director;
    this.timer = this.startReplanning();
  }

  setSignals(signals: MixSignals): void {
    const previous = this.signals;
    if (previous !== null && sameMixSignals(previous, signals)) return;
    this.signals = signals;
    this.logSignals(signals);
    if (!this.paused) this.followSignals();
  }

  /**
   * Tells the log what drives the mix, what it is sounding and the plan last
   * applied: for a recording starting now, whose first minute would otherwise
   * be events about things it never saw begin. It only reads, so the music
   * goes on exactly as it would have without a recording.
   */
  logNow(): void {
    const { log } = this.ports;
    if (!log.listening()) return;
    const { signals, inFront, applied } = this;
    if (signals !== null) this.logSignals(signals);
    log.write({
      type: "sounding",
      t: this.ports.output.currentTime(),
      view: this.frontView,
      paused: this.paused,
      player: inFront?.player.describe() ?? null,
    });
    if (applied !== null) {
      this.logPlan(applied.view, applied.track, applied.plan);
    }
  }

  setDirector(director: MixDirector): void {
    this.director = director;
    if (!this.paused) this.replan();
  }

  /** A chime heard during a pause is over long before the music is back. */
  duck(chimeSeconds: number): void {
    if (!this.paused) this.ports.duck(chimeSeconds);
  }

  /** Holds everything where it is, the rest of a silence included, until `play`. */
  pause(): void {
    if (this.paused) return;
    this.logPause("person");
    this.paused = true;
    this.resumeAttempt += 1;
    window.clearInterval(this.timer);
    const pending = this.pendingStart;
    if (pending !== null && pending.timer !== null) {
      window.clearTimeout(pending.timer);
      this.pendingStart = {
        player: pending.player,
        timer: null,
        secondsLeft: pending.endsAt - this.ports.output.currentTime(),
      };
    }
    for (const player of this.trackPlayers.values()) player.hold();
    this.ports.pause();
  }

  /** Goes on from where a pause held it, with what arrived meanwhile. */
  play(): void {
    this.playFor("person");
  }

  /**
   * Moves the view on now, and plays if it was paused: forward along its history
   * if Previous left any, else to a track picked as a run's end picks one, else,
   * with no other track, back to the top of this one. In the silence, the track
   * the run's end picked is the one to go to, and it starts at once.
   */
  next(): void {
    this.playFor("skip");
    const { inFront, pendingStart } = this;
    if (inFront === null) return;
    if (pendingStart !== null) {
      this.logSkip("next", inFront.track, "silence");
      this.cancelPendingStart();
      startFromSilence(pendingStart.player);
      return;
    }
    const { history } = inFront;
    if (history.at + 1 < history.tracks.length) {
      this.skipTo(
        inFront,
        { ...history, at: history.at + 1 },
        "next",
        "history",
      );
      return;
    }
    const track = this.anotherTrack(inFront);
    if (track === null) this.skipTo(inFront, history, "next", "restart");
    else this.skipTo(inFront, visited(history, track), "next", "pick");
  }

  /**
   * Moves the view back to the track before this one, and plays if it was
   * paused, or with none earlier goes back to the top of this one.
   */
  previous(): void {
    this.playFor("skip");
    const { inFront } = this;
    if (inFront === null) return;
    const { history } = inFront;
    if (history.at > 0) {
      this.skipTo(
        inFront,
        { ...history, at: history.at - 1 },
        "previous",
        "history",
      );
    } else {
      this.skipTo(inFront, history, "previous", "restart");
    }
  }

  /** Stops every player and answers where each one got to. */
  end(): ResumePositions {
    this.resumeAttempt += 1;
    window.clearInterval(this.timer);
    this.cancelPendingStart();
    const positions: Partial<Record<SoundtrackView, ResumePosition>> = {
      ...this.resumePositions,
    };
    // Every player: one a skip left fading out is no view's any more.
    for (const player of this.trackPlayers.values()) {
      player.stop(MIX_TUNING.stopFadeSeconds);
    }
    for (const { view, track, player } of this.players.values()) {
      positions[view] = {
        trackName: track.name,
        elapsedSeconds: player.elapsed(),
      };
    }
    this.ports.close(MIX_TUNING.stopFadeSeconds);
    return positions;
  }

  private playFor(cause: PlayCause): void {
    if (!this.paused) return;
    this.logPlay(cause);
    this.paused = false;
    this.resumeAttempt += 1;
    const attempt = this.resumeAttempt;
    this.ports.resume(() => {
      if (attempt !== this.resumeAttempt) return;
      // Ahead of the end it brings, which a recording stops listening at.
      this.logPause("refused-resume");
      this.onResumeRefused();
    });
    for (const player of this.trackPlayers.values()) player.release();
    const pending = this.pendingStart;
    if (pending !== null && pending.timer === null) {
      this.waitOutSilence(pending.player, pending.secondsLeft);
    }
    this.timer = this.startReplanning();
    this.followSignals();
  }

  private startReplanning(): number {
    return window.setInterval(() => {
      this.replan();
    }, MIX_TUNING.replanIntervalMs);
  }

  private followSignals(): void {
    const { signals } = this;
    if (signals === null) return;
    if (signals.view !== this.frontView) this.bringToFront(signals.view);
    this.replan();
  }

  private bringToFront(view: SoundtrackView): void {
    const previous = this.inFront;
    const next = this.playerFor(view);
    this.frontView = view;
    this.inFront = next;
    // The track sounding goes on under the new view; only the plan moves.
    if (previous?.player === next?.player) return;
    this.cancelPendingStart();
    if (previous !== null && next !== null) {
      crossfadePlayers(previous.player, next.player);
      return;
    }
    previous?.player.fadeOut(CROSSFADE_SECONDS);
    if (next !== null) startFromSilence(next.player);
  }

  /** Moves the view to the track `history` is at, from its top, crossfading. */
  private skipTo(
    from: ViewPlayer,
    history: TrackHistory,
    direction: SkipDirection,
    cause: SkipCause,
  ): void {
    this.cancelPendingStart();
    const track = history.tracks[history.at];
    this.logSkip(direction, track, cause);
    const to: ViewPlayer = {
      view: from.view,
      track,
      player: this.trackPlayer(track, 0),
      history,
    };
    // A fresh run from the top, whatever it was doing: on the track in front it
    // cuts the old run under the new one, and one still fading out stops here,
    // so the run it was in cannot end and move on again.
    to.player.rewind(CROSSFADE_SECONDS);
    this.players.set(to.view, to);
    this.inFront = to;
    crossfadePlayers(from.player, to.player);
  }

  private playerFor(view: SoundtrackView): ViewPlayer | null {
    const existing = this.players.get(view);
    if (existing !== undefined) return existing;
    const track = this.trackFor(view);
    if (track === null) return null;
    const resume = this.resumePositions[view];
    const created: ViewPlayer = {
      view,
      track,
      player: this.trackPlayer(
        track,
        resume?.trackName === track.name ? resume.elapsedSeconds : 0,
      ),
      history: { tracks: [track], at: 0 },
    };
    this.players.set(view, created);
    return created;
  }

  /** The track's player, or a new one from `resumeAt` if it has none yet. */
  private trackPlayer(
    track: SoundtrackTrack,
    resumeAt: number,
  ): PlaybackLifecycle {
    const existing = this.trackPlayers.get(track.name);
    if (existing !== undefined) return existing;
    if (track.kind === "composed") {
      const player = new ComposedPlayer({
        track,
        output: this.ports.output,
        stems: this.ports.stems,
        position: resumeAt,
        onEnd: () => {
          if (this.inFront?.player !== player) return;
          const next = this.anotherTrack(this.inFront);
          if (next !== null)
            this.runEnded(
              player,
              drawSeconds(MIX_TUNING.silenceSeconds, this.random),
            );
          else
            this.waitOutSilence(
              player,
              drawSeconds(MIX_TUNING.silenceSeconds, this.random),
            );
        },
      });
      this.trackPlayers.set(track.name, player);
      return player;
    }
    const player: TrackPlayer = new TrackPlayer({
      track,
      output: this.ports.output,
      stems: this.ports.stems,
      random: this.random,
      log: this.ports.log,
      silenceSeconds: MIX_TUNING.silenceSeconds,
      resumeAt,
      onRunStart: () => {
        this.runStarted(player);
      },
      onRunEnd: (silenceSeconds) => {
        this.runEnded(player, silenceSeconds);
      },
    });
    this.trackPlayers.set(track.name, player);
    return player;
  }

  private poolOf(view: SoundtrackView): readonly SoundtrackTrack[] {
    const names = this.manifest.views[view];
    return this.manifest.tracks.filter((track) => names.includes(track.name));
  }

  /** The track it was on if the view is resuming, else one from its pool. */
  private trackFor(view: SoundtrackView): SoundtrackTrack | null {
    const pool = this.poolOf(view);
    const resumed = pool.find(
      (track) => track.name === this.resumePositions[view]?.trackName,
    );
    if (resumed !== undefined) return resumed;
    const [picked = null] = pickRandom(pool, 1, this.random);
    return picked;
  }

  /**
   * The layers a plan set went with the last run; restated now, they land on
   * this one's first tick.
   */
  private runStarted(player: TrackPlayer): void {
    if (this.inFront?.player === player) this.replan();
  }

  /**
   * A view whose pool has another track moves on to it, from its top once the
   * silence is over; one with a single track plays it again after the silence.
   */
  private runEnded(player: PlaybackLifecycle, silenceSeconds: number): void {
    const { inFront } = this;
    if (inFront?.player !== player) return;
    const track = this.anotherTrack(inFront);
    if (track === null) return;
    // Nothing new starts; what rings out past an outro keeps its fade.
    player.stop(MIX_TUNING.outroRingOutSeconds);
    const next: ViewPlayer = {
      view: inFront.view,
      track,
      player: this.trackPlayer(track, 0),
      history: visited(inFront.history, track),
    };
    // A fresh run from the top, whatever another view left it at. One still
    // fading out stops here, so the run it was in cannot end and move on again.
    next.player.rewind(CROSSFADE_SECONDS);
    this.players.set(next.view, next);
    this.inFront = next;
    this.cancelPendingStart();
    this.waitOutSilence(next.player, silenceSeconds);
  }

  /** Another track of the view's pool, picked at random; null if it has none. */
  private anotherTrack(from: ViewPlayer): SoundtrackTrack | null {
    const others = this.poolOf(from.view).filter(
      (track) => track !== from.track,
    );
    const [track = null] = pickRandom(others, 1, this.random);
    return track;
  }

  private waitOutSilence(player: PlaybackLifecycle, seconds: number): void {
    const timer = window.setTimeout(() => {
      this.pendingStart = null;
      startFromSilence(player);
    }, seconds * 1000);
    this.pendingStart = {
      player,
      timer,
      endsAt: this.ports.output.currentTime() + seconds,
    };
  }

  private cancelPendingStart(): void {
    const pending = this.pendingStart;
    if (pending === null) return;
    if (pending.timer !== null) window.clearTimeout(pending.timer);
    this.pendingStart = null;
  }

  private replan(): void {
    const { signals, inFront } = this;
    if (signals === null) return;
    if (inFront === null) {
      this.applied = null;
      this.onSounding(null);
      return;
    }
    const { player, track, view } = inFront;
    if (track.kind === "composed" || !(player instanceof TrackPlayer)) {
      this.applied = null;
      this.ports.setDimmed(false);
      this.onSounding({ view, plan: null });
      return;
    }
    const plan = this.director.plan(signals, {
      track,
      state: player.currentState(),
    });
    this.applied = { view, track, plan };
    this.logPlan(view, track, plan);
    // First, because moving state rolls the layers the rest of the plan adjusts.
    if (plan.state !== null) player.enterState(plan.state);
    player.setPauseMultiplier(plan.pauseMultiplier);
    plan.layerGains.forEach((gain, layerIndex) => {
      player.setLayerTarget(layerIndex, gain);
    });
    settleEnabledLayers(player, plan, this.random);
    this.ports.setDimmed(plan.dim);
    this.onSounding({ view, plan });
  }

  private logPause(cause: PauseCause): void {
    const { log, output } = this.ports;
    if (!log.listening()) return;
    log.write({ type: "pause", t: output.currentTime(), cause });
  }

  private logPlay(cause: PlayCause): void {
    const { log, output } = this.ports;
    if (!log.listening()) return;
    log.write({ type: "play", t: output.currentTime(), cause });
  }

  private logSkip(
    direction: SkipDirection,
    to: SoundtrackTrack,
    cause: SkipCause,
  ): void {
    const { log, output } = this.ports;
    if (!log.listening()) return;
    log.write({
      type: "skip",
      t: output.currentTime(),
      direction,
      to: to.name,
      cause,
    });
  }

  /** The five values a director reads, copied one by one and nothing else. */
  private logSignals(signals: MixSignals): void {
    const { log } = this.ports;
    if (!log.listening()) return;
    log.write({
      type: "signals",
      t: this.ports.output.currentTime(),
      view: signals.view,
      working: signals.working,
      blocking: signals.blocking,
      failure: signals.failure,
      done: signals.done,
    });
  }

  private logPlan(
    view: SoundtrackView,
    track: VariableTrack,
    plan: MixPlan,
  ): void {
    const { log } = this.ports;
    if (!log.listening()) return;
    const layerName = (layerIndex: number): string =>
      track.layers[layerIndex].name;
    log.write({
      type: "plan",
      t: this.ports.output.currentTime(),
      view,
      track: track.name,
      state: plan.state,
      layerCount: plan.enabledLayerCount,
      heldLayers: plan.heldLayers.map(layerName),
      pauseMultiplier: plan.pauseMultiplier,
      layerGains: Object.fromEntries(
        plan.layerGains.map((gain, layerIndex) => [
          layerName(layerIndex),
          gain,
        ]),
      ),
      dim: plan.dim,
    });
  }
}
