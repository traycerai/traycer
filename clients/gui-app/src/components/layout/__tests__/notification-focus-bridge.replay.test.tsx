/**
 * Unmocked integration coverage for the P0-2 native-click replay guard.
 *
 * The focused `notification-focus-bridge.test.tsx` mocks
 * `useNotificationActivation` entirely, which is exactly what hid the
 * bug: `activate`'s identity is not guaranteed stable across renders
 * (host binding changes, etc.), so the effect can re-run while the
 * still-resident `notificationEvent` remains in the store - without the
 * processed-event ref it would redispatch indefinitely.
 *
 * This file mounts the REAL activation hook against a real HostClient so
 * a genuine activate -> onResult path runs, then forces unrelated
 * re-renders to prove the guard holds.
 */
import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { buildNotificationActivationEnvelope } from "@/lib/notifications/notification-activation-envelope";
import { NotificationFocusBridge } from "@/components/layout/bridges/notification-focus-bridge";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNotificationEventsStore } from "@/stores/notifications/notification-events-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

const navigateSpy = vi.fn();
const markAsRead = vi.hoisted(() => vi.fn<(feedId: string) => void>());
const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
}));
const bindingState = vi.hoisted<{
  current: { readonly hostClient: HostClient<HostRpcRegistry> } | null;
}>(() => ({ current: null }));
const directoryRef = vi.hoisted(() => ({
  value: null as {
    findById: (hostId: string) => typeof mockLocalHostEntry | null;
  } | null,
}));

vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

// Real useNotificationActivation - deliberately NOT mocked.
vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => bindingState.current,
  };
});

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => activeHostIdRef.value,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) => {
    if (hostId.length === 0 || directoryRef.value === null) return null;
    return directoryRef.value.findById(hostId);
  },
}));

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

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

/**
 * Forces the bridge (and its parent) to re-render without changing the
 * notification-events store, so an effect dependency identity change is the
 * only way a second dispatch could happen.
 */
function BridgeHarness(props: { readonly tick: number }): ReactNode {
  return (
    <>
      <span data-testid="bridge-tick">{props.tick}</span>
      <NotificationFocusBridge />
    </>
  );
}

function RerenderableBridge(props: { readonly queryClient: QueryClient }): {
  readonly result: RenderResult;
  readonly bump: () => void;
} {
  const bumpHolder: { current: (() => void) | null } = { current: null };
  function Host(): ReactNode {
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
      <QueryClientProvider client={props.queryClient}>
        <BridgeHarness tick={tick} />
      </QueryClientProvider>
    );
  }
  const result = render(<Host />);
  return {
    result,
    bump: () => {
      const bumpImpl = bumpHolder.current;
      if (bumpImpl === null) throw new Error("bump not ready");
      act(() => {
        bumpImpl();
      });
    },
  };
}

describe("NotificationFocusBridge native-click replay guard (P0-2)", () => {
  let messenger: MockHostMessenger<HostRpcRegistry>;
  let client: HostClient<HostRpcRegistry>;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(1_777_768_800_000);
    navigateSpy.mockReset();
    markAsRead.mockReset();
    queryClient = createTestQueryClient();
    let requestSeq = 0;
    messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `replay-${++requestSeq}`,
      handlers: {
        "host.notifications.markRead": () => ({}),
      },
    });
    client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger,
    });
    client.bind(mockLocalHostEntry);
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "token",
      }),
    );
    bindingState.current = { hostClient: client };
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useNotificationEventsStore.getState().clear();
    useNotificationsPopoverStore.getState().setOpen(false);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useNotificationEventsStore.getState().clear();
    useNotificationsPopoverStore.getState().setOpen(false);
    bindingState.current = null;
  });

  function originValidEnvelope(feedId: string, epicId: string) {
    return buildNotificationActivationEnvelope({
      route: { kind: "epic", epicId },
      feed: { source: "host", id: feedId },
      originHostId: mockLocalHostEntry.hostId,
    });
  }

  it("dispatches a native V1 click exactly once across extra rerenders", async () => {
    const { bump } = RerenderableBridge({ queryClient });

    act(() => {
      useNotificationEventsStore
        .getState()
        .recordClick(originValidEnvelope("n-replay", "epic-replay"));
    });

    // Activation completes synchronously: route + markAsRead in the same
    // click -> effect -> activate() chain. No preflight to settle.
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(markAsRead).toHaveBeenCalledTimes(1);
      expect(markAsRead).toHaveBeenCalledWith("host:n-replay");
    });

    // Force unrelated re-renders; the stored click must not redispatch even
    // if activate's identity changes across those renders.
    bump();
    bump();
    bump();

    await act(async () => {
      await Promise.resolve();
    });

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(markAsRead).toHaveBeenCalledTimes(1);
    expect(useNotificationsPopoverStore.getState().open).toBe(false);
  });

  it("still accepts a genuinely new native click after the first completes", async () => {
    RerenderableBridge({ queryClient });

    act(() => {
      useNotificationEventsStore
        .getState()
        .recordClick(originValidEnvelope("n-1", "epic-1"));
    });

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(markAsRead).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useNotificationEventsStore
        .getState()
        .recordClick(originValidEnvelope("n-2", "epic-2"));
    });

    expect(navigateSpy).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(markAsRead).toHaveBeenCalledTimes(2);
      expect(markAsRead).toHaveBeenLastCalledWith("host:n-2");
    });
  });
});
