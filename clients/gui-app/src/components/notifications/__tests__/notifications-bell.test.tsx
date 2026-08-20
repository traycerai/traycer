import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createHostReconnectEngine } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { isMac } from "@/lib/keybindings/platform";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import {
  __resetNotificationsStoreForTests,
  openNotificationsStream,
} from "@/stores/notifications/notifications-store";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
import type { NotificationsStreamCallbacks } from "@traycer-clients/shared/host-transport/notifications-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  type ParamsOf,
  type StreamMethodSupport,
  WsStreamClient,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  type NotificationEntry,
  NOTIFICATION_EVENT_TYPES,
} from "@traycer/protocol/notifications/notification-entry";
import {
  createNotificationRoomEntryMap,
  NOTIFICATIONS_ARRAY_KEY,
  type NotificationRoomEntryMap,
} from "@traycer/protocol/notifications/notification-room";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";

const reconnectEngine = createHostReconnectEngine();

const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
}));

const directoryRef = vi.hoisted(() => ({
  value: null as {
    findById: (hostId: string) => typeof mockLocalHostEntry | null;
  } | null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => activeHostIdRef.value,
}));

// The notification centre reads its host from `useNotificationHost` (the local
// host that owns the streams), not from the app-wide active host. Projected
// from this suite's existing host ref so the scenario it was already
// describing is unchanged.
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationHostId: () => activeHostIdRef.value,
  useNotificationHost: () => ({ hostId: activeHostIdRef.value, client: null }),
}));

vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: (hostId: string) => {
      if (hostId.length === 0 || directoryRef.value === null) return null;
      return directoryRef.value.findById(hostId);
    },
  };
});

function buildSnapshot(entries: ReadonlyArray<NotificationEntry>): Uint8Array {
  const donor = new Y.Doc();
  const arr = donor.getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY);
  donor.transact(() => {
    for (const entry of entries) {
      arr.push([createNotificationRoomEntryMap(entry)]);
    }
  });
  return Y.encodeStateAsUpdate(donor);
}

function invitedEntry(
  id: string,
  createdAt: number,
  readAt: number | null,
  epicId: string,
): NotificationEntry {
  return {
    id,
    createdAt,
    readAt,
    event: {
      kind: NOTIFICATION_EVENT_TYPES.INVITED,
      epicId,
      actorName: "Alice",
    },
  };
}

interface FakeHandle {
  readonly callbacks: NotificationsStreamCallbacks;
}

