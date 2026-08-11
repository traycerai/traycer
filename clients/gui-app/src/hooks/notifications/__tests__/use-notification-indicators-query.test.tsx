import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  HostNotificationsCloudFeedRow,
  HostNotificationsEntityRef,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import {
  cloudNotificationFeedId,
  useCloudNotificationsStore,
} from "@/stores/notifications/cloud-notifications-store";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  useMergedNotificationRow,
  useMergedNotificationsActions,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";

/**
 * These drive the real derivation end to end: a real `HostClient` over
 * `MockHostMessenger` (so "did the v1 indicator RPC happen?" is observed, not
 * asserted on a spy shape), the real cloud store fed by real snapshot frames,
 * the real `NotificationIndicatorsProvider` context, and the real merged
 * mark-read action. Only the two seams a renderer cannot supply in jsdom - the
 * host runtime binding and stream capability negotiation - are stubbed.
 */

const hostClientRef = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));
const feedMode = vi.hoisted<{ value: "local" | "cloud" }>(() => ({
  value: "cloud",
}));

function requireHostClient(): HostClient<HostRpcRegistry> {
  const client = hostClientRef.current;
  if (client === null) throw new Error("host client not created");
  return client;
}

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => requireHostClient(),
    useHostBinding: () => ({ hostClient: requireHostClient() }),
  };
});

