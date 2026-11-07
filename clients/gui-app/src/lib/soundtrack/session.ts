import type { MixDirector, MixPlan } from "./directors";
import type { SoundtrackManifest } from "./manifest";
import { MIX_TUNING } from "./mix-tuning";
import type { SoundtrackOutput } from "./output";
import { CROSSFADE_SECONDS, crossfadePlayers, TrackPlayer } from "./player";
import type { RandomSource } from "./scheduler";
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
  /**
   * Fades the mix out, then stops the output's clock, and every voice and ramp
   * on it with it, until `resume`.
   */
  pause(): void;
  /** Starts the clock again and fades the mix back up. */
  resume(): void;
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
  readonly plan: MixPlan;
}

interface SoundtrackSessionOptions {
  readonly manifest: SoundtrackManifest;
  readonly ports: SoundtrackPorts;
  readonly random: RandomSource;
  readonly director: MixDirector;
  readonly resumePositions: ResumePositions;
  readonly onSounding: (sounding: SoundingMix | null) => void;
}

/** The tracks a view has been on, as a browser keeps its pages. */
interface TrackHistory {
  readonly tracks: readonly VariableTrack[];
  /** Where in `tracks` the view is. */
  readonly at: number;
}

/** The track a view is on, the track's player, and how it got there. */
interface ViewPlayer {
  readonly view: SoundtrackView;
  readonly track: VariableTrack;
  readonly player: TrackPlayer;
  readonly history: TrackHistory;
}

/**
 * The silence before the track a view moved on to, running down on a timer or
 * held by a pause with what is left of it.
 */
type PendingStart =
  | {
      readonly player: TrackPlayer;
      readonly timer: number;
      readonly endsAt: number;
    }
  | {
      readonly player: TrackPlayer;
      readonly timer: null;
      readonly secondsLeft: number;
    };

function startFromSilence(player: TrackPlayer): void {
  player.start(player.elapsed(), MIX_TUNING.fadeInSeconds);
}

/** `track` next after where `history` is, which clears anything ahead of it. */
function visited(history: TrackHistory, track: VariableTrack): TrackHistory {
  const tracks = [...history.tracks.slice(0, history.at + 1), track].slice(
    -MIX_TUNING.trackHistoryLength,
  );
  return { tracks, at: tracks.length - 1 };
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
  /** The track each view is on. */
  private readonly players = new Map<SoundtrackView, ViewPlayer>();
  /** By track name. */
  private readonly trackPlayers = new Map<string, TrackPlayer>();
  private timer: number;
  private director: MixDirector;
  private signals: MixSignals | null = null;
  /** The view last brought to front, which a pause leaves behind `signals`. */
  private frontView: SoundtrackView | null = null;
  private inFront: ViewPlayer | null = null;
  /** Starts the track a view moved on to, once the silence is over. */
  private pendingStart: PendingStart | null = null;
  private paused = false;

  constructor(options: SoundtrackSessionOptions) {
    this.manifest = options.manifest;
    this.ports = options.ports;
    this.random = options.random;
    this.resumePositions = options.resumePositions;
    this.onSounding = options.onSounding;
    this.director = options.director;
    this.timer = this.startReplanning();
  }

  setSignals(signals: MixSignals): void {
    const previous = this.signals;
    if (previous !== null && sameMixSignals(previous, signals)) return;
    this.signals = signals;
    if (!this.paused) this.followSignals();
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
    this.paused = true;
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
    if (!this.paused) return;
    this.paused = false;
    this.ports.resume();
    for (const player of this.trackPlayers.values()) player.release();
    const pending = this.pendingStart;
    if (pending !== null && pending.timer === null) {
      this.waitOutSilence(pending.player, pending.secondsLeft);
    }
    this.timer = this.startReplanning();
    this.followSignals();
  }

  /**
   * Moves the view on now, and plays if it was paused: forward along its history
   * if Previous left any, else to a track picked as a run's end picks one, else,
   * with no other track, back to the top of this one. In the silence, the track
   * the run's end picked is the one to go to, and it starts at once.
   */
  next(): void {
    this.play();
    const { inFront, pendingStart } = this;
    if (inFront === null) return;
    if (pendingStart !== null) {
      this.cancelPendingStart();
      startFromSilence(pendingStart.player);
      return;
    }
    const { history } = inFront;
    if (history.at + 1 < history.tracks.length) {
      this.skipTo(inFront, { ...history, at: history.at + 1 });
      return;
    }
    const track = this.anotherTrack(inFront);
    this.skipTo(inFront, track === null ? history : visited(history, track));
  }

  /**
   * Moves the view back to the track before this one, and plays if it was
   * paused, or with none earlier goes back to the top of this one.
   */
  previous(): void {
    this.play();
    const { inFront } = this;
    if (inFront === null) return;
    const { history } = inFront;
    this.skipTo(
      inFront,
      history.at > 0 ? { ...history, at: history.at - 1 } : history,
    );
  }

  /** Stops every player and answers where each one got to. */
  end(): ResumePositions {
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
  private skipTo(from: ViewPlayer, history: TrackHistory): void {
    this.cancelPendingStart();
    const track = history.tracks[history.at];
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
  private trackPlayer(track: VariableTrack, resumeAt: number): TrackPlayer {
    const existing = this.trackPlayers.get(track.name);
    if (existing !== undefined) return existing;
    const player: TrackPlayer = new TrackPlayer({
      track,
      output: this.ports.output,
      stems: this.ports.stems,
      random: this.random,
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

  private poolOf(view: SoundtrackView): readonly VariableTrack[] {
    const names = this.manifest.views[view];
    return this.manifest.tracks.filter((track) => names.includes(track.name));
  }

  /** The track it was on if the view is resuming, else one from its pool. */
  private trackFor(view: SoundtrackView): VariableTrack | null {
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
  private runEnded(player: TrackPlayer, silenceSeconds: number): void {
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
  private anotherTrack(from: ViewPlayer): VariableTrack | null {
    const others = this.poolOf(from.view).filter(
      (track) => track !== from.track,
    );
    const [track = null] = pickRandom(others, 1, this.random);
    return track;
  }

  private waitOutSilence(player: TrackPlayer, seconds: number): void {
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
      this.onSounding(null);
      return;
    }
    const { player, track, view } = inFront;
    const plan = this.director.plan(signals, {
      track,
      state: player.currentState(),
    });
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
}
