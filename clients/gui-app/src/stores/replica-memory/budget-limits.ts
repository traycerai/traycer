/** Per-window hydrated-body ceiling. The process-wide chat-windows pool is a multiple of this unit. */
export const TRANSCRIPT_WINDOW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Hot-doc working-set count cap. The artifact-room tier's
 * `ARTIFACT_ROOM_LEASE_POLICY.maxMaterialized` is this value - imported, not copied.
 */
export const HOT_DOCS_MAX_MATERIALIZED = 32;

/**
 * Live-epic count cap. The session registry's `DEFAULT_MAX_LIVE_EPICS` is
 * this value. T4 re-exports it; this is the one definition.
 */
export const EPIC_REPLICAS_MAX_LIVE = 5;

/** Public alias the epic session registry already exports. Same binding. */
export const DEFAULT_MAX_LIVE_EPICS = EPIC_REPLICAS_MAX_LIVE;

/**
 * Fraction of a plane's soft limit at which pressure becomes `"near"`. Planes stop growing eagerly
 * (drop a prefetch) before anything is thrown away.
 */
export const DEFAULT_NEAR_THRESHOLD_RATIO = 0.8;

/** Process-wide chat-window pool. Replaces the per-chat 8 MiB constant as the *sole* governor. */
export const CHAT_WINDOWS_SOFT_LIMIT_BYTES = 4 * TRANSCRIPT_WINDOW_MAX_BYTES;

export const HOT_DOCS_BYTES_PER_ROOM_ALLOWANCE = 2 * 1024 * 1024;

export const HOT_DOCS_SOFT_LIMIT_BYTES =
  HOT_DOCS_MAX_MATERIALIZED * HOT_DOCS_BYTES_PER_ROOM_ALLOWANCE;

/** Per-epic observational allowance. */
export const EPIC_REPLICA_BYTES_PER_EPIC_ALLOWANCE = 32 * 1024 * 1024;

export const EPIC_REPLICAS_SOFT_LIMIT_BYTES =
  EPIC_REPLICAS_MAX_LIVE * EPIC_REPLICA_BYTES_PER_EPIC_ALLOWANCE;

/**
 * Sum of the three plane soft limits. Observed, never enforced - a global hard ceiling would
 * reintroduce the livelock at a level where no plane can see which protection is blocking it.
 */
export const OBSERVED_RENDERER_CEILING_BYTES =
  CHAT_WINDOWS_SOFT_LIMIT_BYTES +
  HOT_DOCS_SOFT_LIMIT_BYTES +
  EPIC_REPLICAS_SOFT_LIMIT_BYTES;
