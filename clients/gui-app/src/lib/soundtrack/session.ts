import type { MixDirector, MixPlan } from "./directors";
import type { SoundtrackManifest } from "./manifest";
import { MIX_TUNING } from "./mix-tuning";
import type { SoundtrackOutput } from "./output";
import { CROSSFADE_SECONDS, crossfadePlayers, TrackPlayer } from "./player";
import type { MixCapture, RecordingQuality } from "./recording";
import type { RandomSource } from "./scheduler";
import type { SoundtrackLogRelay } from "./session-log";
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

/** The track a view is on, and the track's player. */
interface ViewPlayer {
  readonly view: SoundtrackView;
  readonly track: VariableTrack;
  readonly player: TrackPlayer;
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
  private readonly timer: number;
  private director: MixDirector;
  private signals: MixSignals | null = null;
  private inFront: ViewPlayer | null = null;
  /** Starts the track a view moved on to, once the silence is over. */
  private pendingStart: number | null = null;

  constructor(options: SoundtrackSessionOptions) {
    this.manifest = options.manifest;
    this.ports = options.ports;
    this.random = options.random;
    this.resumePositions = options.resumePositions;
    this.onSounding = options.onSounding;
    this.director = options.director;
    this.timer = window.setInterval(() => {
      this.replan();
    }, MIX_TUNING.replanIntervalMs);
  }

  setSignals(signals: MixSignals): void {
    const previous = this.signals;
    if (previous !== null && sameMixSignals(previous, signals)) return;
    this.signals = signals;
    this.logSignals(signals);
    if (previous?.view !== signals.view) this.bringToFront(signals.view);
    this.replan();
  }

  /**
   * Tells the log what drives the mix and what it is sounding, then restates
   * the plan: for a recording starting now, whose first minute would otherwise
   * be events about things it never saw begin.
   */
  logNow(): void {
    const { log } = this.ports;
    if (!log.listening()) return;
    const { signals, inFront } = this;
    if (signals !== null) this.logSignals(signals);
    log.write({
      type: "sounding",
      t: this.ports.output.currentTime(),
      view: signals?.view ?? null,
      player: inFront?.player.describe() ?? null,
    });
    this.replan();
  }

  setDirector(director: MixDirector): void {
    this.director = director;
    this.replan();
  }

  /** Stops every player and answers where each one got to. */
  end(): ResumePositions {
    window.clearInterval(this.timer);
    this.cancelPendingStart();
    const positions: Partial<Record<SoundtrackView, ResumePosition>> = {
      ...this.resumePositions,
    };
    for (const { view, track, player } of this.players.values()) {
      player.stop(MIX_TUNING.stopFadeSeconds);
      positions[view] = {
        trackName: track.name,
        elapsedSeconds: player.elapsed(),
      };
    }
    this.ports.close(MIX_TUNING.stopFadeSeconds);
    return positions;
  }

  private bringToFront(view: SoundtrackView): void {
    const previous = this.inFront;
    const next = this.playerFor(view);
    this.inFront = next;
    // The track sounding goes on under the new view; only the plan moves.
    if (previous?.player === next?.player) return;
    this.cancelPendingStart();
    if (previous !== null && next !== null) {
      crossfadePlayers(previous.player, next.player);
      return;
    }
    previous?.player.fadeOut(CROSSFADE_SECONDS);
    next?.player.start(next.player.elapsed(), MIX_TUNING.fadeInSeconds);
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
    const others = this.poolOf(inFront.view).filter(
      (track) => track !== inFront.track,
    );
    const [track = null] = pickRandom(others, 1, this.random);
    if (track === null) return;
    // Nothing new starts; what rings out past an outro keeps its fade.
    player.stop(MIX_TUNING.outroRingOutSeconds);
    const next: ViewPlayer = {
      view: inFront.view,
      track,
      player: this.trackPlayer(track, 0),
    };
    // A fresh run from the top, whatever another view left it at. One still
    // fading out stops here, so the run it was in cannot end and move on again.
    next.player.rewind(CROSSFADE_SECONDS);
    this.players.set(next.view, next);
    this.inFront = next;
    this.cancelPendingStart();
    this.pendingStart = window.setTimeout(() => {
      this.pendingStart = null;
      next.player.start(next.player.elapsed(), MIX_TUNING.fadeInSeconds);
    }, silenceSeconds * 1000);
  }

  private cancelPendingStart(): void {
    if (this.pendingStart === null) return;
    window.clearTimeout(this.pendingStart);
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
