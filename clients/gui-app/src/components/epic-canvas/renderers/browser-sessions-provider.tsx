import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  authenticatedHostStreamKey,
  authenticatedOwnerIdentityKey,
} from "@/hooks/host/use-host-stream-client-for";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import {
  acquireBrowserSessionsCoordinator,
  browserSessionsCoordinatorKey,
  browserSessionsCoordinatorState,
  hasBrowserSessionsCoordinator,
  subscribeToBrowserSessionsCoordinator,
  upsertBrowserSessionsCoordinatorConsumer,
  type BrowserSessionsOwner,
  type BrowserSessionsState,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  BrowserSessionsContext,
  BrowserSessionsCoordinatorKeyContext,
} from "./browser-sessions-context";

function browserSessionsOwnerIdentityKey(
  hostClient: HostClient<HostRpcRegistry> | null,
  hostEntry: HostDirectoryEntry | null,
): string | null {
  return hostClient === null
    ? null
    : authenticatedOwnerIdentityKey(hostClient, hostEntry);
}

export function BrowserSessionsProvider(props: {
  readonly epicId: string;
  readonly children: ReactNode;
}) {
  const hostId = useCanvasHostId();
  const hostClient = useEpicSessionHostClient();
  return (
    <BrowserSessionsHostProvider
      hostId={hostId}
      hostClient={hostClient}
      epicId={props.epicId}
    >
      {props.children}
    </BrowserSessionsHostProvider>
  );
}

export function BrowserSessionsHostProvider(props: {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly children: ReactNode;
}) {
  const runnerHost = useRunnerHost();
  const browserView = runnerHost.browserView;
  const { state: sessions, coordinatorKey } = useBrowserSessions({
    hostId: props.hostId,
    hostClient: props.hostClient,
    epicId: props.epicId,
    browserView,
  });
  return (
    <BrowserSessionsCoordinatorKeyContext.Provider value={coordinatorKey}>
      <BrowserSessionsContext.Provider value={sessions}>
        {props.children}
      </BrowserSessionsContext.Provider>
    </BrowserSessionsCoordinatorKeyContext.Provider>
  );
}

/**
 * Puts a surface on `hostId`'s browser-sessions stream, wrapping only when it
 * needs to: the canvas already provides the canvas host's stream, so re-wrapping
 * for that host would open a second coordinator for the same one.
 *
 * The rule lives here rather than at each call site because three of them had
 * spelled it out separately, and the odd one out resolved its client from a
 * different hook. `useHostClientForHostId` is the one resolution for "which
 * client addresses this host id" - inside a tile it is exactly what
 * `useTabHostClient()` returns, since a tile's `TabHostProvider` is bound to
 * that same ref host.
 */
export function BrowserSessionsHostBoundary(props: {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly children: ReactNode;
}): ReactNode {
  const canvasHostId = useCanvasHostId();
  const hostClient = useHostClientForHostId(props.hostId);
  if (props.hostId === canvasHostId) return props.children;
  return (
    <BrowserSessionsHostProvider
      hostId={props.hostId}
      hostClient={hostClient}
      epicId={props.epicId}
    >
      {props.children}
    </BrowserSessionsHostProvider>
  );
}

interface UseBrowserSessionsArgs {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly browserView: BrowserViewBridge | null;
}

interface BrowserSessionsHookResult {
  readonly state: BrowserSessionsState;
  readonly coordinatorKey: string | null;
}

function useBrowserSessions(
  args: UseBrowserSessionsArgs,
): BrowserSessionsHookResult {
  const { hostId, epicId, browserView } = args;
  const hostEntry = useHostDirectoryEntry(hostId ?? UNKNOWN_HOST_PLACEHOLDER);
  const transportReady =
    args.hostClient !== null &&
    authenticatedHostStreamKey(args.hostClient, hostEntry) !== null;
  const ownerIdentityKey = browserSessionsOwnerIdentityKey(
    args.hostClient,
    hostEntry,
  );
  const openTransport = useDurableStreamTransportFactory();
  const owner = useMemo<BrowserSessionsOwner | null>(
    () =>
      hostId === null || ownerIdentityKey === null
        ? null
        : { hostId, identityKey: ownerIdentityKey },
    [hostId, ownerIdentityKey],
  );
  const ownerCoordinatorKey =
    owner === null ? null : browserSessionsCoordinatorKey(epicId, owner);
  const coordinatorKey =
    ownerCoordinatorKey !== null &&
    (transportReady || hasBrowserSessionsCoordinator(ownerCoordinatorKey))
      ? ownerCoordinatorKey
      : null;
  const [consumerId] = useState(() => Symbol("browser-sessions-consumer"));
  const acquireCoordinator = useEffectEvent(
    (key: string, selectedOwner: BrowserSessionsOwner): (() => void) =>
      acquireBrowserSessionsCoordinator({
        key,
        consumerId,
        epicId,
        owner: selectedOwner,
        runtime: { browserView, openTransport },
        createIfMissing: transportReady,
      }),
  );

  useEffect(() => {
    if (coordinatorKey === null || owner === null) return;
    return acquireCoordinator(coordinatorKey, owner);
  }, [consumerId, coordinatorKey, epicId, owner]);

  useEffect(() => {
    if (coordinatorKey === null) return;
    upsertBrowserSessionsCoordinatorConsumer(coordinatorKey, consumerId, {
      browserView,
      openTransport,
    });
  }, [browserView, consumerId, coordinatorKey, openTransport]);

  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeToBrowserSessionsCoordinator(coordinatorKey, listener),
    [coordinatorKey],
  );
  const getSnapshot = useCallback(
    () => browserSessionsCoordinatorState(coordinatorKey),
    [coordinatorKey],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const unavailableState = useMemo(
    () => unavailableBrowserSessionsState(hostId),
    [hostId],
  );
  return { state: state ?? unavailableState, coordinatorKey };
}

function unavailableBrowserSessionsState(
  hostId: string | null,
): BrowserSessionsState {
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error("Browser sessions stream is not ready."));
  return {
    hostId,
    lifecycle: "connecting",
    inventoryReady: false,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: unavailable,
    closeTab: unavailable,
  };
}
