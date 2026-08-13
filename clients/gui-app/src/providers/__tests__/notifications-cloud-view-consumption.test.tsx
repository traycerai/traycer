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

// Feed-mode capability still reads the app-wide stream binding.
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamMethodSupport: () => feedSupport.value,
}));

// Per G8 the provider binds to the LOCAL host, so these two hooks replace
// `useReactiveActiveHostId` + `useWsStreamClient`. No stream client: in cloud
// mode the provider opens no local stream anyway, and the two consumption
// triggers are deliberately independent of the relay.
vi.mock("@/hooks/host/use-reactive-local-host-entry", () => ({
  useReactiveLocalHostEntry: () => mockLocalHostEntry,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => null,
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
import {
  cloudNotificationFeedId,
  useCloudNotificationsStore,
} from "@/stores/notifications/cloud-notifications-store";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import { __resetHostNotificationsStoreForTests } from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import {
  CLOUD_ENTITY_READ_RETRY_BASE_MS,
  resetCloudEntityReadDriver,
} from "@/lib/notifications/cloud-entity-read-driver";
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
const cloudMarkReadMode: {
  value: "applied" | "never-settles" | "always-fails" | "fails-then-applies";
} = { value: "applied" };
/** Remaining rejections for `fails-then-applies`. */
const cloudMarkReadFailures = { remaining: 0 };
/** Live/peak concurrency observed inside the handler - a direct reading of
 * single-flight, not an inference from call ordering. */
const cloudMarkReadConcurrency = { live: 0, peak: 0 };
/** Manual gate: when armed, each request parks until the test releases it. */
const cloudMarkReadGate: { armed: boolean; waiting: Array<() => void> } = {
  armed: false,
  waiting: [],
};

function releaseOneGatedRequest(): void {
  const next = cloudMarkReadGate.waiting.shift();
  next?.();
}

async function cloudMarkReadHandler(): Promise<void> {
  if (cloudMarkReadMode.value === "never-settles") {
    await new Promise<never>(() => undefined);
  }
  if (cloudMarkReadGate.armed) {
    await new Promise<void>((resolve) => {
      cloudMarkReadGate.waiting.push(resolve);
    });
  }
  if (cloudMarkReadMode.value === "always-fails") {
    throw new Error("cloud mark-read failed");
  }
  if (
    cloudMarkReadMode.value === "fails-then-applies" &&
    cloudMarkReadFailures.remaining > 0
  ) {
    cloudMarkReadFailures.remaining -= 1;
    throw new Error("cloud mark-read failed");
  }
}

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
        "host.notifications.cloudFeed.markRead": async (params) => {
          calls.cloudMarkRead.push(params.entryId);
          cloudMarkReadConcurrency.live += 1;
          cloudMarkReadConcurrency.peak = Math.max(
            cloudMarkReadConcurrency.peak,
            cloudMarkReadConcurrency.live,
          );
          try {
            await cloudMarkReadHandler();
            return { status: "applied", version: 2 };
          } finally {
            cloudMarkReadConcurrency.live -= 1;
          }
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

function focusChat(epicId: string, chatId: string, hostId: string): void {
  act(() => {
    const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, "Epic");
    useEpicCanvasStore.getState().openTileInTab(
      tabId,
      makeOpenableNodeRef({
        id: chatId,
        instanceId: `${chatId}-instance`,
        type: "chat",
        name: "Chat",
        hostId,
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
  // Production keys come from this helper (it percent-encodes the entry id);
  // rebuilding the prefix by hand would silently miss any id needing encoding.
  const row =
    useCloudNotificationsStore.getState().rows[
      cloudNotificationFeedId(entryId)
    ];
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
  cloudMarkReadFailures.remaining = 0;
  cloudMarkReadConcurrency.live = 0;
  cloudMarkReadConcurrency.peak = 0;
  cloudMarkReadGate.armed = false;
  cloudMarkReadGate.waiting.length = 0;
  resetCloudEntityReadDriver();
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
  vi.useRealTimers();
  resetCloudEntityReadDriver();
  hostState.client = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("cloud-mode view consumption", () => {
  it("marks only the focused host's terminal rows read", async () => {
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

    focusChat(EPIC_ID, CHAT_ID, mockLocalHostEntry.hostId);

    await waitFor(() => {
      expect(calls.cloudMarkRead).toEqual(["entry-local"]);
    });
    expect(readAtFor("entry-local")).not.toBeNull();
    expect(readAtFor("entry-foreign")).toBeNull();
    expect(calls.hostMarkRead).toEqual([]);
  });

  it("marks a pending approval or interview read when the chat is visited", async () => {
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

    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);

    await waitFor(() => {
      expect(calls.cloudMarkRead).toEqual([
        "entry-done",
        "entry-approval",
        "entry-interview",
      ]);
    });
    // Reading the prompt never resolves the underlying workflow.
    expect(readAtFor("entry-approval")).not.toBeNull();
    expect(readAtFor("entry-interview")).not.toBeNull();
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
    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);
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
    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);
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
    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);
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

    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);
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
        originHostId: OTHER_HOST_ID,
        updatedAt: 1,
        readAt: null,
        kind: "terminal.closed",
        sourceRef: "terminal-1",
        payload: { kind: "chat", epicId: EPIC_ID, chatId: CHAT_ID },
        message: "Terminal closed",
        detail: null,
      });
    });

    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);

    await waitFor(() => {
      expect(
        useAppLocalNotificationsStore.getState().byId["terminal-1"].readAt,
      ).not.toBeNull();
    });
  });
});

