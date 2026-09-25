import { getRetentionProfile } from "@/stores/replica-memory/retention-profile";
import { flattenStripItemRefs, tabRefKey } from "@/stores/tabs/layout";
import { useTabsStore, type TabsStoreState } from "@/stores/tabs/store";

/**
 * The top-level surfaces kept mounted PAST the retention window for a short
 * while after the user navigated away from them - the grace half of the
 * retention policy in `top-level-surface-retention.ts`.
 *
 * ## Why a grace and not a bigger window
 *
 * The phone retains one surface: the one on screen. That is the footprint
 * win, and it makes Back a full re-mount of the task just left, which is the
 * gesture most likely to follow a navigation. A second retained slot would
 * keep that surface for as long as the user stays anywhere else - a whole
 * hidden task screen held for an hour of reading another one. The grace keeps
 * it for `RetentionProfile.topLevelSurfaceGraceMs` instead, and after that the
 * surface goes the way anything past the window goes: its DOM is dropped, its
 * session stays warm.
 *
 * ## Only the LAST departure
 *
 * A new navigation replaces the grace set rather than adding to it, so a user
 * stepping through three tasks inside the window holds one extra surface, not
 * two. The grace answers "Back", and Back only ever returns to the surface just
 * left.
 *
 * ## One ledger, two readers
 *
 * `TopLevelTabHost` (what is mounted) and `tile-surface-membership.ts` (which
 * hosted chat bodies are kept) both extend their retained set with
 * {@link getTopLevelSurfaceGraceKeys}. They must agree: a surface kept in grace
 * whose hosted chat body was released would re-mount the transcript on the way
 * back anyway, which is most of the cost the grace exists to avoid.
 *
 * The ledger is fed from its own `useTabsStore` subscription, registered at
 * import. Both readers import this module, so it is evaluated - and subscribed -
 * before either of them, and zustand runs listeners in subscription order: by
 * the time either reader sees an active-set change, the surface that change
 * left is already in grace. There is no frame in which it is unmounted and then
 * re-mounted.
 *
 * ## Expiry is a real update
 *
 * A timer ends the grace by publishing a NEW snapshot and notifying
 * subscribers. Readers take the set from this module's return value
 * (`useSyncExternalStore` in the host), never from a clock read at render
 * time, so a memoizing compiler has an input that actually moves when the
 * grace ends.
 */

const EMPTY_GRACE_KEYS: ReadonlySet<string> = new Set();

let lastActiveKeys: ReadonlyArray<string> = [];
let graceKeys: ReadonlySet<string> = EMPTY_GRACE_KEYS;
let expiryTimer: number | null = null;
const listeners = new Set<() => void>();

function activeRefKeysOf(state: TabsStoreState): ReadonlyArray<string> {
  const activeItem =
    state.items.find((item) => item.id === state.activeItemId) ?? null;
  return activeItem === null
    ? []
    : flattenStripItemRefs(activeItem).map(tabRefKey);
}

function publish(next: ReadonlySet<string>): void {
  graceKeys = next;
  listeners.forEach((listener) => listener());
}

function clearExpiryTimer(): void {
  if (expiryTimer === null) return;
  window.clearTimeout(expiryTimer);
  expiryTimer = null;
}

function observeActiveKeys(activeKeys: ReadonlyArray<string>): void {
  const departed = lastActiveKeys.filter((key) => !activeKeys.includes(key));
  lastActiveKeys = activeKeys;
  const graceMs = getRetentionProfile().topLevelSurfaceGraceMs;
  if (departed.length > 0 && graceMs > 0) {
    clearExpiryTimer();
    expiryTimer = window.setTimeout(() => {
      expiryTimer = null;
      publish(EMPTY_GRACE_KEYS);
    }, graceMs);
    publish(new Set(departed));
    return;
  }
  // A surface that is active again - a split that took it back in with nothing
  // leaving - is out of its grace: the ledger only ever names surfaces that are
  // off screen, and readers rely on that.
  const remaining = [...graceKeys].filter((key) => !activeKeys.includes(key));
  if (remaining.length === graceKeys.size) return;
  if (remaining.length === 0) clearExpiryTimer();
  publish(remaining.length === 0 ? EMPTY_GRACE_KEYS : new Set(remaining));
}

/**
 * The surfaces in their grace, as kind-qualified `TabRef` keys. Never an
 * active surface. A new object whenever the set changes, so it is a valid
 * `useSyncExternalStore` snapshot.
 */
export function getTopLevelSurfaceGraceKeys(): ReadonlySet<string> {
  return graceKeys;
}

export function subscribeTopLevelSurfaceGrace(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Ends every grace now and re-bases on the store's current active set. Tests
 * only: a grace left running by one case would keep a surface mounted in the
 * next.
 */
export function resetTopLevelSurfaceGraceForTesting(): void {
  clearExpiryTimer();
  lastActiveKeys = activeRefKeysOf(useTabsStore.getState());
  publish(EMPTY_GRACE_KEYS);
}

lastActiveKeys = activeRefKeysOf(useTabsStore.getState());
useTabsStore.subscribe((state) => {
  observeActiveKeys(activeRefKeysOf(state));
});
