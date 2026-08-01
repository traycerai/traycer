import { useEffect } from "react";
import type { ChatDurableCache } from "@/stores/chats/chat-durable-cache";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";

interface ScopedOpenState {
  readonly openIds: ReadonlySet<string>;
  readonly setOpen: (scope: string, segmentId: string, open: boolean) => void;
}

interface ScopedOpenStoreApi {
  readonly getState: () => ScopedOpenState;
}

export function readScopedIds(
  openIds: ReadonlySet<string>,
  prefix: string,
): ReadonlySet<string> {
  const scoped = new Set<string>();
  for (const scopedId of openIds) {
    if (scopedId.startsWith(prefix)) scoped.add(scopedId.slice(prefix.length));
  }
  return scoped;
}

/**
 * Seeds a global scope-prefixed open store (tool-open-store.ts /
 * subagent-open-store.ts - one flat `Set<"scope\0segmentId">` shared by
 * every open chat tab) from its durable chat-key snapshot, exactly once per
 * tab (ticket 15; decision #29).
 *
 * Ticket 15 review round 3 (mandated simplification): this hook now owns
 * ONLY the restore-on-mount half - the durable COMMIT moved entirely to the
 * canvas close sweep's promotion choke point (store.ts), which reads
 * `openIds` directly and works whether or not this hook's owning component
 * ever mounted (an inactive/background tab may close without ever
 * rendering). That let two mechanisms be deleted here: the "ignore an
 * empty transition" ref (round 2's fix for the sweep's `reset()` racing a
 * continuous mirror - moot once there is no mirror) and the unmount commit
 * itself.
 *
 * `initializedScopes` (exported per-registry alongside its durable cache)
 * replaces the old "is my scope already non-empty" seed guard: "empty" is
 * a legitimate, already-initialized state (a chat reopened with everything
 * genuinely collapsed) and must not be re-seeded from a stale durable
 * snapshot just because it reads as empty. Marking BEFORE reading avoids
 * re-seeding on a second render of the same mount (React may re-invoke
 * effects); the canvas sweep clears the tab's entry from this same set once
 * the tab actually closes, so it does not grow unbounded.
 */
export function useChatScopedOpenStoreDualKeySeed(
  store: ScopedOpenStoreApi,
  identity: ChatTabPersistenceIdentity,
  durableCache: ChatDurableCache<ReadonlySet<string>>,
  initializedScopes: Set<string>,
): void {
  useEffect(() => {
    const tabKey = identity.tileInstanceId;
    if (initializedScopes.has(tabKey)) return;
    initializedScopes.add(tabKey);
    const durable = durableCache.get(identity);
    if (durable === undefined) return;
    for (const segmentId of durable) {
      store.getState().setOpen(tabKey, segmentId, true);
    }
  }, [store, identity, durableCache, initializedScopes]);
}
