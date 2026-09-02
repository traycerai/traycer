import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import {
  authenticatedHostStreamKey,
  authenticatedOwnerIdentityKey,
} from "@/hooks/host/use-host-stream-client-for";
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
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { useRunnerHost } from "@/providers/use-runner-host";

function browserSessionsOwnerIdentityKey(
  hostClient: HostClient<HostRpcRegistry> | null,
  hostEntry: HostDirectoryEntry | null,
): string | null {
  return hostClient === null
    ? null
    : authenticatedOwnerIdentityKey(hostClient, hostEntry);
}

/**
 * The browser inventory for an explicit host, sharing the same coordinator as
 * the sidebar, tiles, and PiP when they point at that host.
 */
export function useBrowserSessionsForHost(args: {
  readonly hostId: string | null;
  readonly epicId: string;
}): BrowserSessionsState {
  const runnerHost = useRunnerHost();
  const hostClient = useHostClientForHostId(args.hostId);
  const localHostId = useReactiveLocalHostId();
  return useBrowserSessions({
    hostId: args.hostId,
    hostClient,
    epicId: args.epicId,
    browserView: runnerHost.browserView,
    localHostId,
  }).state;
}

interface UseBrowserSessionsArgs {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly browserView: BrowserViewBridge | null;
  /** This machine's host id, declared as the Electron locality signal. */
  readonly localHostId: string | null;
}

interface BrowserSessionsHookResult {
  readonly state: BrowserSessionsState;
  readonly coordinatorKey: string | null;
}

export function useBrowserSessions(
  args: UseBrowserSessionsArgs,
): BrowserSessionsHookResult {
  const { hostId, epicId, browserView, localHostId } = args;
  const hostEntry = useHostDirectoryEntry(hostId ?? UNKNOWN_HOST_PLACEHOLDER);
  const transportReady =
    args.hostClient !== null &&
    authenticatedHostStreamKey(args.hostClient, hostEntry) !== null;
  const ownerIdentityKey = browserSessionsOwnerIdentityKey(
    args.hostClient,
    hostEntry,
  );
  // Not sent to main, which reads the signed-in user from the desktop auth
  // session it owns; it only decides whether asking is worth an IPC.
  const userId = args.hostClient?.getRequestContextUserId() ?? null;
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
        runtime: { browserView, userId, localHostId, openTransport },
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
      userId,
      localHostId,
      openTransport,
    });
  }, [
    browserView,
    consumerId,
    coordinatorKey,
    localHostId,
    openTransport,
    userId,
  ]);

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
    // No coordinator, so nothing has established this client can place a
    // native tab on that host. Surfaces gate a native branch on it, and the
    // safe answer is the viewer one.
    canMaterializeElectron: false,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: unavailable,
    closeTab: unavailable,
  };
}
