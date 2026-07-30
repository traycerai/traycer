/**
 * The acknowledgment half of origin-host activation, proven on the wire.
 *
 * The sibling `host-switch` suite stubs `useMergedNotificationsActions` to get
 * a deterministic ordering trace, which means it can only show that SOMETHING
 * acknowledged after the bind. This file runs the REAL merged-notifications
 * action, the real `useHostMutation`, and the real `HostClient`, then reads
 * `MockHostMessenger.calls` - so "acknowledged against the origin feed" is
 * asserted from the request that actually left the client, including which
 * host endpoint it was addressed to.
 *
 * It also pins the settled post-bind failure policy: once the bind lands,
 * a host that then refuses the request is app-wide host/auth territory. This
 * feature does not retry it and does not roll the app back out from under the
 * user's navigation.
 */
import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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
const toastSpy = vi.hoisted(() => ({
  success: vi.fn<(message: string) => void>(),
  error: vi.fn(),
}));
const toastFromHostError = vi.hoisted(() => vi.fn());
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

vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError }));

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => bindingRef.current,
    useHostDirectory: () => bindingRef.current?.directory ?? null,
  };
});

import { NotificationFocusBridge } from "@/components/layout/bridges/notification-focus-bridge";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { buildNotificationActivationEnvelope } from "@/lib/notifications/notification-activation-envelope";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { __resetHostNotificationsStoreForTests } from "@/stores/notifications/host-notifications-store";
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

interface Mounted {
  readonly directory: HostDirectoryService;
  readonly client: HostClient<HostRpcRegistry>;
  readonly markReadCalls: () => ReadonlyArray<{
    readonly params: unknown;
    readonly hostId: string;
  }>;
  readonly bindCount: () => number;
  readonly transientSelectCalls: () => number;
}

/** `markRead` either answers or refuses - the two sides of the post-bind
 * policy this file exists to pin down. */
async function mountBridge(
  markReadOutcome: "ok" | "refused",
): Promise<Mounted> {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: LOCAL_SNAPSHOT,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: () => Promise.resolve([ORIGIN_HOST]),
  });
  await directory.start();

  const provider = new DefaultRequestContextProvider({ origin: "renderer" });
  provider.setSignedIn({
    user: createAuthenticatedUserFixture(undefined),
    bearerToken: "test-bearer",
    operationId: undefined,
    externalAbortSignal: undefined,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  let requestSeq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `origin-ack-${++requestSeq}`,
    handlers: {
      "host.notifications.markRead": () => {
        if (markReadOutcome === "refused") {
          throw new Error("host refused the acknowledgment");
        }
        return {};
      },
    },
  });
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger,
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
  bindingRef.current = { hostClient: runtime.hostClient, directory };

  function Harness(): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        <NotificationFocusBridge />
      </QueryClientProvider>
    );
  }
  render(<Harness />);
  const transientSelectSpy = vi.spyOn(directory, "selectTransientById");

  return {
    directory,
    client: runtime.hostClient,
    markReadCalls: () =>
      messenger.calls
        .filter((call) => call.method === "host.notifications.markRead")
        .map((call) => ({
          params: call.params,
          hostId: call.authority.endpoint.hostId,
        })),
    bindCount: () => binds,
    transientSelectCalls: () => transientSelectSpy.mock.calls.length,
  };
}

function clickCrossHostWorktreeRow(feedSourceId: string): void {
  act(() => {
    useNotificationEventsStore.getState().recordClick(
      buildNotificationActivationEnvelope({
        route: WORKTREE_SETTINGS_ROUTE,
        feed: { source: "host", id: feedSourceId },
        originHostId: ORIGIN_HOST.hostId,
      }),
    );
  });
}

/** Lets every queued mutation microtask settle, so "did not retry" is a claim
 * about a drained queue rather than about timing. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("NotificationFocusBridge origin acknowledgment on the wire", () => {
  beforeEach(async () => {
    // `hostSurface` routing activates a Settings tab through the shared tab
    // navigation controller. The real app installs this coordinator above the
    // bridge; make that production prerequisite explicit here so this suite
    // does not accidentally depend on another test having installed it.
    __resetTabNavigationControllerForTesting();
    __resetTabSyncCoordinatorForTesting();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
    navigateSpy.mockReset();
    toastSpy.success.mockReset();
    toastFromHostError.mockReset();
    useNotificationEventsStore.getState().clear();
    useNotificationsPopoverStore.getState().setOpen(false);
    useTabsStore.getState().closeSystemTab("settings");
    __resetHostNotificationsStoreForTests();
  });

  afterEach(() => {
    cleanup();
    bindingRef.current = null;
    useNotificationEventsStore.getState().clear();
    useNotificationsPopoverStore.getState().setOpen(false);
    __resetHostNotificationsStoreForTests();
    vi.restoreAllMocks();
  });

  it("sends markRead to the ORIGIN host's endpoint, exactly once", async () => {
    const mounted = await mountBridge("ok");

    clickCrossHostWorktreeRow("n-ack");

    await waitFor(() => {
      expect(mounted.markReadCalls()).toHaveLength(1);
    });
    // The request left the client addressed to build-box, not to the host the
    // app was on when the notification was clicked.
    expect(mounted.markReadCalls()).toEqual([
      { params: { kind: "ids", ids: ["n-ack"] }, hostId: ORIGIN_HOST.hostId },
    ]);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    // Counted from after mount, so this is the switch itself and nothing else.
    expect(mounted.bindCount()).toBe(1);

    await settle();
    expect(mounted.markReadCalls()).toHaveLength(1);
  });

  it("leaves the app switched, un-retried, and un-rolled-back when the origin refuses the acknowledgment", async () => {
    const mounted = await mountBridge("refused");

    clickCrossHostWorktreeRow("n-refused");

    await waitFor(() => {
      expect(mounted.markReadCalls()).toHaveLength(1);
    });
    await settle();

    // Settled policy: a host that passed the pre-bind reachability gate and
    // then refuses is owned by app-wide host/auth handling. This feature does
    // not invent a rollback target, does not re-select, and does not retry -
    // the user stays on the surface they navigated to.
    expect(mounted.markReadCalls()).toHaveLength(1);
    expect(mounted.client.getActiveHostId()).toBe(ORIGIN_HOST.hostId);
    expect(mounted.directory.getSelected()?.hostId).toBe(ORIGIN_HOST.hostId);
    expect(mounted.bindCount()).toBe(1);
    // The one switch, and nothing after it - no compensating re-selection.
    expect(mounted.transientSelectCalls()).toBe(1);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.success).toHaveBeenCalledTimes(1);
    // No retroactive fallback: the center does not open behind the surface
    // the user is already looking at.
    expect(useNotificationsPopoverStore.getState().originUnavailable).toBe(
      false,
    );
  });
});
