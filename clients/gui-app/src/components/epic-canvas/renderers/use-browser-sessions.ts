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
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import {
  usePaneFocused,
  usePaneVisible,
} from "@/components/epic-tabs/pane-visibility-context";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
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
  readonly scope: HostResourceScope;
}): BrowserSessionsState {
  const runnerHost = useRunnerHost();
  const hostClient = useHostClientForHostId(args.hostId);
  const localHostId = useReactiveLocalHostId();
  return useBrowserSessions({
    hostId: args.hostId,
    hostClient,
    scope: args.scope,
    browserView: runnerHost.browserView,
    localHostId,
  }).state;
}

interface UseBrowserSessionsArgs {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  /**
   * Which inventory to read: one epic's, or the device's `independent` one.
   * Passed by value and never used as an effect dependency - the coordinator
   * KEY is the identity everything below keys on, so a caller may build this
   * inline without re-acquiring on every render.
   */
  readonly scope: HostResourceScope;
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
  const { hostId, scope, browserView, localHostId } = args;
  const navigateNested = useEpicNestedFocusNavigation();
  const viewTabId = useEpicViewTabId();
  const surfaceVisible = usePaneVisible();
  const surfaceFocused = usePaneFocused();
  const presentation = useMemo(
    () =>
      viewTabId === null
        ? null
        : {
            viewTabId,
            visible: surfaceVisible,
            focused: surfaceFocused,
          },
    [surfaceFocused, surfaceVisible, viewTabId],
  );
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
    owner === null ? null : browserSessionsCoordinatorKey(scope, owner);
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
        scope,
        owner: selectedOwner,
        runtime: {
          browserView,
          userId,
          localHostId,
          presentation,
          navigateNested,
          openTransport,
        },
        createIfMissing: transportReady,
      }),
  );

  useEffect(() => {
    if (coordinatorKey === null || owner === null) return;
    return acquireCoordinator(coordinatorKey, owner);
    // The scope is NOT a dependency: it is an object, so an inline
    // `{ kind: "epic", epicId }` would be a new identity every render and this
    // effect would release and re-acquire the coordinator each time. Its
    // serialized form IS `coordinatorKey`, which changes exactly when the
    // scope does.
  }, [consumerId, coordinatorKey, owner]);

  useEffect(() => {
    if (coordinatorKey === null) return;
    upsertBrowserSessionsCoordinatorConsumer(coordinatorKey, consumerId, {
      browserView,
      userId,
      localHostId,
      presentation,
      navigateNested,
      openTransport,
    });
  }, [
    browserView,
    consumerId,
    coordinatorKey,
    localHostId,
    navigateNested,
    openTransport,
    userId,
    presentation,
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
    attachTab: unavailable,
    moveTab: unavailable,
  };
}
