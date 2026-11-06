/**
 * Every number the directors, the session and a run's end mix by, to be tuned
 * by ear. Their source is the soundtrack plan page's Signals section and its
 * prototype's `rulesPlan`, `applyPlan` and `direct`, except where one says
 * otherwise; none of them is a spec.
 */
export const MIX_TUNING = {
  /** How often a plan is restated with no signal having changed. */
  replanIntervalMs: 5000,
  /** How long a `done` row counts for after it arrives. */
  doneWindowMs: 90_000,
  /**
   * `base + Σ weight · min(count, cap)`, clamped to 1. A cap keeps a feed left
   * unread from pinning the mix at full for as long as nobody reads it.
   */
  intensity: {
    base: 0.12,
    working: { weight: 0.15, cap: 3 },
    blocking: { weight: 0.2, cap: 2 },
    failure: { weight: 0.25, cap: 1 },
    done: { weight: 0.05, cap: 2 },
  },
  /** `calm − perIntensity · intensity`, clamped to `[busy, calm]`. */
  pauseMultiplier: { calm: 1.6, perIntensity: 1.2, busy: 0.4 },
  /** Gains by layer role; an `event` layer, or one with no role, plays at 1. */
  layerGains: {
    /** Lifted while something waits for the person. */
    pad: { rest: 0.9, held: 1.25 },
    /** Lifted while a `done` row counts. */
    motif: { rest: 1, lifted: 1.2 },
    /** Follows intensity, and is full while the mix is dimmed. */
    texture: { base: 0.6, perIntensity: 0.6, dimmed: 1.3 },
  },
  /** The low-pass over the whole mix while a failure is unread. */
  dim: { openHz: 20_000, dimmedHz: 900, q: 0.3, rampSeconds: 1.2 },
  /** The silence between two plays of a track. */
  silenceSeconds: [8, 20],
  /** What still sounds when a track's outro ends fades out over this long. */
  outroRingOutSeconds: 4,
  /**
   * A run without an outro rings out past its length for no longer than this.
   * A starting point for the listening test: it lets every sample of aquilo-1
   * that started before the length finish (its longest is 39 s), and stops a
   * bed of three minutes or more from holding the run for that long.
   */
  ringOutCapSeconds: 40,
  /**
   * What still sounds at that cap fades out over this long. A starting point
   * for the listening test, set as the outro's ring-out so both ends sound
   * alike. Longer would be cut short: a view moving on to another track stops
   * the player over `outroRingOutSeconds`.
   */
  ringOutFadeSeconds: 4,
  /** The first track of a session, or one after a view with none. */
  fadeInSeconds: 0.5,
  /** Turning the soundtrack off. */
  stopFadeSeconds: 0.4,
  /** The soundtrack's level as a gain, until the person moves it. */
  volume: { initial: 0.5, rampSeconds: 0.05 },
  /**
   * Under a chime: the gain the music drops to, how fast it gets there, and how
   * slowly it comes back once the chime is over.
   */
  duck: { gain: 0.25, attackSeconds: 0.08, releaseSeconds: 0.8 },
} as const;
