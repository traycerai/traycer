import {
  createContext,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  DEFAULT_MAX_LIVE_EPICS,
  OpenEpicSessionRegistry,
} from "@/stores/epics/open-epic/session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicStreamClientFactory,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { releaseDesktopEpicOwnershipForEpic } from "@/lib/windows/desktop-epic-ownership";

export const EpicSessionContext = createContext<OpenEpicStoreHandle | null>(
  null,
);

/**
 * The RPC client resolved for the same host that owns `EpicSessionContext`.
 * Session-level provisioning prevents sidebar rows from independently mounting
 * host-directory subscriptions just to address the same Epic host.
 */
export const EpicSessionHostClientContext =
  createContext<HostClient<HostRpcRegistry> | null>(null);

export const handleHostIds = new WeakMap<OpenEpicStoreHandle, string | null>();
// Owner-identity discriminator (R-1), tracked separately from `handleHostIds`
// so a same-host remote public-key rotation - which `activeHostId` alone
// cannot see - also forces the acquire effect to close the stale durable
// stream and mount a fresh session, instead of leaving it pinned to the
// stale key.
export const handleOwnerIdentityKeys = new WeakMap<
  OpenEpicStoreHandle,
  string | null
>();

export function getEpicSessionHandleHostId(
  handle: OpenEpicStoreHandle,
): string | null {
  return handleHostIds.get(handle) ?? null;
}

/**
 * Registry is module-scoped so background Epic tabs survive route transitions
 * - a tab that is navigated away from but kept open in the tab strip stays
 * live (within the MRU cap) so re-entering the route is instant.
 */
export const registry = new OpenEpicSessionRegistry({
  maxLive: DEFAULT_MAX_LIVE_EPICS,
});
registry.setReleaseListener((epicId) => {
  void releaseDesktopEpicOwnershipForEpic(epicId);
});

/**
 * Test / production seam. Defaults to real `EpicStreamClient`; tests swap
 * via `__setEpicStreamClientFactoryForTests(...)` so the provider can be
 * mounted in jsdom without a live host.
 */
let streamClientFactoryOverride: EpicStreamClientFactory | null = null;

export function __setEpicStreamClientFactoryForTests(
  factory: EpicStreamClientFactory | null,
): void {
  streamClientFactoryOverride = factory;
}

export function getEpicStreamClientFactoryOverride(): EpicStreamClientFactory | null {
  return streamClientFactoryOverride;
}

export function __getOpenEpicRegistryForTests(): OpenEpicSessionRegistry {
  return registry;
}

/**
 * Accessor for the module-scoped live-Epic registry. T8 (desktop
 * app-quit intercept) subscribes to this so it can read the aggregated
 * unsynced-edits map without reaching into provider-local state.
 */
export function getOpenEpicRegistry(): OpenEpicSessionRegistry {
  return registry;
}

const EMPTY_LIVE_CHAT_IDS: ReadonlyArray<string> = [];

/**
 * The chat ids that still exist in the currently-live sessions for a set of
 * task tabs. Notification task rollups use this as a whitelist: deleting a
 * chat removes its id here immediately, so its historical notification can
 * stay in the bell without continuing to bubble up to the task tab.
 */
export function useLiveChatIdsForEpics(
  epicIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const canonicalEpicIds = useMemo(
    () =>
      [...new Set(epicIds)].sort((left, right) => left.localeCompare(right)),
    [epicIds],
  );
  const snapshotCache = useRef<{
    readonly signature: string;
    readonly chatIds: ReadonlyArray<string>;
  } | null>(null);
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      let storeUnsubscribers: Array<() => void> = [];
      const bindStores = (): void => {
        for (const unsubscribe of storeUnsubscribers) unsubscribe();
        storeUnsubscribers = canonicalEpicIds.flatMap((epicId) => {
          const handle = registry.peek(epicId);
          return handle === null ? [] : [handle.store.subscribe(listener)];
        });
      };
      bindStores();
      const unsubscribeRegistry = registry.subscribe(() => {
        bindStores();
        listener();
      });
      return () => {
        unsubscribeRegistry();
        for (const unsubscribe of storeUnsubscribers) unsubscribe();
      };
    },
    [canonicalEpicIds],
  );
  const getSnapshot = useCallback((): ReadonlyArray<string> => {
    const chatIds = canonicalEpicIds.flatMap(
      (epicId) => registry.peek(epicId)?.store.getState().chats.allIds ?? [],
    );
    const snapshot = [...new Set(chatIds)].sort((left, right) =>
      left.localeCompare(right),
    );
    const signature = JSON.stringify(snapshot);
    const cached = snapshotCache.current;
    if (cached?.signature === signature) return cached.chatIds;
    snapshotCache.current = { signature, chatIds: snapshot };
    return snapshot;
  }, [canonicalEpicIds]);
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_LIVE_CHAT_IDS,
  );
}

/**
 * True when the Epic session for `epicId` currently has unsynced edits
 * that the host has not yet proven coverage for. Called synchronously
 * from the tab-close handler to decide whether to pop the discard-
 * confirmation dialog.
 */
export function epicHasUnsyncedEdits(epicId: string): boolean {
  const handle = registry.get(epicId);
  if (handle === null) return false;
  return handle.store.getState().isDirty;
}

/**
 * Release (forcibly dispose) the Epic session for `epicId`. Called when the
 * user closes a tab in the strip.
 */
export function releaseOpenEpicSession(epicId: string): void {
  registry.release(epicId);
}

export function releaseOpenEpicSessionIfUnused(epicId: string): void {
  const state = useEpicCanvasStore.getState();
  const stillOpen = state.openTabOrder.some(
    (tabId) => state.tabsById[tabId]?.epicId === epicId,
  );
  if (stillOpen) return;
  releaseOpenEpicSession(epicId);
}

/**
 * Forcibly dispose every live Epic session. Wired into the auth lifecycle so
 * sign-out, user-switch, or token expiry cannot leave a prior identity's
 * Y.Doc / queue / focus state behind in the registry - the next sign-in
 * starts fresh from a host snapshot.
 */
export function disposeAllOpenEpicSessions(): void {
  registry.disposeAll();
}
