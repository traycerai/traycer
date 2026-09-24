/**
 * "Hydrated for the signed-in account" for the Identities-tab store.
 *
 * The store boots on the ANONYMOUS bucket and reports `persist.hasHydrated()`
 * as soon as that bucket has loaded - which is synchronous, and says nothing
 * about the account's own bucket, since `IdentityTabsPersistLifecycleBridge`
 * only retargets it once auth settles beneath `HostRuntimeProvider`. Two
 * consumers read the source records BEFORE that and would otherwise judge the
 * account's tabs absent from an empty anonymous bucket:
 *
 * - the desktop windows bridge, which sanitizes a restored strip layout
 *   against the source records and drops an identity ref it cannot find
 *   (the later account hydration re-adds the tab, but as a plain trailing
 *   tab - placement, splits and the active selection are gone);
 * - the history pruner, which prunes an `/identities/$id` entry whose tab is
 *   not held.
 *
 * So this latch, not `persist.hasHydrated()`, is what those gates wait on.
 * The bridge marks it after applying the first settled auth state (retarget
 * on sign-in, detach on sign-out, or an initially signed-out session), the
 * same shape as `lib/tab-sync/browser-canvas-hydration.ts` for the canvas.
 * Later account switches retarget synchronously, so a one-shot latch is
 * enough: once the store follows the account it never stops.
 */
let hydrated = false;
let resolveHydration: (() => void) | null = null;
const listeners = new Set<() => void>();
let hydration = createHydrationPromise();

function createHydrationPromise(): Promise<void> {
  return new Promise<void>((resolve) => {
    resolveHydration = resolve;
  });
}

/** Resolves once the store follows the signed-in account (or its absence). */
export function identityTabsHydration(): Promise<void> {
  return hydration;
}

export function isIdentityTabsHydrated(): boolean {
  return hydrated;
}

export function subscribeIdentityTabsHydration(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function markIdentityTabsHydrated(): void {
  if (hydrated) return;
  hydrated = true;
  resolveHydration?.();
  resolveHydration = null;
  for (const listener of listeners) listener();
}

/** Re-arms the latch so one suite can exercise the pre-hydration window. */
export function __resetIdentityTabsHydrationForTests(): void {
  hydrated = false;
  hydration = createHydrationPromise();
}