vi.mock("@/lib/notifications/notification-feed-mode", () => ({
  useNotificationFeedMode: () => feedMode.value,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mockLocalHostEntry.hostId,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

/** The connected host. Anything originating anywhere else is the multi-host
 * case the v1 indicator structurally cannot see. */
const CONNECTED_HOST_ID = mockLocalHostEntry.hostId;
const OTHER_HOST_ID = "host-b";
const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const ENTITY: HostNotificationsEntityRef = {
  epicId: EPIC_ID,
  chatId: CHAT_ID,
};

interface HostIndicatorStub {
  readonly response: HostNotificationsIndicatorStateResponse;
  readonly requestCount: { value: number };
}

interface CloudMarkReadStub {
  readonly calls: string[];
  mode: "applied" | "unavailable" | "never-settles";
}

interface Harness {
  readonly queryClient: QueryClient;
  readonly hostIndicators: HostIndicatorStub;
  readonly cloudMarkRead: CloudMarkReadStub;
}

function createHarness(
  hostResponse: HostNotificationsIndicatorStateResponse,
): Harness {
  const queryClient = createAppQueryClient();
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
    mutations: { retry: false },
  });
  const requestCount = { value: 0 };
  const cloudMarkRead: CloudMarkReadStub = { calls: [], mode: "applied" };
  let requestId = 0;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestId += 1;
        return `request-${String(requestId)}`;
      },
      handlers: {
        "host.notifications.indicatorState": () => {
          requestCount.value += 1;
          return hostResponse;
        },
        "host.notifications.cloudFeed.markRead": (params) => {
          cloudMarkRead.calls.push(params.entryId);
          if (cloudMarkRead.mode === "never-settles") {
            return new Promise<never>(() => undefined);
          }
          return cloudMarkRead.mode === "applied"
            ? { status: "applied", version: 2 }
            : { status: "unavailable", version: null };
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  hostClientRef.current = client;
  useAuthStore.setState({
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
  return {
    queryClient,
    hostIndicators: { response: hostResponse, requestCount },
    cloudMarkRead,
  };
}

const EMPTY_HOST_RESPONSE: HostNotificationsIndicatorStateResponse = {
  epics: {},
  chats: {},
};

/** Serializes the flags so an assertion names the exact indicator the
 * user sees rather than a boolean in isolation. */
function IndicatorProbe(props: {
  readonly entity: HostNotificationsEntityRef;
  readonly testId: string;
}): ReactNode {
  const state = useSurfaceNotificationIndicatorState(props.entity);
  const lit = [
    state.pendingFork ? "pendingFork" : null,
    state.pendingApproval ? "pendingApproval" : null,
    state.pendingInterview ? "pendingInterview" : null,
    state.unreadFailure ? "unreadFailure" : null,
    state.unreadDone ? "unreadDone" : null,
  ].filter((flag): flag is string => flag !== null);
  return (
    <span data-testid={props.testId}>
      {lit.length === 0 ? "none" : lit.join(",")}
    </span>
  );
}

/** The row's own read state, so "the icon agrees with the row it represents"
 * is asserted against the rendered row, not against store internals. */
function RowReadProbe(props: { readonly entryId: string }): ReactNode {
  const row = useMergedNotificationRow(cloudNotificationFeedId(props.entryId));
  return <span data-testid="row-read">{rowReadLabel(row)}</span>;
}

function rowReadLabel(row: MergedNotificationRow | null): string {
  if (row === null) return "missing";
  return row.readAt === null ? "unread" : "read";
}

function MarkReadButton(props: { readonly entryId: string }): ReactNode {
  const row = useMergedNotificationRow(cloudNotificationFeedId(props.entryId));
  const actions = useMergedNotificationsActions();
  return (
    <button
      type="button"
      data-testid="mark-read"
      onClick={() => {
        if (row !== null) actions.markAsRead(row);
      }}
    >
      Mark read
    </button>
  );
}

function IndicatorSurface(props: {
  readonly epicIds: ReadonlyArray<string>;
  readonly chatIds: ReadonlyArray<string>;
  readonly children: ReactNode;
}): ReactNode {
  const indicators = useNotificationIndicators({
    epicIds: props.epicIds,
    chatIds: props.chatIds,
    enabled: props.epicIds.length > 0 || props.chatIds.length > 0,
  });
  return (
    <NotificationIndicatorsProvider indicators={indicators}>
      {props.children}
    </NotificationIndicatorsProvider>
  );
}

function renderSurface(
  harness: Harness,
  options: {
    readonly epicIds: ReadonlyArray<string>;
    readonly chatIds: ReadonlyArray<string>;
    readonly children: ReactNode;
  },
): void {
  render(
    <QueryClientProvider client={harness.queryClient}>
      <IndicatorSurface epicIds={options.epicIds} chatIds={options.chatIds}>
        {options.children}
      </IndicatorSurface>
    </QueryClientProvider>,
  );
}

/** One visible cloud entry. The relay only ever sends whole visible
 * snapshots, so a row present here is a row the popover renders. */
function cloudRow(input: {
  readonly entryId: string;
  readonly originHostId: string;
  readonly readAt: number | null;
}): HostNotificationsCloudFeedRow {
  return {
    entryId: input.entryId,
    originHostId: input.originHostId,
    coalesceKey: `agent.stopped:${CHAT_ID}`,
    entry: {
      id: input.entryId,
      updatedAt: 1_000,
      readAt: input.readAt,
      kind: "agent.stopped",
      sourceRef: input.entryId,
      severity: "done",
      outcome: "completed",
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      payload: {
        kind: "chat",
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        outcome: "completed",
      },
    },
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}

function cloudApproval(input: {
  readonly entryId: string;
  readonly originHostId: string;
  readonly resolvedAt: number | null;
}): HostNotificationsCloudFeedRow {
  return {
    entryId: input.entryId,
    originHostId: input.originHostId,
    coalesceKey: `approval.requested:${CHAT_ID}`,
    entry: {
      id: input.entryId,
      updatedAt: 1_100,
      readAt: null,
      kind: "approval.requested",
      sourceRef: input.entryId,
      severity: "needs_action",
      outcome: null,
      resolvedAt: input.resolvedAt,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      payload: {
        kind: "approval",
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        approvalId: input.entryId,
      },
    },
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}

function applyCloudSnapshot(
  rows: ReadonlyArray<HostNotificationsCloudFeedRow>,
  version: number,
): void {
  useCloudNotificationsStore.getState().applySnapshot({
    rows,
    version,
    summary: {
      totalCount: rows.length,
      unreadCount: rows.filter((row) => row.entry.readAt === null).length,
      attentionCount: 0,
    },
  });
}

function indicatorText(testId: string): string {
  return screen.getByTestId(testId).textContent;
}

/** An unread app-local failure on the entity. Client-side state that belongs
 * to neither feed, so it must contribute in both modes. */
function seedAppLocalFailure(): void {
  useAppLocalNotificationsStore.getState().activateIdentity("user-a");
  useAppLocalNotificationsStore.getState().upsert({
    id: "terminal-1",
    updatedAt: 1,
    readAt: null,
    kind: "terminal.closed",
    sourceRef: "terminal-1",
    payload: { kind: "chat", epicId: EPIC_ID, chatId: CHAT_ID },
    message: "Terminal closed",
    detail: null,
  });
}

afterEach(() => {
  cleanup();
  hostClientRef.current = null;
  feedMode.value = "cloud";
  useCloudNotificationsStore.getState().reset();
  __resetAppLocalNotificationsStoreForTests();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("cloud-derived notification indicators", () => {
  it("lights a chat indicator for an entry produced on another host", async () => {
    const harness = createHarness(EMPTY_HOST_RESPONSE);
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-b",
          originHostId: OTHER_HOST_ID,
          readAt: null,
        }),
      ],
      1,
    );

    renderSurface(harness, {
      epicIds: [],
      chatIds: [CHAT_ID],
      children: <IndicatorProbe entity={ENTITY} testId="chat" />,
    });

    await waitFor(() => {
      expect(indicatorText("chat")).toBe("unreadDone");
    });
    // The entry never entered this host's SQLite, so the v1 path could not
    // have produced this. Cloud mode consults the host only for pendingFork.
    expect(OTHER_HOST_ID).not.toBe(CONNECTED_HOST_ID);
    expect(harness.hostIndicators.requestCount.value).toBeGreaterThan(0);
  });

  it("rolls a foreign-host chat entry up into its epic indicator", async () => {
    const harness = createHarness(EMPTY_HOST_RESPONSE);
    applyCloudSnapshot(
      [
        cloudApproval({
          entryId: "entry-approval",
          originHostId: OTHER_HOST_ID,
          resolvedAt: null,
        }),
      ],
      1,
    );

    renderSurface(harness, {
      epicIds: [EPIC_ID],
      chatIds: [],
      children: <IndicatorProbe entity={{ epicId: EPIC_ID }} testId="epic" />,
    });

    await waitFor(() => {
      expect(indicatorText("epic")).toBe("pendingApproval");
    });
    expect(harness.hostIndicators.requestCount.value).toBeGreaterThan(0);
  });

  it("stops lighting an approval once the cloud row carries resolvedAt", async () => {
    const harness = createHarness(EMPTY_HOST_RESPONSE);
    applyCloudSnapshot(
      [
        cloudApproval({
          entryId: "entry-approval",
          originHostId: OTHER_HOST_ID,
          resolvedAt: null,
        }),
      ],
      1,
    );

    renderSurface(harness, {
      epicIds: [],
      chatIds: [CHAT_ID],
      children: <IndicatorProbe entity={ENTITY} testId="chat" />,
    });
    await waitFor(() => {
      expect(indicatorText("chat")).toBe("pendingApproval");
    });

    applyCloudSnapshot(
      [
        cloudApproval({
          entryId: "entry-approval",
          originHostId: OTHER_HOST_ID,
          resolvedAt: 2_000,
        }),
      ],
      2,
    );

    await waitFor(() => {
      expect(indicatorText("chat")).toBe("none");
    });
  });

  it("clears the icon on mark-read before any request settles", async () => {
    const harness = createHarness(EMPTY_HOST_RESPONSE);
    // The mutation never resolves, so anything that clears the icon can only
    // be the optimistic set-once marker - never a host or cloud round trip.
    harness.cloudMarkRead.mode = "never-settles";
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-b",
          originHostId: OTHER_HOST_ID,
          readAt: null,
        }),
      ],
      1,
    );

    renderSurface(harness, {
      epicIds: [],
      chatIds: [CHAT_ID],
      children: (
        <>
          <IndicatorProbe entity={ENTITY} testId="chat" />
          <RowReadProbe entryId="entry-b" />
          <MarkReadButton entryId="entry-b" />
        </>
      ),
    });
    await waitFor(() => {
      expect(indicatorText("chat")).toBe("unreadDone");
    });

    screen.getByRole("button", { name: "Mark read" }).click();

    await waitFor(() => {
      expect(indicatorText("chat")).toBe("none");
    });
    expect(indicatorText("row-read")).toBe("read");
    expect(harness.cloudMarkRead.calls).toEqual(["entry-b"]);
    expect(harness.hostIndicators.requestCount.value).toBeGreaterThan(0);
  });

  it("keeps a host-derived pending fork lit when its cloud row is marked read", async () => {
    const harness = createHarness({
      epics: {},
      chats: {
        [CHAT_ID]: {
          unreadFailure: false,
          pendingFork: true,
          pendingApproval: false,
          pendingInterview: false,
          unreadDone: false,
        },
      },
    });
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-b",
          originHostId: OTHER_HOST_ID,
          readAt: null,
        }),
      ],
      1,
    );

    renderSurface(harness, {
      epicIds: [],
      chatIds: [CHAT_ID],
      children: (
        <>
          <IndicatorProbe entity={ENTITY} testId="chat" />
          <MarkReadButton entryId="entry-b" />
        </>
      ),
    });
    await waitFor(() => {
      expect(indicatorText("chat")).toBe("pendingFork,unreadDone");
    });

    screen.getByRole("button", { name: "Mark read" }).click();

    await waitFor(() => {
      expect(indicatorText("chat")).toBe("pendingFork");
    });
  });

  it("keeps a degraded mark-read's icon agreeing with its retained row, then reconverges on the next snapshot", async () => {
    const harness = createHarness(EMPTY_HOST_RESPONSE);
    harness.cloudMarkRead.mode = "unavailable";
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-b",
          originHostId: OTHER_HOST_ID,
          readAt: null,
        }),
      ],
      1,
    );

    renderSurface(harness, {
      epicIds: [],
      chatIds: [CHAT_ID],
      children: (
        <>
          <IndicatorProbe entity={ENTITY} testId="chat" />
          <RowReadProbe entryId="entry-b" />
          <MarkReadButton entryId="entry-b" />
        </>
      ),
    });
    await waitFor(() => {
      expect(indicatorText("chat")).toBe("unreadDone");
    });

    screen.getByRole("button", { name: "Mark read" }).click();

    await waitFor(() => {
      expect(useCloudNotificationsStore.getState().connectionState).toBe(
        "unavailable",
      );
    });
    // Degraded, but never incoherent: the icon says exactly what the row the
    // user is looking at says. The dangerous direction - a lit icon over a row
    // that reads as read - is unrepresentable when both read one store.
    expect(indicatorText("row-read")).toBe("read");
    expect(indicatorText("chat")).toBe("none");

    // The server never took the marker, so the authoritative snapshot still
    // says unread - and the icon follows it back rather than staying wrong.
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-b",
          originHostId: OTHER_HOST_ID,
          readAt: null,
        }),
      ],
      2,
    );
    await waitFor(() => {
      expect(indicatorText("chat")).toBe("unreadDone");
    });
    expect(indicatorText("row-read")).toBe("unread");
  });

  it("folds unread app-local failures in alongside the cloud rows", async () => {
    const harness = createHarness(EMPTY_HOST_RESPONSE);
    applyCloudSnapshot([], 1);
    seedAppLocalFailure();

    renderSurface(harness, {
      epicIds: [],
      chatIds: [CHAT_ID],
      children: <IndicatorProbe entity={ENTITY} testId="chat" />,
    });

    await waitFor(() => {
      expect(indicatorText("chat")).toBe("unreadFailure");
    });
    expect(harness.hostIndicators.requestCount.value).toBeGreaterThan(0);
  });
});

