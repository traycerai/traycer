/**
 * Title-generation pending state: the in-flight entry shape, the 30s
 * crash/reconnect backstop timers, and the visibility predicates the
 * selector hooks consume. Extracted from `store.ts`; the store actions
 * (`markEpicTitlePending` etc.) own WHEN to schedule/clear, this module
 * owns the timer bookkeeping itself.
 */

export const TITLE_GENERATION_PENDING_TIMEOUT_MS = 30_000;
type PendingTitleTimer = number;

export interface PendingTitleEntry {
  readonly expectedTitle: string;
  readonly startedAt: number;
}

export const epicTitleTimers = new Map<string, PendingTitleTimer>();
export const chatTitleTimers = new Map<string, PendingTitleTimer>();

// Normal completion is observed through the title record's `updatedAt`.
// The timer is only a crash/reconnect backstop for a host run that never
// applies a title update.
export function scheduleTitlePendingClear(
  timers: Map<string, PendingTitleTimer>,
  id: string,
  clear: () => void,
): void {
  clearScheduledTitlePending(timers, id);
  timers.set(id, window.setTimeout(clear, TITLE_GENERATION_PENDING_TIMEOUT_MS));
}

export function clearScheduledTitlePending(
  timers: Map<string, PendingTitleTimer>,
  id: string,
): void {
  const timer = timers.get(id);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  timers.delete(id);
}

export function clearAllScheduledTitlePending(
  timers: Map<string, PendingTitleTimer>,
): void {
  timers.forEach((timer) => window.clearTimeout(timer));
  timers.clear();
}

/**
 * Whether the title-generation spinner should still show for a pending entry.
 *
 * The spinner is anchored on "title not yet generated + gen in flight". Two
 * ways the anchor settles (either hides the spinner):
 *
 * 1. A title write landed at/after generation started
 *    (`currentUpdatedAt >= startedAt`).
 * 2. The projected title is no longer the pre-generation value: anything other
 *    than empty (`currentTitle === null`) or the recorded `expectedTitle`.
 *
 * For the empty-store flow (epic create), `expectedTitle` is `""` and the
 * projected live title is `null` while the stored title is empty, so the
 * spinner shows during generation and clears the moment a non-empty AI title is
 * projected. The `currentTitle === expectedTitle` clause covers callers that
 * anchor on a non-empty placeholder. The 30s backstop timer guarantees no
 * permanently stuck spinner if a host run never applies a title update.
 */
export function pendingTitleVisible(
  entry: PendingTitleEntry | undefined,
  currentTitle: string | null,
  currentUpdatedAt: number | null,
): boolean {
  if (entry === undefined) return false;
  if (currentUpdatedAt !== null && currentUpdatedAt >= entry.startedAt) {
    return false;
  }
  return currentTitle === null || currentTitle === entry.expectedTitle;
}

/**
 * Like {@link pendingTitleVisible}, but when the projected title/updatedAt
 * have settled the expectation, this also fires `clear()` so the in-memory
 * pending entry and its 30s backstop timer get released immediately rather
 * than waiting for the timer to fire as a no-op.
 *
 * `clear()` MUST be idempotent: this runs on every render of the consuming
 * selector hook, so a second call after the entry is gone is a no-op by
 * design.
 */
export function pendingTitleVisibleAutoPurge(
  entry: PendingTitleEntry | undefined,
  currentTitle: string | null,
  currentUpdatedAt: number | null,
  clear: () => void,
): boolean {
  const visible = pendingTitleVisible(entry, currentTitle, currentUpdatedAt);
  if (!visible && entry !== undefined) {
    // Defer to a microtask: triggering a Zustand `set` from inside a
    // selector callback breaks React's rules-of-rendering (the
    // subscription would re-fire during the render that just observed
    // the old value). The microtask lands before paint and well before
    // the 30s timer.
    queueMicrotask(clear);
  }
  return visible;
}
