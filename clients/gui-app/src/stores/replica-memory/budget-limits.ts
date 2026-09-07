/**
 * Per-window hydrated-body ceiling. The process-wide chat-windows pool is a
 * multiple of this unit. The window module re-exports it so existing
 * `transcript-window` importers keep working against one definition.
 */
export const TRANSCRIPT_WINDOW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Hot-doc working-set count cap. The artifact-room tier's
 * `ARTIFACT_ROOM_LEASE_POLICY.maxMaterialized` is this value — imported, not
 * copied. At 8 the LRU evicted on ordinary scrolling; treat a lower value as
 * a regression.
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
 * Fraction of a plane's soft limit at which pressure becomes `"near"`.
 * Planes stop growing eagerly (drop a prefetch) before anything is thrown
 * away. Same ratio the chat plane already used implicitly: eviction runs at
 * the limit, and nothing special happens in the band below it.
 */
export const DEFAULT_NEAR_THRESHOLD_RATIO = 0.8;

/**
 * Process-wide chat-window pool.
 *
 * Replaces the per-chat 8 MiB constant as the *sole* governor. The per-window
 * constant still stands as the unit a single window evicts toward; this pool
 * is what stops N leased sessions from each holding that unit independently.
 * Sized at 4× so a handful of hydrated chats fit before any of them has to
 * shrink, matching the original "ordinary scrolling should not thrash" goal
 * at process scale.
 */
export const CHAT_WINDOWS_SOFT_LIMIT_BYTES = 4 * TRANSCRIPT_WINDOW_MAX_BYTES;

/**
 * Per-room byte allowance used to turn `MAX_HOT_ARTIFACT_ROOMS` (the count
 * cap, 32) into a byte budget input. Encoded cold form of a typical artifact
 * body is far smaller; this is live-CRDT overage headroom so ordinary
 * scrolling of 32 modest bodies stays under, and a few huge bodies still
 * trigger the *tier's existing LRU* rather than a second budget.
 */
export const HOT_DOCS_BYTES_PER_ROOM_ALLOWANCE = 2 * 1024 * 1024;

export const HOT_DOCS_SOFT_LIMIT_BYTES =
  HOT_DOCS_MAX_MATERIALIZED * HOT_DOCS_BYTES_PER_ROOM_ALLOWANCE;

/**
 * Per-epic observational allowance. The root replica floor is measured, not
 * evicted, while `@1` is the wire (honesty constraint: Phase 1 cannot
 * control it). {@link EPIC_REPLICAS_MAX_LIVE} is the count input.
 */
export const EPIC_REPLICA_BYTES_PER_EPIC_ALLOWANCE = 32 * 1024 * 1024;

export const EPIC_REPLICAS_SOFT_LIMIT_BYTES =
  EPIC_REPLICAS_MAX_LIVE * EPIC_REPLICA_BYTES_PER_EPIC_ALLOWANCE;

/**
 * Sum of the three plane soft limits. Observed, never enforced — a global
 * hard ceiling would reintroduce the livelock at a level where no plane can
 * see which protection is blocking it.
 */
export const OBSERVED_RENDERER_CEILING_BYTES =
  CHAT_WINDOWS_SOFT_LIMIT_BYTES +
  HOT_DOCS_SOFT_LIMIT_BYTES +
  EPIC_REPLICAS_SOFT_LIMIT_BYTES;
