/**
 * Origin-host activation for native `hostSurface` notifications.
 *
 * Mounts the bridge over the REAL host machinery - `HostDirectoryService`,
 * `HostRuntime`, `HostClient`, and the real `useNotificationActivation` - so
 * the switch actually travels the production seam (directory selection ->
 * runtime listener -> `hostClient.bind`) instead of a stubbed "switch host"
 * function that could not fail the way the real one can. Only the router,
 * the acknowledgment write, and the toast surface are spied, because those
 * are the observable effects whose ORDER relative to the bind is the point.
 */
import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { NotificationPayload } from "@/lib/notifications/payload";

const navigateSpy = vi.hoisted(() => vi.fn());
const markAsRead = vi.hoisted(() => vi.fn<(feedId: string) => void>());
const toastSpy = vi.hoisted(() => ({
  success: vi.fn<(message: string) => void>(),
  error: vi.fn(),
}));
const bindingRef = vi.hoisted<{
  current: {
    readonly hostClient: HostClient<HostRpcRegistry>;
    readonly directory: HostDirectoryService;
  } | null;
}>(() => ({ current: null }));

vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock("sonner", () => ({ toast: toastSpy }));

vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => bindingRef.current,
    useHostDirectory: () => bindingRef.current?.directory ?? null,
  };
});

vi.mock("@/stores/notifications/merged-notifications", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/stores/notifications/merged-notifications")
    >();
  return {
    ...actual,
    useMergedNotificationsActions: () => ({
      markAsRead,
      markAllAsRead: vi.fn(),
      resolve: vi.fn(),
      loadMoreHost: vi.fn(),
      canLoadMoreHost: false,
      isLoadingMoreHost: false,
      hasHostLoadError: false,
      loadMoreAttention: vi.fn(),
      canLoadMoreAttention: false,
      isLoadingMoreAttention: false,
      hasAttentionLoadError: false,
      loadMoreUnreadRecent: vi.fn(),
      canLoadMoreUnreadRecent: false,
      isLoadingMoreUnreadRecent: false,
      hasUnreadRecentLoadError: false,
    }),
  };
});

import { NotificationFocusBridge } from "@/components/layout/bridges/notification-focus-bridge";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { buildNotificationActivationEnvelope } from "@/lib/notifications/notification-activation-envelope";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNotificationEventsStore } from "@/stores/notifications/notification-events-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useTabsStore } from "@/stores/tabs/store";

const LOCAL_SNAPSHOT: LocalHostSnapshot = {
  hostId: "this-mac",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "this-mac",
  displayName: "This Mac",
};

const ORIGIN_HOST: HostDirectoryEntry = {
  hostId: "build-box",
  label: "Build Box",
  kind: "remote",
  websocketUrl: "wss://build-box.traycer.invalid/rpc",
  version: "1.2.3",
  status: "available",
};

const WORKTREE_SETTINGS_ROUTE: NotificationPayload = {
  kind: "hostSurface",
  surface: "worktreeSettings",
  focus: undefined,
};

/** Every shape of "the origin exists in the envelope but cannot be dialed".
 * All three must reach the SAME safe fallback, because binding any of them
 * would swap the app onto a host it cannot talk to. */
const UNREACHABLE_ORIGIN_CASES: ReadonlyArray<{
  readonly label: string;
  readonly remoteHosts: readonly HostDirectoryEntry[];
}> = [
  { label: "absent from the directory", remoteHosts: [] },
  {
    label: "marked unavailable",
    remoteHosts: [{ ...ORIGIN_HOST, status: "unavailable" }],
  },
  {
    label: "missing a websocket url",
    remoteHosts: [{ ...ORIGIN_HOST, websocketUrl: null }],
  },
];

/** Every observable effect of an activation, in the order it happened, each
 * stamped with the app-wide host that was active AT THAT MOMENT - the whole
 * point of switch-then-route is that the stamps read `build-box`. */
const order: string[] = [];

function activeHostId(): string | null {
  return bindingRef.current?.hostClient.getActiveHostId() ?? null;
}

interface Mounted {
  readonly directory: HostDirectoryService;
  readonly client: HostClient<HostRpcRegistry>;
  /** Transient activations - the only selection call the bridge is allowed to
   * make, and the only route to a `hostClient.bind`, so `0` means "never
   * bound". */
  readonly transientSelectCalls: () => number;
  /** Durable "the user chose this host" writes. Must stay `0` forever: a
   * notification click is not a picker gesture. */
  readonly durableSelectCalls: () => number;
  readonly bindCount: () => number;
  readonly bump: () => void;
  /** Replaces the directory's remote hosts and reconciles, standing in for a
   * host leaving the directory between refreshes. */
  readonly refreshRemoteHosts: (
    hosts: readonly HostDirectoryEntry[],
  ) => Promise<void>;
}

