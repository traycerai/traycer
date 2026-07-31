import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  HostNotificationsCloudFeedRow,
  HostNotificationsMarkReadRequest,
} from "@traycer/protocol/host/notifications/contracts";

/**
 * Visit-to-clear in cloud mode.
 *
 * Real canvas store (the presence source), real merged actions (the real
 * fan-out and its convergence guard), real cloud store, and a real
 * `HostClient` over `MockHostMessenger` - so "how many mark-read requests did
 * this actually issue?" is counted at the transport, which is the only place
 * a storm would be visible.
 *
 * The relay stream is not opened: snapshots are handed to the store through
 * `applySnapshot`, the same entry point the stream's snapshot frame calls.
 * Frame plumbing is covered by `notifications-session-provider.test.tsx`.
 */

interface HostState {
  client: HostClient<HostRpcRegistry> | null;
}

const hostState = vi.hoisted<HostState>(() => ({ client: null }));
const feedSupport = vi.hoisted<{ value: "supported" | "unsupported" }>(() => ({
  value: "supported",
}));

const mockAuth = {
  onChange: vi.fn((_handler: (status: string) => void) => ({
    dispose: vi.fn(),
  })),
  revalidateCurrentContext: vi.fn(() => Promise.resolve(null)),
};

function requireHostClient(): HostClient<HostRpcRegistry> {
  if (hostState.client === null) throw new Error("host client not created");
  return hostState.client;
}

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({ hostClient: requireHostClient() }),
  useHostClient: () => requireHostClient(),
  useAuthService: () => mockAuth,
}));

// No stream client: in cloud mode the provider opens no local stream anyway,
// and the two consumption triggers are deliberately independent of the relay.
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => feedSupport.value,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mockLocalHostEntry.hostId,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => mockLocalHostEntry,
}));

vi.mock("@/hooks/notifications/use-notifications", () => ({
  useNotificationShow: () => vi.fn(() => Promise.resolve()),
}));

vi.mock("@/hooks/notifications/use-notification-activation", () => ({
  useNotificationActivationWithNavigate: () => ({
    activate: vi.fn(),
    pendingFeedId: null,
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { NotificationsSessionProvider } from "@/providers/notifications-session-provider";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import { __resetHostNotificationsStoreForTests } from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const SIBLING_CHAT_ID = "chat-2";
const OTHER_HOST_ID = "host-b";

interface Calls {
  readonly cloudMarkRead: string[];
  readonly hostMarkRead: HostNotificationsMarkReadRequest[];
}

const calls: Calls = { cloudMarkRead: [], hostMarkRead: [] };
const cloudMarkReadMode: { value: "applied" | "never-settles" } = {
  value: "applied",
};

function createHostClient(): HostClient<HostRpcRegistry> {
  let requestId = 0;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestId += 1;
        return `request-${String(requestId)}`;
      },
      handlers: {
        "host.notifications.cloudFeed.markRead": (params) => {
          calls.cloudMarkRead.push(params.entryId);
          if (cloudMarkReadMode.value === "never-settles") {
            return new Promise<never>(() => undefined);
          }
          return { status: "applied", version: 2 };
        },
        "host.notifications.markRead": (params) => {
          calls.hostMarkRead.push(params);
          return {};
        },
        "host.notifications.indicatorState": () => ({ epics: {}, chats: {} }),
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  return client;
}

/** One visible cloud row. `severity` is what decides consumption; a
 * `needs_action` prompt must survive being looked at. */
function cloudRow(input: {
  readonly entryId: string;
  readonly originHostId: string;
  readonly severity: "done" | "failure";
  readonly chatId: string | null;
}): HostNotificationsCloudFeedRow {
  return {
    entryId: input.entryId,
    originHostId: input.originHostId,
    coalesceKey: `agent.stopped:${input.entryId}`,
    entry: {
      id: input.entryId,
      updatedAt: 1_000,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: input.entryId,
      severity: input.severity,
      outcome: input.severity === "done" ? "completed" : "errored",
      epicId: EPIC_ID,
      chatId: input.chatId,
      payload: {
        kind: "chat",
        epicId: EPIC_ID,
        chatId: input.chatId ?? undefined,
        outcome: input.severity === "done" ? "completed" : "errored",
      },
    },
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}

function cloudPrompt(input: {
  readonly entryId: string;
  readonly kind: "approval.requested" | "interview.requested";
}): HostNotificationsCloudFeedRow {
  return {
    entryId: input.entryId,
    originHostId: OTHER_HOST_ID,
    coalesceKey: `${input.kind}:${CHAT_ID}`,
    entry: {
      id: input.entryId,
      updatedAt: 1_100,
      readAt: null,
      kind: input.kind,
      sourceRef: input.entryId,
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
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
  act(() => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows,
      version,
      summary: {
        totalCount: rows.length,
        unreadCount: rows.filter((row) => row.entry.readAt === null).length,
        attentionCount: 0,
      },
    });
  });
}

function focusChat(epicId: string, chatId: string): void {
  act(() => {
    const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, "Epic");
    useEpicCanvasStore.getState().openTileInTab(
      tabId,
      makeOpenableNodeRef({
        id: chatId,
        instanceId: `${chatId}-instance`,
        type: "chat",
        name: "Chat",
        hostId: mockLocalHostEntry.hostId,
      }),
    );
  });
}

/** An epic tab with no chat tile open - presence resolves to `{epicId}`. */
function focusEpic(epicId: string): void {
  act(() => {
    useEpicCanvasStore.getState().openEpicTab(epicId, "Epic");
  });
}

/**
 * jsdom reports `document.hasFocus()` as `false` for the whole run, so the
 * focus half of the presence signal can never be true on its own here - the
 * suite would pass for the wrong reason (nothing focused, nothing consumed).
 * Stub the browser boundary and drive it explicitly, which also makes the
 * blurred-window case assertable.
 */
function setWindowFocused(focused: boolean): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  act(() => {
    window.dispatchEvent(new Event(focused ? "focus" : "blur"));
  });
}

function readAtFor(entryId: string): number | null {
  const row = useCloudNotificationsStore.getState().rows[`cloud:${entryId}`];
  if (row === undefined) throw new Error(`missing cloud row ${entryId}`);
  return row.entry.readAt;
}

function renderProvider(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationsSessionProvider navigate={() => Promise.resolve()}>
        <div />
      </NotificationsSessionProvider>
    </QueryClientProvider>,
  );
  act(() => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "user-a",
        userName: "user-a",
        email: "a@example.com",
      },
      contextMetadata: { userId: "user-a", username: "user-a" },
      subscriptionStatus: "FREE",
    });
  });
}