function fakeFactory(): {
  factory: Parameters<typeof openNotificationsStream>[1];
  handle: () => FakeHandle;
} {
  let current: FakeHandle | null = null;
  return {
    factory: (callbacks) => {
      current = { callbacks };
      return {
        applyUpdate: () => {},
        close: () => {},
      };
    },
    handle: () => {
      if (current === null) throw new Error("factory not invoked");
      return current;
    },
  };
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

/** Minimal stream client whose method-support map is fully test-controlled. */
class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  methodSupportByName = new Map<string, StreamMethodSupport>();

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: {
        create: () => {
          throw new Error("MockWsStreamClient should not open a websocket");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    throw new Error("MockWsStreamClient.subscribe is not used in these tests");
  }

  override getMethodSupport<
    Method extends keyof HostStreamRpcRegistry & string,
  >(method: Method): StreamMethodSupport {
    return this.methodSupportByName.get(method) ?? "unknown";
  }
}

function mountBell(
  runnerHost: MockRunnerHost,
  options:
    | {
        readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
        readonly feedMode: "local" | "cloud";
      }
    | undefined,
): void {
  const bell = (
    <QueryClientProvider client={createTestQueryClient()}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <TooltipProvider>
          <NotificationsBell />
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );

  if (options === undefined) {
    render(bell);
    return;
  }

  // The feed mode is negotiated once by `NotificationsSessionProvider`, against
  // the client it opened the streams on, and published as context. These cases
  // are about what the BELL renders in cloud mode, not about the negotiation
  // (which `notification-feed-mode.test.tsx` owns), so the mode is supplied
  // directly alongside the stream runtime the rest of the tree still reads.
  render(
    <StreamRuntimeContext.Provider
      value={{ wsStreamClient: options.wsStreamClient, hostId: null }}
    >
      <NotificationFeedModeContext.Provider value={options.feedMode}>
        {bell}
      </NotificationFeedModeContext.Provider>
    </StreamRuntimeContext.Provider>,
  );
}

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.com",
    authnBaseUrl: "https://auth.example.com",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

const DYNAMIC_ACTION_ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

/** The default `app.notifications.open` chord as a keyboard event, pressed the
 * way a user on THIS platform presses it. `hasPlatformModKey` accepts
 * `metaKey || ctrlKey` off macOS, so a Command press would match there too -
 * and would leave the Ctrl half, the one every Windows/Linux user actually
 * hits, untested. */
function pressNotificationsChord(): void {
  fireEvent.keyDown(window, {
    key: "N",
    code: "KeyN",
    ...(isMac() ? { metaKey: true } : { ctrlKey: true }),
    shiftKey: true,
  });
}

function expectNoBellIndicators(): void {
  expect(screen.queryByTestId("notifications-attention-badge")).toBeNull();
  expect(screen.queryByTestId("notifications-quiet-dot")).toBeNull();
  expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
}

describe("NotificationsBell", () => {
  beforeEach(() => {
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    window.localStorage.clear();
    useNotificationsPopoverStore.getState().setOpen(false);
    useTitleBarDragStore.setState({ suppressors: new Set() });
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };
  });

  afterEach(() => {
    cleanup();
    useNotificationsPopoverStore.getState().setOpen(false);
    useTitleBarDragStore.setState({ suppressors: new Set() });
  });

  it("keeps bell click open and close behavior unchanged", async () => {
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, undefined);

    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(useNotificationsPopoverStore.getState().open).toBe(false);

    fireEvent.click(screen.getByTestId("notifications-bell"));

    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();
    expect(useNotificationsPopoverStore.getState().open).toBe(true);

    fireEvent.click(screen.getByTestId("notifications-bell"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(useNotificationsPopoverStore.getState().open).toBe(false);
  });

  it("opens through the notifications keybinding action and focuses the heading", async () => {
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, undefined);

    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    act(() => {
      expect(
        dispatchAction("app.notifications.open", DYNAMIC_ACTION_ROUTER),
      ).toBe(true);
    });

    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();
    expect(useNotificationsPopoverStore.getState().open).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Notifications" }),
    );
  });

  it("toggles the open center closed on a second chord press and returns focus to the bell", async () => {
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, undefined);

    act(() => {
      dispatchAction("app.notifications.open", DYNAMIC_ACTION_ROUTER);
    });
    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Notifications" }),
    );

    // Dispatch can't deliver the second press: an open Radix popover is a
    // `role="dialog"`, which the keybinding provider treats as a chord
    // barrier. The bell's own window listener is what closes it.
    act(() => {
      pressNotificationsChord();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    });
    expect(useNotificationsPopoverStore.getState().open).toBe(false);
    // Identity by testid, not ref: the tooltip may remount the trigger node.
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("data-testid")).toBe(
        "notifications-bell",
      );
    });
  });

  it("does not steal focus when the chord closes a center the pointer opened", async () => {
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, undefined);

    const bell = screen.getByTestId("notifications-bell");
    fireEvent.pointerDown(bell);
    fireEvent.click(bell);
    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();

    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();

    act(() => {
      pressNotificationsChord();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
    });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("suppresses title-bar dragging only while the popover is open", async () => {
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, undefined);

    const isSuppressed = () =>
      useTitleBarDragStore.getState().suppressors.has("notifications");

    expect(isSuppressed()).toBe(false);

    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();
    expect(isSuppressed()).toBe(true);

    fireEvent.click(screen.getByTestId("notifications-bell"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(isSuppressed()).toBe(false);
  });

  it("does not focus the first header action on pointer open", async () => {
    const runnerHost = createRunnerHost();
    const { factory, handle } = fakeFactory();
    openNotificationsStream(reconnectEngine, factory, null);
    mountBell(runnerHost, undefined);

    act(() => {
      handle().callbacks.onSnapshot(
        { schemaVersion: "2" },
        buildSnapshot([invitedEntry("focus-seed", 1, null, "e1")]),
      );
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 1, attentionCount: 0 },
      });
    });

    const bell = screen.getByTestId("notifications-bell");
    bell.focus();
    fireEvent.pointerDown(bell);
    fireEvent.click(bell);

    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();
    const markAll = screen.getByTestId("notifications-mark-all-read");
    expect(document.activeElement).not.toBe(markAll);
    const heading = screen.getByRole("heading", { name: "Notifications" });
    expect(document.activeElement).not.toBe(heading);
  });

  it("renders the exact uncapped attention badge and label", () => {
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, undefined);

    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 0, attentionCount: 147 },
      });
      useAppLocalNotificationsStore.getState().activateIdentity("user-a");
      useAppLocalNotificationsStore.getState().upsert({
        id: "a1",
        updatedAt: 1,
        readAt: null,
        kind: "stream.transport.error",
        sourceRef: "a1",
        payload: null,
        message: "failed",
        detail: null,
      });
      useAppLocalNotificationsStore.getState().upsert({
        id: "a2",
        updatedAt: 2,
        readAt: null,
        kind: "stream.transport.error",
        sourceRef: "a2",
        payload: null,
        message: "failed",
        detail: null,
      });
      useAppLocalNotificationsStore.getState().upsert({
        id: "a3",
        updatedAt: 3,
        readAt: null,
        kind: "stream.transport.error",
        sourceRef: "a3",
        payload: null,
        message: "failed",
        detail: null,
      });
    });

    const badge = screen.getByTestId("notifications-attention-badge");
    expect(badge.textContent).toBe("150");
    expect(screen.queryByTestId("notifications-quiet-dot")).toBeNull();
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications, 150 notifications need attention");
  });

  it("renders unknown DISTINGUISHABLY from clear, and the quiet-dot for quietDot", () => {
    const runnerHost = createRunnerHost();
    const { factory, handle } = fakeFactory();
    openNotificationsStream(reconnectEngine, factory, null);
    mountBell(runnerHost, undefined);

    // `s5-parity-gaps` gap 3. This block used to assert the OPPOSITE - the
    // comment read "unknown kind, but renders like clear (no dot)" and the
    // assertion was `expectNoBellIndicators()`. That encoded a false "nothing
    // waiting" as the expected behaviour, so the suite being green was not
    // evidence about this surface at all. Flipping it is part of the fix.
    act(() => {
      handle().callbacks.onSnapshot(
        { schemaVersion: "2" },
        buildSnapshot([invitedEntry("quiet-seed", 1, null, "e1")]),
      );
    });

    expect(
      screen.getByTestId("notifications-unknown-indicator"),
    ).not.toBeNull();
    // And it is not wearing either of the two states that DO make a claim.
    expect(screen.queryByTestId("notifications-attention-badge")).toBeNull();
    expect(screen.queryByTestId("notifications-quiet-dot")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Notifications, status unavailable" }),
    ).not.toBeNull();

    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 1, attentionCount: 0 },
      });
    });

    expect(screen.getByTestId("notifications-quiet-dot")).not.toBeNull();
    expect(screen.queryByTestId("notifications-attention-badge")).toBeNull();
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications, unread activity");

    act(() => {
      __resetNotificationsStoreForTests();
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 0, attentionCount: 0 },
      });
    });

    expectNoBellIndicators();
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).not.toBeNull();
  });

  it("shows the partial host subtitle when the host summary has not landed", async () => {
    // No StreamRuntimeContext → useStreamMethodSupport is null (still connecting).
    activeHostIdRef.value = null;
    directoryRef.value = { findById: () => null };
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, undefined);

    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(
      (await screen.findByTestId("notifications-subtitle")).textContent,
    ).toBe("Task activity is unavailable right now");
  });

  it("shows the old-host subtitle when notifications feed support is unsupported", async () => {
    // Partial host summary + confirmed mirror-compat failure for the feed RPC.
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    const streamClient = new MockWsStreamClient();
    streamClient.methodSupportByName.set(
      "host.notifications.feed.subscribe",
      "unsupported",
    );
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, { wsStreamClient: streamClient, feedMode: "local" });

    // By testid, not by accessible name: these three cases are about the
    // SUBTITLE, and their fixtures leave the host summary absent - which is
    // now an `unknown` bell whose label says so. Selecting on a label that
    // encodes bell state would couple them to a state they do not assert.
    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(
      (await screen.findByTestId("notifications-subtitle")).textContent,
    ).toBe("Task activity isn't available on this host version");
  });

  it("keeps the transient partial subtitle when stream support is still unknown", async () => {
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    const streamClient = new MockWsStreamClient();
    streamClient.methodSupportByName.set(
      "host.notifications.feed.subscribe",
      "unknown",
    );
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, { wsStreamClient: streamClient, feedMode: "local" });

    // By testid, not by accessible name: these three cases are about the
    // SUBTITLE, and their fixtures leave the host summary absent - which is
    // now an `unknown` bell whose label says so. Selecting on a label that
    // encodes bell state would couple them to a state they do not assert.
    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(
      (await screen.findByTestId("notifications-subtitle")).textContent,
    ).toBe("Task activity is unavailable right now");
  });

  it("shows the active host label when the summary is available", async () => {
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, undefined);

    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(
      (await screen.findByTestId("notifications-subtitle")).textContent,
    ).toBe(`Task activity from ${mockLocalHostEntry.label}`);
  });

  it("omits the subtitle row in cloud mode", async () => {
    const streamClient = new MockWsStreamClient();
    streamClient.methodSupportByName.set(
      "host.notifications.cloudFeed.subscribe",
      "supported",
    );
    const runnerHost = createRunnerHost();
    mountBell(runnerHost, { wsStreamClient: streamClient, feedMode: "cloud" });

    // By testid, not by accessible name: these three cases are about the
    // SUBTITLE, and their fixtures leave the host summary absent - which is
    // now an `unknown` bell whose label says so. Selecting on a label that
    // encodes bell state would couple them to a state they do not assert.
    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();
    expect(screen.queryByTestId("notifications-subtitle")).toBeNull();
  });

  describe("notification center opened analytics", () => {
    it("fires once per open cycle with direct_ui entry and exact host buckets", async () => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 7, attentionCount: 3 },
      });
      const runnerHost = createRunnerHost();
      const { rerender } = render(
        <QueryClientProvider client={createTestQueryClient()}>
          <RunnerHostProvider runnerHost={runnerHost}>
            <TooltipProvider>
              <NotificationsBell />
            </TooltipProvider>
          </RunnerHostProvider>
        </QueryClientProvider>,
      );

      const bell = screen.getByTestId("notifications-bell");
      fireEvent.pointerDown(bell);
      fireEvent.click(bell);
      expect(await screen.findByTestId("notifications-popover")).not.toBeNull();

      const openCalls = trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationCenterOpened,
      );
      expect(openCalls).toHaveLength(1);
      expect(openCalls[0]?.[1]).toEqual({
        entry_point: "direct_ui",
        host_state: "exact",
        attention_bucket: "2-5",
        unread_bucket: "6-20",
      });

      // Rerender / unrelated store update while open must not re-fire.
      act(() => {
        useHostNotificationsStore.getState().applySnapshot({
          attention: { entries: [], nextCursor: null },
          recent: { entries: [], nextCursor: null },
          summary: { unreadCount: 8, attentionCount: 4 },
        });
      });
      rerender(
        <QueryClientProvider client={createTestQueryClient()}>
          <RunnerHostProvider runnerHost={runnerHost}>
            <TooltipProvider>
              <NotificationsBell />
            </TooltipProvider>
          </RunnerHostProvider>
        </QueryClientProvider>,
      );
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationCenterOpened,
        ),
      ).toHaveLength(1);

      fireEvent.click(screen.getByTestId("notifications-bell"));
      await act(async () => {
        await Promise.resolve();
      });
      expect(useNotificationsPopoverStore.getState().open).toBe(false);

      fireEvent.pointerDown(screen.getByTestId("notifications-bell"));
      fireEvent.click(screen.getByTestId("notifications-bell"));
      await screen.findByTestId("notifications-popover");
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationCenterOpened,
        ),
      ).toHaveLength(2);

      trackSpy.mockRestore();
    });

    it("uses notification entry_point for store-driven opens and unknown buckets when host summary is missing", async () => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      const runnerHost = createRunnerHost();
      // No host summary applied → isPartial / unknown bell state.
      // A SIBLING of the same shape as the flipped assertion above: it too
      // asserted that an unknown bell renders no indicator. The analytics
      // bucketing this test is actually about is unchanged.
      activeHostIdRef.value = mockLocalHostEntry.hostId;
      mountBell(runnerHost, undefined);

      expect(
        screen.getByTestId("notifications-unknown-indicator"),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", {
          name: "Notifications, status unavailable",
        }),
      ).not.toBeNull();

      act(() => {
        useNotificationsPopoverStore.getState().setOpen(true);
      });
      expect(await screen.findByTestId("notifications-popover")).not.toBeNull();

      const openCalls = trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationCenterOpened,
      );
      expect(openCalls).toHaveLength(1);
      expect(openCalls[0]?.[1]).toEqual({
        entry_point: "notification",
        host_state: "unknown",
        attention_bucket: "unknown",
        unread_bucket: "unknown",
      });

      trackSpy.mockRestore();
    });
  });
});
