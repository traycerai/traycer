/**
 * How long the cloud feed holds rows that arrive on the heels of a publish
 * before it publishes again - see `CommGraphCloudSubscriptionManager`'s
 * `requestDataCommit`.
 *
 * EIGHTY MILLISECONDS is about twelve publishes a second under a continuous
 * stream. That is faster than a reader can tell rows apart, so a graph filling
 * from history still visibly fills, and it is one to two orders of magnitude
 * fewer renders than one per wire frame, which is what an epic's history
 * arriving used to cost.
 */
export const COMM_GRAPH_DATA_COMMIT_WINDOW_MS = 80;

/**
 * Tests that drive the feed through the registry set this to zero, which makes
 * every data frame publish as it is applied. They assert on the snapshot in the
 * same tick they pushed the frame in, and that is a statement about the merge,
 * not about when it is published. The window itself is pinned by the manager's
 * own suite, against a manager it constructs with one.
 */
let windowOverrideMs: number | null = null;

export function __setCommGraphDataCommitWindowMsForTests(
  windowMs: number | null,
): void {
  windowOverrideMs = windowMs;
}

/** Read once per manager, when the registry constructs it. */
export function commGraphDataCommitWindowMs(): number {
  return windowOverrideMs ?? COMM_GRAPH_DATA_COMMIT_WINDOW_MS;
}