async function mountBridge(options: {
  readonly remoteHosts: readonly HostDirectoryEntry[];
  readonly signedIn: boolean;
}): Promise<Mounted> {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: LOCAL_SNAPSHOT,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  let remoteHosts = options.remoteHosts;
  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: () =>
      Promise.resolve({ kind: "hosts" as const, entries: remoteHosts }),
    localHostIdSeeder: null,
  });
  await directory.start();

  const provider = new DefaultRequestContextProvider({ origin: "renderer" });
  if (options.signedIn) {
    provider.setSignedIn({
      user: createAuthenticatedUserFixture(undefined),
      bearerToken: "test-bearer",
      operationId: undefined,
      externalAbortSignal: undefined,
    });
  }
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  let requestSeq = 0;
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `host-switch-${++requestSeq}`,
      handlers: {},
    }),
    requestContextProvider: provider,
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
  });
  runtime.start();

  let binds = 0;
  runtime.hostClient.onChange((change) => {
    if (change.previousHostId !== change.currentHostId) binds += 1;
  });
  bindingRef.current = {
    hostClient: runtime.hostClient,
    directory,
  };

  const bumpHolder: { current: (() => void) | null } = { current: null };
  function Harness(): ReactNode {
    const [tick, setTick] = useState(0);
    useEffect(() => {
      bumpHolder.current = () => {
        setTick((value) => value + 1);
      };
      return () => {
        bumpHolder.current = null;
      };
    }, []);
    return (
      <QueryClientProvider client={queryClient}>
        <span data-testid="tick">{tick}</span>
        <NotificationFocusBridge />
      </QueryClientProvider>
    );
  }
  render(<Harness />);
  const durableSelectSpy = vi.spyOn(directory, "selectById");
  const transientSelectSpy = vi.spyOn(directory, "selectTransientById");

  return {
    directory,
    client: runtime.hostClient,
    transientSelectCalls: () => transientSelectSpy.mock.calls.length,
    durableSelectCalls: () => durableSelectSpy.mock.calls.length,
    bindCount: () => binds,
    bump: () => {
      const bump = bumpHolder.current;
      if (bump === null) throw new Error("bump not ready");
      act(() => {
        bump();
      });
    },
    refreshRemoteHosts: async (hosts) => {
      remoteHosts = hosts;
      await act(async () => {
        // The activation path fires a coalesced background `refresh()`
        // (T20/T21): a call landing while that fetch is in flight JOINS it and
        // observes the pre-change host list. Drain any in-flight refresh
        // first, then fetch again so this helper's outcome reflects `hosts`.
        await directory.refresh();
        await directory.refresh();
      });
    },
  };
}

function clickNative(route: NotificationPayload, feedSourceId: string): void {
  act(() => {
    useNotificationEventsStore.getState().recordClick(
      buildNotificationActivationEnvelope({
        route,
        feed: { source: "host", id: feedSourceId },
        originHostId: ORIGIN_HOST.hostId,
      }),
    );
  });
}