beforeEach(() => {
  calls.cloudMarkRead.length = 0;
  calls.hostMarkRead.length = 0;
  cloudMarkReadMode.value = "applied";
  feedSupport.value = "supported";
  hostState.client = createHostClient();
  useCloudNotificationsStore.getState().reset();
  __resetHostNotificationsStoreForTests();
  __resetNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  useAppLocalNotificationsStore.getState().activateIdentity("user-a");
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  hostState.client = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("cloud-mode view consumption", () => {
  it("marks a visited chat's terminal rows read across hosts", async () => {
    renderProvider();
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-local",
          originHostId: mockLocalHostEntry.hostId,
          severity: "done",
          chatId: CHAT_ID,
        }),
        cloudRow({
          entryId: "entry-foreign",
          originHostId: OTHER_HOST_ID,
          severity: "failure",
          chatId: CHAT_ID,
        }),
      ],
      1,
    );

    focusChat(EPIC_ID, CHAT_ID);

    await waitFor(() => {
      expect([...calls.cloudMarkRead].sort()).toEqual([
        "entry-foreign",
        "entry-local",
      ]);
    });
    expect(readAtFor("entry-local")).not.toBeNull();
    // The foreign entry is the one the v1 entity RPC structurally cannot
    // reach: it never entered the connected host's SQLite.
    expect(readAtFor("entry-foreign")).not.toBeNull();
    expect(calls.hostMarkRead).toEqual([]);
  });

  it("leaves a pending approval or interview unread when the chat is visited", async () => {
    renderProvider();
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-done",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: CHAT_ID,
        }),
        cloudPrompt({ entryId: "entry-approval", kind: "approval.requested" }),
        cloudPrompt({
          entryId: "entry-interview",
          kind: "interview.requested",
        }),
      ],
      1,
    );

    focusChat(EPIC_ID, CHAT_ID);

    await waitFor(() => {
      expect(calls.cloudMarkRead).toEqual(["entry-done"]);
    });
    // Looking at a chat must never silently answer what it is asking you.
    expect(readAtFor("entry-approval")).toBeNull();
    expect(readAtFor("entry-interview")).toBeNull();
  });

  it("marks only epic-level rows when an epic is visited, never its chats'", async () => {
    renderProvider();
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-epic",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: null,
        }),
        cloudRow({
          entryId: "entry-chat",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: SIBLING_CHAT_ID,
        }),
      ],
      1,
    );

    focusEpic(EPIC_ID);

    await waitFor(() => {
      expect(calls.cloudMarkRead).toEqual(["entry-epic"]);
    });
    expect(readAtFor("entry-chat")).toBeNull();
  });

  it("consumes a row that arrives while the chat is already in view", async () => {
    applyCloudSnapshot([], 1);
    renderProvider();
    focusChat(EPIC_ID, CHAT_ID);
    await waitFor(() => {
      expect(useEpicCanvasStore.getState().activeTabId).not.toBeNull();
    });
    expect(calls.cloudMarkRead).toEqual([]);

    // No second visit - the snapshot alone must consume it.
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-late",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: CHAT_ID,
        }),
      ],
      2,
    );

    await waitFor(() => {
      expect(calls.cloudMarkRead).toEqual(["entry-late"]);
    });
  });

  it("issues no further requests as snapshots keep re-landing the same rows", async () => {
    renderProvider();
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-done",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: CHAT_ID,
        }),
      ],
      1,
    );
    focusChat(EPIC_ID, CHAT_ID);
    await waitFor(() => {
      expect(calls.cloudMarkRead).toHaveLength(1);
    });

    for (let version = 2; version <= 6; version += 1) {
      applyCloudSnapshot(
        [
          cloudRow({
            entryId: "entry-done",
            originHostId: OTHER_HOST_ID,
            severity: "done",
            chatId: CHAT_ID,
          }),
        ],
        version,
      );
    }

    await waitFor(() => {
      expect(useCloudNotificationsStore.getState().version).toBe(6);
    });
    expect(calls.cloudMarkRead).toHaveLength(1);
  });

  it("does not storm when the mutation never settles and the server keeps replaying unread rows", async () => {
    cloudMarkReadMode.value = "never-settles";
    renderProvider();
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-done",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: CHAT_ID,
        }),
      ],
      1,
    );
    focusChat(EPIC_ID, CHAT_ID);
    await waitFor(() => {
      expect(calls.cloudMarkRead).toHaveLength(1);
    });

    // The realistic degraded shape: the marker never lands, so every
    // authoritative snapshot re-lands the row as unread. Without an
    // attempt-scoped guard this is one request per snapshot, forever.
    for (let version = 2; version <= 8; version += 1) {
      applyCloudSnapshot(
        [
          cloudRow({
            entryId: "entry-done",
            originHostId: OTHER_HOST_ID,
            severity: "done",
            chatId: CHAT_ID,
          }),
        ],
        version,
      );
    }

    await waitFor(() => {
      expect(useCloudNotificationsStore.getState().version).toBe(8);
    });
    expect(calls.cloudMarkRead).toHaveLength(1);
    expect(readAtFor("entry-done")).toBeNull();
  });

  it("waits for the window to regain focus before consuming", async () => {
    renderProvider();
    setWindowFocused(false);
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-done",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: CHAT_ID,
        }),
      ],
      1,
    );

    focusChat(EPIC_ID, CHAT_ID);
    await waitFor(() => {
      expect(useEpicCanvasStore.getState().activeTabId).not.toBeNull();
    });
    // A chat open in a background window has not been looked at.
    expect(calls.cloudMarkRead).toEqual([]);

    setWindowFocused(true);

    await waitFor(() => {
      expect(calls.cloudMarkRead).toEqual(["entry-done"]);
    });
  });

  it("still marks app-local rows read on a visit", async () => {
    applyCloudSnapshot([], 1);
    renderProvider();
    act(() => {
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
    });

    focusChat(EPIC_ID, CHAT_ID);

    await waitFor(() => {
      expect(
        useAppLocalNotificationsStore.getState().byId["terminal-1"].readAt,
      ).not.toBeNull();
    });
  });
});

describe("local-mode view consumption", () => {
  /**
   * Local mode still consumes through host presence frames and the v1 entity
   * RPC - covered end to end (stream frames included) in
   * `notifications-session-provider.test.tsx`. What matters here is the
   * regression this change could introduce: the locally-read focus signal is
   * cloud-only, and must not start a second consumption path in local mode.
   */
  it("never fans out cloud mark-reads, however the focus moves", async () => {
    feedSupport.value = "unsupported";
    renderProvider();
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-done",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: CHAT_ID,
        }),
      ],
      1,
    );

    focusChat(EPIC_ID, CHAT_ID);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    focusEpic(EPIC_ID);
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-done",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: CHAT_ID,
        }),
      ],
      2,
    );

    await waitFor(() => {
      expect(useCloudNotificationsStore.getState().version).toBe(2);
    });
    expect(calls.cloudMarkRead).toEqual([]);
    expect(readAtFor("entry-done")).toBeNull();
  });
});
