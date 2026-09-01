/**
 * Host-upsert debounce. Cloud publication coalesces separately on the host
 * (~15–30s, decision log #10); this interval is the same-host live path
 * ("within one debounce interval" in the client-plan acceptance).
 */
export const DRAFT_UPSERT_DEBOUNCE_MS = 500;
export const DRAFT_UPSERT_MAX_WAIT_MS = 2_000;
/** First retry after a failed upsert; doubles each attempt up to the cap. */
export const DRAFT_UPSERT_RETRY_BACKOFF_MS = 1_000;
export const DRAFT_UPSERT_MAX_RETRY_BACKOFF_MS = 15_000;

export interface DraftMirrorTiming {
  readonly debounceMs: number;
  readonly maxWaitMs: number;
  readonly retryBackoffMs: number;
  readonly maxRetryBackoffMs: number;
}

export const DEFAULT_DRAFT_MIRROR_TIMING: DraftMirrorTiming = {
  debounceMs: DRAFT_UPSERT_DEBOUNCE_MS,
  maxWaitMs: DRAFT_UPSERT_MAX_WAIT_MS,
  retryBackoffMs: DRAFT_UPSERT_RETRY_BACKOFF_MS,
  maxRetryBackoffMs: DRAFT_UPSERT_MAX_RETRY_BACKOFF_MS,
};
