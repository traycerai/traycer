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
  /** Lets go of the audio device once `afterSeconds` have gone by. */
  close(afterSeconds: number): void;
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
 * plan does not need to touch it and a restated plan changes nothing.
 */
function settleEnabledLayers(
  player: TrackPlayer,
  plan: MixPlan,
  random: RandomSource,
): void {
  const current = player.enabledLayers();
  // In the silence there are none to move; the next restatement sets them.
  if (current.length === 0) return;
  const enabled = [...current];
  for (const layerIndex of plan.heldLayers) enabled[layerIndex] = true;
  if (plan.enabledLayerCount !== null) {
    const indices = enabled.map((_, layerIndex) => layerIndex);
    const on = indices.filter((layerIndex) => enabled[layerIndex]);
    const off = indices.filter((layerIndex) => !enabled[layerIndex]);
    const trimmable = on.filter(
      (layerIndex) => !plan.heldLayers.includes(layerIndex),
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
 * player per view, the view in front crossfaded to, and every plan the director
 * answers applied to the player in front. A player fading out keeps the last
 * plan it had. A track's end discards the layers a plan set, and the next
 * restatement sets them again.
 */
export class SoundtrackSession {
  private readonly manifest: SoundtrackManifest;
  private readonly ports: SoundtrackPorts;
  private readonly random: RandomSource;
  private readonly resumePositions: ResumePositions;
  private readonly onSounding: (sounding: SoundingMix | null) => void;
  private readonly players = new Map<SoundtrackView, ViewPlayer>();
  private readonly timer: number;
  private director: MixDirector;
  private signals: MixSignals | null = null;
  private inFront: ViewPlayer | null = null;

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
    if (previous?.view !== signals.view) this.bringToFront(signals.view);
    this.replan();
  }

  setDirector(director: MixDirector): void {
    this.director = director;
    this.replan();
  }

  /** Stops every player and answers where each one got to. */
  end(): ResumePositions {
    window.clearInterval(this.timer);
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
      player: new TrackPlayer({
        track,
        output: this.ports.output,
        stems: this.ports.stems,
        random: this.random,
        silenceSeconds: MIX_TUNING.silenceSeconds,
        resumeAt: resume?.trackName === track.name ? resume.elapsedSeconds : 0,
      }),
    };
    this.players.set(view, created);
    return created;
  }

  /** The track it was on if the view is resuming, else one from its pool. */
  private trackFor(view: SoundtrackView): VariableTrack | null {
    const names = this.manifest.views[view];
    const pool = this.manifest.tracks.filter((track) =>
      names.includes(track.name),
    );
    const resumed = pool.find(
      (track) => track.name === this.resumePositions[view]?.trackName,
    );
    if (resumed !== undefined) return resumed;
    const [picked = null] = pickRandom(pool, 1, this.random);
    return picked;
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
