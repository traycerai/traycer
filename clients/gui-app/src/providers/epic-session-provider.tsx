import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import { EpicStreamClient } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAuthService } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
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
  handleStreamClients,
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
  const wsStreamClient = useWsStreamClient();
  // The open-epic store keeps the factory it was created with for its entire
  // lifetime, but the host's `WsStreamClient` is replaced (under a stable
  // hostId) on every host restart / auth rotation - and the prior client is
  // `close()`d. Resolve the transport through a ref so the factory always
  // subscribes on the CURRENT client; re-subscribing on the captured-then-
  // closed client throws "Cannot subscribe with a closed WsStreamClient" and
  // blanks the canvas. Kept in sync at the top of the session effect below.
  const wsStreamClientRef = useRef(wsStreamClient);
  const activeHostId = useReactiveActiveHostId();
  const authService = useAuthService();
  const navigate = useNavigate();
  const desktopBridge = getDesktopEpicOwnershipBridge();
  // Persisted state (`lastFocusedArtifactId`) is bucketed under the active
  // user's email so a different signed-in identity on this device cannot
  // restore prior-user focus state. Email is the only stable identity field
  // surfaced through `AuthProfile`; null means signed-out / hydrating.
  const userId = useAuthStore((state) => state.profile?.email ?? null);

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

  const sessionKey = `${epicId}\x1f${activeHostId ?? "host:none"}\x1f${userId ?? "user:none"}`;
  const [session, setSession] = useState<MountedSessionState | null>(null);

  useEffect(() => {
    if (!ownershipClaimed) return;
    // Keep the latest transport reachable by the store's long-lived factory.
    wsStreamClientRef.current = wsStreamClient;
    const lifecycle = { cancelled: false };
    const registry = getOpenEpicRegistry();
    const existing = registry.get(epicId);
    if (existing !== null) {
      const existingHostId = handleHostIds.get(existing) ?? null;
      if (existing.userId !== userId || existingHostId !== activeHostId) {
        registry.release(epicId);
      }
    }
    const factory: EpicStreamClientFactory = (factoryEpicId, callbacks) => {
      const override = getEpicStreamClientFactoryOverride();
      if (override !== null) {
        return override(factoryEpicId, callbacks);
      }
      const client = wsStreamClientRef.current;
      if (client === null) {
        throw new Error(
          "EpicSessionProvider: no WsStreamClient available. Ensure <HostStreamProvider> is mounted.",
        );
      }
      return new EpicStreamClient({
        wsStreamClient: client,
        epicId: factoryEpicId,
        callbacks,
      });
    };
    const handleSessionAuthError = (): void => {
      onAuthError();
    };
    const nextHandle = registry.acquireMounted(epicId, (id) =>
      createOpenEpicStore({
        epicId: id,
        streamClientFactory: factory,
        userId,
        onAuthError: handleSessionAuthError,
      }),
    );
    handleHostIds.set(nextHandle, activeHostId);
    // A reused session stays bound to the transport it first subscribed on.
    // A host restart closes that client and hands us a new one under the same
    // hostId, so re-open the stream on the current transport - the dead
    // session never recovers on its own. A freshly created handle already
    // subscribed on the live client (recorded below), so this only fires for a
    // genuine transport swap, never the initial open.
    if (wsStreamClient !== null) {
      const boundClient = handleStreamClients.get(nextHandle) ?? null;
      if (boundClient !== null && boundClient !== wsStreamClient) {
        nextHandle.requestFreshSnapshot();
      }
      handleStreamClients.set(nextHandle, wsStreamClient);
    }
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
    ownershipClaimed,
    sessionKey,
    userId,
    wsStreamClient,
  ]);

  const handle =
    ownershipClaimed && session?.key === sessionKey ? session.handle : null;

  return (
    <EpicSessionContext.Provider value={handle}>
      {children}
    </EpicSessionContext.Provider>
  );
}