describe("NotificationFocusBridge origin-host activation", () => {
  beforeEach(async () => {
    // `hostSurface` routing activates a Settings tab through the shared tab
    // navigation controller. The app installs this above the bridge; make the
    // suite self-contained instead of relying on test-file execution order.
    __resetTabNavigationControllerForTesting();
    __resetTabSyncCoordinatorForTesting();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
    order.length = 0;
    navigateSpy.mockReset();
    navigateSpy.mockImplementation(() => {
      order.push(`route@${activeHostId()}`);
    });
    markAsRead.mockReset();
    markAsRead.mockImplementation((feedId) => {
      order.push(`ack:${feedId}@${activeHostId()}`);
    });
    toastSpy.success.mockReset();
    toastSpy.success.mockImplementation((message) => {
      order.push(`feedback:${message}@${activeHostId()}`);
    });
    useNotificationEventsStore.getState().clear();
    useNotificationsPopoverStore.getState().setOpen(false);
    useTabsStore.getState().closeSystemTab("settings");
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  afterEach(() => {
    cleanup();
    bindingRef.current = null;
    useNotificationEventsStore.getState().clear();
    useNotificationsPopoverStore.getState().setOpen(false);
    vi.restoreAllMocks();
  });

  it("binds the reachable origin once, then routes and acknowledges against it", async () => {
    const mounted = await mountBridge({
      remoteHosts: [ORIGIN_HOST],
      signedIn: true,
    });
    expect(mounted.client.getActiveHostId()).toBe(LOCAL_SNAPSHOT.hostId);
    const bindsBefore = mounted.bindCount();

    clickNative(WORKTREE_SETTINGS_ROUTE, "n-worktree");

    // Feedback, then navigation, then acknowledgment - each already on the
    // origin host. A route stamped `this-mac` would mean the app navigated
    // before the bind; an ack stamped `this-mac` would mark the row read on
    // the wrong feed.
    expect(order).toEqual([
      "feedback:Switched to Build Box@build-box",
      "route@build-box",
      "ack:host:n-worktree@build-box",
    ]);
    expect(mounted.client.getActiveHostId()).toBe(ORIGIN_HOST.hostId);
    expect(mounted.directory.getSelected()?.hostId).toBe(ORIGIN_HOST.hostId);
    expect(mounted.bindCount() - bindsBefore).toBe(1);
    // Transient, not durable: the click moved the app, it did not answer
    // "which host do you work on".
    expect(mounted.transientSelectCalls()).toBe(1);
    expect(mounted.durableSelectCalls()).toBe(0);
    // Switch-then-route is a successful activation, not a fallback.
    expect(useNotificationsPopoverStore.getState().open).toBe(false);
  });

  it("attributes the switch to the notification source, not a picker gesture", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    await mountBridge({ remoteHosts: [ORIGIN_HOST], signedIn: true });

    clickNative(WORKTREE_SETTINGS_ROUTE, "n-analytics");

    expect(
      track.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.HostSelected,
      ),
    ).toEqual([
      [
        AnalyticsEvent.HostSelected,
        { source: "notification", host_kind: "remote" },
      ],
    ]);
  });

  it("hands back to the default host when the activated origin later disappears", async () => {
    const mounted = await mountBridge({
      remoteHosts: [ORIGIN_HOST],
      signedIn: true,
    });

    clickNative(WORKTREE_SETTINGS_ROUTE, "n-vanishing");
    expect(mounted.client.getActiveHostId()).toBe(ORIGIN_HOST.hostId);

    // The origin drops out of the directory the way any host does - a refresh
    // that no longer lists it.
    await mounted.refreshRemoteHosts([]);

    // Recovery, not a dead end: because the activation never wrote durable
    // explicit-selection intent, normal default-host promotion still applies
    // and the app lands back on the local host. A `selectById` here would
    // have pinned the session to a host that no longer exists, leaving
    // `getSelected()` null with no way back except the picker.
    expect(mounted.client.getActiveHostId()).toBe(LOCAL_SNAPSHOT.hostId);
    expect(mounted.directory.getSelected()?.hostId).toBe(LOCAL_SNAPSHOT.hostId);
  });

  it("does not announce or record a switch when the app is already on the origin", async () => {
    const mounted = await mountBridge({
      remoteHosts: [ORIGIN_HOST],
      signedIn: true,
    });
    // The app moved to the origin before the click arrived - by an earlier
    // activation, or the picker. Nothing is left to switch.
    //
    // `switchToOriginHost` re-reads this live from the client rather than
    // trusting the rendered host id, so it also holds in the narrower case
    // this test cannot stage from public APIs: a bind that lands between the
    // bridge's render and its effect. (The rendered value is derived FROM the
    // client through `useSyncExternalStore`, so it can only ever lag it -
    // never lead - which is why the live read is the safe side to trust.)
    mounted.directory.selectTransientById(ORIGIN_HOST.hostId, "notification");
    const bindsBefore = mounted.bindCount();
    const transientBefore = mounted.transientSelectCalls();
    order.length = 0;

    clickNative(WORKTREE_SETTINGS_ROUTE, "n-already-there");

    // Routed and acknowledged, but with no second bind and no "Switched to"
    // toast for a switch that never happened.
    expect(order).toEqual([
      "route@build-box",
      "ack:host:n-already-there@build-box",
    ]);
    expect(mounted.bindCount() - bindsBefore).toBe(0);
    expect(mounted.transientSelectCalls() - transientBefore).toBe(0);
  });

  it("does not repeat the switch, route, or acknowledgment on a replayed event", async () => {
    const mounted = await mountBridge({
      remoteHosts: [ORIGIN_HOST],
      signedIn: true,
    });
    const bindsBefore = mounted.bindCount();

    clickNative(WORKTREE_SETTINGS_ROUTE, "n-replay");
    // The click stays resident in the store; only the processed-event guard
    // stops these rerenders from dispatching it again (and re-binding).
    mounted.bump();
    mounted.bump();
    mounted.bump();

    expect(order).toHaveLength(3);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(markAsRead).toHaveBeenCalledTimes(1);
    expect(toastSpy.success).toHaveBeenCalledTimes(1);
    expect(mounted.bindCount() - bindsBefore).toBe(1);
  });

  it("routes a same-host host-surface activation directly, with no switch feedback", async () => {
    const mounted = await mountBridge({
      remoteHosts: [ORIGIN_HOST],
      signedIn: true,
    });
    const bindsBefore = mounted.bindCount();

    act(() => {
      useNotificationEventsStore.getState().recordClick(
        buildNotificationActivationEnvelope({
          route: WORKTREE_SETTINGS_ROUTE,
          feed: { source: "host", id: "n-local" },
          originHostId: LOCAL_SNAPSHOT.hostId,
        }),
      );
    });

    expect(order).toEqual(["route@this-mac", "ack:host:n-local@this-mac"]);
    expect(mounted.transientSelectCalls()).toBe(0);
    expect(mounted.bindCount() - bindsBefore).toBe(0);
    expect(useNotificationsPopoverStore.getState().open).toBe(false);
  });

  it.each(UNREACHABLE_ORIGIN_CASES)(
    "never binds an origin $label and opens the origin-unavailable center",
    async ({ remoteHosts }) => {
      const mounted = await mountBridge({ remoteHosts, signedIn: true });
      const bindsBefore = mounted.bindCount();

      clickNative(WORKTREE_SETTINGS_ROUTE, "n-offline");

      const popover = useNotificationsPopoverStore.getState();
      expect(popover.open).toBe(true);
      expect(popover.originUnavailable).toBe(true);
      expect(order).toEqual([]);
      expect(mounted.transientSelectCalls()).toBe(0);
      expect(mounted.bindCount() - bindsBefore).toBe(0);
      expect(mounted.client.getActiveHostId()).toBe(LOCAL_SNAPSHOT.hostId);
    },
  );

  it("names the unreachable origin in the center when the directory knows it", async () => {
    await mountBridge({
      remoteHosts: [{ ...ORIGIN_HOST, status: "unavailable" }],
      signedIn: true,
    });

    clickNative(WORKTREE_SETTINGS_ROUTE, "n-offline-label");

    expect(
      useNotificationsPopoverStore.getState().originUnavailableHostLabel,
    ).toBe("Build Box");
  });

  it("does not bind or retry when the client has no authenticated identity", async () => {
    const mounted = await mountBridge({
      remoteHosts: [ORIGIN_HOST],
      signedIn: false,
    });
    const bindsBefore = mounted.bindCount();

    clickNative(WORKTREE_SETTINGS_ROUTE, "n-signed-out");
    // Rerenders are the loop a retry would ride in on: nothing re-attempts
    // the bind, and app-wide auth handling keeps ownership of the recovery.
    mounted.bump();
    mounted.bump();

    expect(useNotificationsPopoverStore.getState().originUnavailable).toBe(
      true,
    );
    expect(order).toEqual([]);
    expect(mounted.transientSelectCalls()).toBe(0);
    expect(mounted.bindCount() - bindsBefore).toBe(0);
    expect(mounted.client.getActiveHostId()).toBe(LOCAL_SNAPSHOT.hostId);
  });

  it("leaves an open terminal tab bound to the host it was created on", async () => {
    const canvas = useEpicCanvasStore.getState();
    const tabId = canvas.openEpicTab("epic-terminal", "Terminal epic");
    canvas.openTileInTab(tabId, {
      id: "terminal-1",
      instanceId: "terminal-instance-1",
      type: "terminal",
      name: "Terminal",
      titleSource: "manual",
      hostId: LOCAL_SNAPSHOT.hostId,
      cwd: "/repo",
    });
    const mounted = await mountBridge({
      remoteHosts: [ORIGIN_HOST],
      signedIn: true,
    });

    clickNative(WORKTREE_SETTINGS_ROUTE, "n-tabs");

    // Only the app-wide scope moves. A PTY cannot migrate, so the tile keeps
    // its lifetime `hostId` even though the active host is now the origin.
    expect(mounted.client.getActiveHostId()).toBe(ORIGIN_HOST.hostId);
    const tile =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        "terminal-instance-1"
      ];
    expect(tile?.type).toBe("terminal");
    expect(tile?.type === "terminal" ? tile.hostId : null).toBe(
      LOCAL_SNAPSHOT.hostId,
    );
  });

  it("leaves epic activation on a different host unchanged - no switch", async () => {
    const mounted = await mountBridge({
      remoteHosts: [ORIGIN_HOST],
      signedIn: true,
    });
    const bindsBefore = mounted.bindCount();

    clickNative({ kind: "epic", epicId: "epic-1" }, "n-epic");

    const popover = useNotificationsPopoverStore.getState();
    expect(popover.open).toBe(true);
    expect(popover.originUnavailable).toBe(true);
    expect(popover.originUnavailableHostLabel).toBe("Build Box");
    expect(order).toEqual([]);
    expect(mounted.transientSelectCalls()).toBe(0);
    expect(mounted.bindCount() - bindsBefore).toBe(0);
    expect(mounted.client.getActiveHostId()).toBe(LOCAL_SNAPSHOT.hostId);
  });
});
