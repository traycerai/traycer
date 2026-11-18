/**
 * Keep a per-handle subscription map in lockstep with a changing set of store
 * handles: drop subscriptions for handles that disappeared, add one for each
 * new handle via `subscribeOne`, and leave survivors untouched (no churn).
 *
 * Shared by the agent-activity monitor and the chat turn-completion subscribers so
 * the registry-membership diff lives in exactly one place. `subscribeOne` owns
 * whatever per-handle state and listener it needs and returns its unsubscribe.
 */
export function reconcileStoreSubscriptions<H>(
  handles: readonly H[],
  subs: Map<H, () => void>,
  subscribeOne: (handle: H) => () => void,
): void {
  const live = new Set<H>(handles);
  for (const [handle, unsubscribe] of subs) {
    if (live.has(handle)) continue;
    unsubscribe();
    subs.delete(handle);
  }
  for (const handle of handles) {
    if (subs.has(handle)) continue;
    subs.set(handle, subscribeOne(handle));
  }
}