/**
 * Retrying is safe by construction (set-once, min-merged markers), so these
 * pin the PACING rather than any suppression: one request in flight, growing
 * gaps between failures, and a clean stop once the server accepts.
 *
 * `Math.random` is stubbed so the jitter window is deterministic; the clock is
 * faked so a five-minute cap does not mean a five-minute test.
 */
describe("cloud-mode view-consumption teardown", () => {
  /**
   * The retry timer re-arms on every failure, so a persistently failing server
   * keeps a chain of timers alive. Unmount reaches none of the relay-session
   * reset sites, so the driver has to be stopped there explicitly - otherwise
   * these timers fire host RPCs through a torn-down mutation client.
   */
  it("issues no further requests after the provider unmounts", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(Math, "random").mockReturnValue(1);
    cloudMarkReadMode.value = "always-fails";

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
    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.cloudMarkRead).toHaveLength(1);

    cleanup();

    // Well past every backoff the chain could have reached.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(calls.cloudMarkRead).toHaveLength(1);
  });

  it("does not let a pass that was in flight at teardown re-arm the chain", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(Math, "random").mockReturnValue(1);
    cloudMarkReadMode.value = "always-fails";
    cloudMarkReadGate.armed = true;

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
    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.cloudMarkRead).toHaveLength(1);
    expect(cloudMarkReadGate.waiting).toHaveLength(1);

    // Unmount while the request is parked, THEN let it settle: the pass's own
    // completion path is the second way a dead generation can re-arm.
    cleanup();
    releaseOneGatedRequest();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(calls.cloudMarkRead).toHaveLength(1);
  });
});

