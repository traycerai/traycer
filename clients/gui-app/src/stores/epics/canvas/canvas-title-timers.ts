/**
 * Title-generation pending state: the in-flight entry shape, the 30s crash/reconnect backstop
 * timers, and the visibility predicates the selector hooks consume.
 */

export const TITLE_GENERATION_PENDING_TIMEOUT_MS = 30_000;
type PendingTitleTimer = number;

export interface PendingTitleEntry {
  readonly expectedTitle: string;
  readonly startedAt: number;
}

export const epicTitleTimers = new Map<string, PendingTitleTimer>();
export const chatTitleTimers = new Map<string, PendingTitleTimer>();

// Normal completion is observed through the title record's `updatedAt`. The timer is only a
// crash/reconnect backstop for a host run that never applies a title update.
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
 * Whether the title-generation spinner should still show for a pending entry. The spinner is
 * anchored on "title not yet generated + gen in flight".
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

export function pendingTitleVisibleAutoPurge(
  entry: PendingTitleEntry | undefined,
  currentTitle: string | null,
  currentUpdatedAt: number | null,
  clear: () => void,
): boolean {
  const visible = pendingTitleVisible(entry, currentTitle, currentUpdatedAt);
  if (!visible && entry !== undefined) {
    // The microtask lands before paint and well before the 30s timer.
    queueMicrotask(clear);
  }
  return visible;
}
