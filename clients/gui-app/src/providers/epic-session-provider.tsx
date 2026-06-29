import {
  use,
  useEffect,
  useEffectEvent,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { EpicStreamClient } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAuthService } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { updateEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import {
  claimDesktopEpicOwnership,
  getDesktopEpicOwnershipBridge,
  releaseDesktopEpicOwnership,
} from "@/lib/windows/desktop-epic-ownership";
import {
  EpicSessionContext,
  getEpicStreamClientFactoryOverride,
  getOpenEpicRegistry,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";

export interface EpicSessionProviderProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}

interface MountedSessionState {
  readonly key: string;
  readonly handle: OpenEpicStoreHandle;
}

export function EpicSessionProvider(
  props: EpicSessionProviderProps,
): ReactNode {
  const { epicId, tabId, children } = props;
  // The session OWNS its durable transport: the factory built in the acquire
  // effect opens it (socket + auth + wake) and the returned handle's `close()`
  // tears it down on dispose. A host restart under a STABLE `hostId` is healed
  // by the durable transport itself (live endpoint + wake re-dial), not by a
  // provider-driven re-subscribe; a `hostId` CHANGE releases the session below.
  const openTransport = useDurableStreamTransportFactory();
  const activeHostId = useReactiveActiveHostId();
  const authService = useAuthService();
  const queryClient = use(QueryClientContext);
  const navigate = useNavigate();
  const desktopBridge = getDesktopEpicOwnershipBridge();
  // Persisted state (`lastFocusedArtifactId`) is bucketed under the active
  // user's email so a different signed-in identity on this device cannot
  // restore prior-user focus state. Email is the only stable identity field
  // surfaced through `AuthProfile`; null means signed-out / hydrating.
  const sessionUserId = useAuthStore((state) => state.profile?.email ?? null);
  const cloudTasksUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );

  // When the host terminates the epic stream with `UNAUTHORIZED`, the
  // current context bearer is no longer accepted. Re-validate the live
  // RequestContext: AuthnV3 either confirms/rotates it (transient host
  // miss; a future reconnect will succeed) or rejects it (cascade to sign-out
  // so the user can re-authenticate). This is an event emitted by the acquired
  // session, not a reason to reacquire the session if the auth service object
  // changes identity.
  const onAuthError = useEffectEvent((): void => {
    void authService.revalidateCurrentContext();
  });

  const ownershipKey =
    desktopBridge === null
      ? "browser"
      : `${desktopBridge.windowId}\x1f${epicId}\x1f${tabId}`;
  const [claimedOwnershipKey, setClaimedOwnershipKey] = useState<string | null>(
    () => (desktopBridge === null ? ownershipKey : null),
  );
  const ownershipClaimed =
    desktopBridge === null || claimedOwnershipKey === ownershipKey;

  // Desktop only: claim single-window ownership before acquiring a live epic
  // session. The provider still renders its children while this guard runs;
  // session-bound slots see a null context and show their own loading content.
  useEffect(() => {
    if (desktopBridge === null) return;

    const lifecycle = { cancelled: false };
    let claimHeld = false;
    void (async () => {
      const claim = await claimDesktopEpicOwnership(tabId, epicId);
      if (lifecycle.cancelled) {
        if (claim.ok) {
          await releaseDesktopEpicOwnership(tabId);
        }
        return;
      }
      if (claim.ok) {
        claimHeld = true;
        setClaimedOwnershipKey(ownershipKey);
        return;
      }
      const cleanupPatch = useEpicCanvasStore.getState().discardTabState(tabId);
      if (cleanupPatch !== null) {
        await desktopBridge.perWindowState.update(cleanupPatch);
      }
      getOpenEpicRegistry().release(epicId);
      await desktopBridge.requestFocus(claim.currentOwner);
      void navigate({ to: "/epics", replace: true });
    })();

    return () => {
      lifecycle.cancelled = true;
      if (claimHeld) {
        void releaseDesktopEpicOwnership(tabId);
      }
    };
  }, [desktopBridge, epicId, navigate, ownershipKey, tabId]);

  const sessionKey = `${epicId}\x1f${activeHostId ?? "host:none"}\x1f${sessionUserId ?? "user:none"}`;
  const [session, setSession] = useState<MountedSessionState | null>(null);

  useEffect(() => {
    if (!ownershipClaimed) return;
    // A null active host means the directory has not bound a default host yet
    // (initial hydration race, or a transient gap while a host restarts /
    // re-provisions). The session factory needs a concrete `hostId` to open its
    // durable transport, so defer acquisition until the host binds: bail WITHOUT
    // touching the registry (a transient null must not tear down a healthy warm
    // session), and let the effect re-run when `activeHostId` becomes non-null
    // (it is a dependency below) to acquire the real session. Without this gate
    // the factory throws synchronously inside `createOpenEpicStore`, and the
    // throw escapes this effect to the root error boundary - tearing down the
    // whole app, the exact failure class this stream rework set out to remove.
    if (activeHostId === null) return;
    const lifecycle = { cancelled: false };
    const registry = getOpenEpicRegistry();
    const existing = registry.get(epicId);
    if (existing !== null) {
      const existingHostId = handleHostIds.get(existing) ?? null;
      if (
        existing.userId !== sessionUserId ||
        existingHostId !== activeHostId
      ) {
        registry.release(epicId);
      }
    }
    const handleSessionAuthError = (): void => {
      onAuthError();
    };
    // The session OWNS its transport: the factory opens it (socket + auth +
    // wake) and the returned handle's `close()` tears it all down on dispose.
    // The registry only closes the handle when it DISPOSES the session, so the
    // socket survives across the MRU warm window and a revived session is never
    // handed a dead transport; the durable transport's live endpoint + wake
    // re-dial heal a host restart under a stable `hostId` on their own. Tests
    // drive the stream through the override seam and never open a real socket.
    const streamClientFactory: EpicStreamClientFactory = (
      factoryEpicId,
      callbacks,
    ) => {
      const override = getEpicStreamClientFactoryOverride();
      if (override !== null) {
        return override(factoryEpicId, callbacks);
      }
      // `activeHostId` is non-null here: the acquire effect gates on it above,
      // and it is a `const`, so that narrowing flows into this factory closure.
      // Removing the gate would surface a compile error at this call (which
      // requires a concrete `hostId`), not a runtime throw - the type system is
      // the invariant.
      const result = openOwnedDurableStreamClient(
        openTransport,
        activeHostId,
        (ws) =>
          new EpicStreamClient({
            wsStreamClient: ws,
            epicId: factoryEpicId,
            callbacks,
          }),
      );
      return {
        applyUpdate: (updateBytes) => result.client.applyUpdate(updateBytes),
        awareness: (awarenessBytes) => result.client.awareness(awarenessBytes),
        applyArtifactRoomUpdate: (artifactRoomId, updateBytes) =>
          result.client.applyArtifactRoomUpdate(artifactRoomId, updateBytes),
        artifactRoomAwareness: (artifactRoomId, awarenessBytes) =>
          result.client.artifactRoomAwareness(artifactRoomId, awarenessBytes),
        retryMigration: () => result.client.retryMigration(),
        close: result.close,
      };
    };
    const nextHandle = registry.acquireMounted(epicId, (id) =>
      createOpenEpicStore({
        epicId: id,
        streamClientFactory,
        userId: sessionUserId,
        onAuthError: handleSessionAuthError,
      }),
    );
    handleHostIds.set(nextHandle, activeHostId);
    queueMicrotask(() => {
      if (lifecycle.cancelled) return;
      setSession({ key: sessionKey, handle: nextHandle });
    });

    return () => {
      lifecycle.cancelled = true;
      getOpenEpicRegistry().releaseMounted(epicId);
    };
  }, [
    activeHostId,
    epicId,
    openTransport,
    ownershipClaimed,
    sessionKey,
    sessionUserId,
  ]);

  const handle =
    ownershipClaimed && session?.key === sessionKey ? session.handle : null;
  useCloudTaskTitleCacheSync({
    activeHostId,
    epicId,
    handle,
    queryClient,
    userId: cloudTasksUserId,
  });

  return (
    <EpicSessionContext.Provider value={handle}>
      {children}
    </EpicSessionContext.Provider>
  );
}

interface CloudTaskTitleCacheSyncArgs {
  readonly activeHostId: string | null;
  readonly epicId: string;
  readonly handle: OpenEpicStoreHandle | null;
  readonly queryClient: QueryClient | undefined;
  readonly userId: string | null;
}

function useCloudTaskTitleCacheSync(args: CloudTaskTitleCacheSyncArgs): void {
  const { activeHostId, epicId, handle, queryClient, userId } = args;
  useEffect(() => {
    if (activeHostId === null) return;
    if (handle === null) return;
    if (queryClient === undefined) return;
    if (userId === null) return;

    let lastSyncedTitle: string | null = null;
    const syncTitle = (): void => {
      const title = normalizeGeneratedTitle(handle.store.getState().epic.title);
      if (title === null || title === lastSyncedTitle) return;
      lastSyncedTitle = title;
      updateEpicTitleInCloudTaskCaches(
        queryClient,
        { hostId: activeHostId, userId },
        epicId,
        title,
      );
    };

    syncTitle();
    return handle.store.subscribe(syncTitle);
  }, [activeHostId, epicId, handle, queryClient, userId]);
}

function normalizeGeneratedTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}