describe("cloud-mode view-consumption retries", () => {
  function useDeterministicBackoff(fraction: number): void {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(Math, "random").mockReturnValue(fraction);
  }

  /** Jitter is over [50%, 100%] of the exponential, so a stubbed `random`
   * of `f` yields exactly this. */
  function expectedBackoffMs(attempts: number, fraction: number): number {
    return Math.round(
      CLOUD_ENTITY_READ_RETRY_BASE_MS *
        2 ** (attempts - 1) *
        (0.5 + fraction * 0.5),
    );
  }

  async function settle(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function visitWithOneUnreadRow(): Promise<void> {
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
    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);
    await settle(0);
  }

  it("retries a failed mark-read once its backoff elapses", async () => {
    useDeterministicBackoff(1);
    cloudMarkReadMode.value = "always-fails";
    await visitWithOneUnreadRow();
    expect(calls.cloudMarkRead).toHaveLength(1);

    // One tick short of the first backoff: still parked.
    await settle(expectedBackoffMs(1, 1) - 1);
    expect(calls.cloudMarkRead).toHaveLength(1);

    await settle(1);
    expect(calls.cloudMarkRead).toHaveLength(2);
  });

  it("grows the interval between successive failures", async () => {
    useDeterministicBackoff(1);
    cloudMarkReadMode.value = "always-fails";
    await visitWithOneUnreadRow();

    // Each attempt must wait strictly longer than the previous one: advancing
    // by only the PREVIOUS interval is not enough to trigger the next attempt.
    for (const attempt of [1, 2, 3]) {
      const before = calls.cloudMarkRead.length;
      await settle(expectedBackoffMs(attempt, 1));
      expect(calls.cloudMarkRead).toHaveLength(before + 1);
      await settle(expectedBackoffMs(attempt, 1));
      expect(calls.cloudMarkRead).toHaveLength(before + 1);
    }
  });

  it("stops retrying once the server accepts, and stays stopped", async () => {
    useDeterministicBackoff(1);
    cloudMarkReadMode.value = "fails-then-applies";
    cloudMarkReadFailures.remaining = 1;
    await visitWithOneUnreadRow();
    expect(calls.cloudMarkRead).toHaveLength(1);
    expect(
      useCloudNotificationsStore.getState().entityReadRetries["entry-done"],
    ).not.toBeUndefined();

    await settle(expectedBackoffMs(1, 1));
    expect(calls.cloudMarkRead).toHaveLength(2);

    // Accepted: retry state cleared, entry recorded as done.
    expect(
      useCloudNotificationsStore.getState().entityReadRetries["entry-done"],
    ).toBeUndefined();
    expect(
      useCloudNotificationsStore
        .getState()
        .entityReadSucceeded.has("entry-done"),
    ).toBe(true);

    // Well past the cap, and with the feed still replaying the row unread.
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
    await settle(600_000);
    expect(calls.cloudMarkRead).toHaveLength(2);
  });

  it("decays rather than storms while the server keeps refusing", async () => {
    useDeterministicBackoff(1);
    cloudMarkReadMode.value = "always-fails";
    await visitWithOneUnreadRow();

    // Ten minutes of a broken server, with a snapshot replaying the unread row
    // every second. Unpaced this is ~600 requests; paced it is the handful the
    // doubling allows before the five-minute cap.
    for (let tick = 0; tick < 600; tick += 1) {
      applyCloudSnapshot(
        [
          cloudRow({
            entryId: "entry-done",
            originHostId: OTHER_HOST_ID,
            severity: "done",
            chatId: CHAT_ID,
          }),
        ],
        2 + tick,
      );
      await settle(1_000);
    }
    expect(calls.cloudMarkRead.length).toBeLessThanOrEqual(12);
    expect(calls.cloudMarkRead.length).toBeGreaterThan(1);
  });

  it("never runs two mark-reads at once", async () => {
    useDeterministicBackoff(1);
    cloudMarkReadGate.armed = true;
    renderProvider();
    applyCloudSnapshot(
      [
        cloudRow({
          entryId: "entry-a",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: CHAT_ID,
        }),
        cloudRow({
          entryId: "entry-b",
          originHostId: OTHER_HOST_ID,
          severity: "failure",
          chatId: CHAT_ID,
        }),
        cloudRow({
          entryId: "entry-c",
          originHostId: OTHER_HOST_ID,
          severity: "done",
          chatId: CHAT_ID,
        }),
      ],
      1,
    );
    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);
    await settle(0);

    // Three rows to consume, but only one request may be parked at the gate.
    expect(calls.cloudMarkRead).toHaveLength(1);
    expect(cloudMarkReadGate.waiting).toHaveLength(1);

    for (let released = 0; released < 3; released += 1) {
      releaseOneGatedRequest();
      await settle(0);
      expect(cloudMarkReadGate.waiting.length).toBeLessThanOrEqual(1);
    }

    expect(calls.cloudMarkRead).toHaveLength(3);
    expect(cloudMarkReadConcurrency.peak).toBe(1);
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

    focusChat(EPIC_ID, CHAT_ID, OTHER_HOST_ID);
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
