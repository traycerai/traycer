/**
 * Every number the directors and the session mix by, to be tuned by ear. Their
 * source is the soundtrack plan page's Signals section and its prototype's
 * `rulesPlan`, `applyPlan` and `direct`; none of them is a spec.
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
  /** Gains by layer name; any other layer plays at 1. */
  layerGains: {
    /** The pad: lifted while something waits for the person. */
    B: { rest: 0.9, held: 1.25 },
    /** The motif: lifted while a `done` row counts. */
    C: { rest: 1, lifted: 1.2 },
    /** The texture: follows intensity, and is full while the mix is dimmed. */
    D: { base: 0.6, perIntensity: 0.6, dimmed: 1.3 },
  },
  /** The low-pass over the whole mix while a failure is unread. */
  dim: { openHz: 20_000, dimmedHz: 900, q: 0.3, rampSeconds: 1.2 },
  /** The silence between two plays of a track. */
  silenceSeconds: [8, 20],
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