describe("local-mode notification indicators", () => {
  it("still derives from the host response on a methodless host", async () => {
    feedMode.value = "local";
    const harness = createHarness({
      epics: {},
      chats: {
        [CHAT_ID]: {
          unreadFailure: false,
          pendingFork: false,
          pendingApproval: true,
          pendingInterview: false,
          unreadDone: false,
        },
      },
    });
    // A stale cloud replica must not contribute in local mode - the host
    // response is the whole truth there.
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-b",
          originHostId: OTHER_HOST_ID,
          readAt: null,
        }),
      ],
      1,
    );

    renderSurface(harness, {
      epicIds: [],
      chatIds: [CHAT_ID],
      children: <IndicatorProbe entity={ENTITY} testId="chat" />,
    });

    await waitFor(() => {
      expect(indicatorText("chat")).toBe("pendingApproval");
    });
    expect(harness.hostIndicators.requestCount.value).toBeGreaterThan(0);
  });

  it("folds unread app-local failures into the host response", async () => {
    feedMode.value = "local";
    const harness = createHarness({
      epics: {},
      chats: {
        [CHAT_ID]: {
          unreadFailure: false,
          pendingFork: false,
          pendingApproval: false,
          pendingInterview: false,
          unreadDone: true,
        },
      },
    });
    seedAppLocalFailure();

    renderSurface(harness, {
      epicIds: [],
      chatIds: [CHAT_ID],
      children: <IndicatorProbe entity={ENTITY} testId="chat" />,
    });

    await waitFor(() => {
      expect(indicatorText("chat")).toBe("unreadFailure,unreadDone");
    });
  });
});
