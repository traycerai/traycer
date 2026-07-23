import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import {
  useAttentionNotificationIds,
  useMergedNotificationRow,
  useMergedNotificationsActions,
} from "@/stores/notifications/merged-notifications";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";

const hostRequestMock = vi.hoisted(() => vi.fn());

const hostBindingState = vi.hoisted(() => ({
  current: null as {
    readonly hostClient: {
      readonly request: typeof hostRequestMock;
      readonly getActiveHostId: () => string | null;
    };
  } | null,
}));

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostBindingState.current,
  };
});

vi.mock("@/lib/host-error-toast", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host-error-toast")>();
  return {
    ...actual,
    toastFromHostError: vi.fn(actual.toastFromHostError),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "sonner";
import { toastFromHostError } from "@/lib/host-error-toast";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(): (props: {
  readonly children: ReactNode;
}) => ReactNode {
  const queryClient = createTestQueryClient();
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function hostPrompt(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "approval.requested",
    sourceRef: id,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Deploy checkout fix",
      taskTitle: "Checkout notifications",
      approvalId: id,
    },
  };
}

function hostDone(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "done",
    outcome: "completed",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "Agent",
      taskTitle: "Checkout notifications",
      outcome: "completed",
    },
  };
}

function applyHostSnapshot(
  entries: ReadonlyArray<HostNotificationEntry>,
  summary: { readonly unreadCount: number; readonly attentionCount: number },
): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: {
      entries: entries.filter(
        (entry) =>
          entry.severity === "needs_action" || entry.severity === "failure",
      ),
      nextCursor: null,
    },
    recent: { entries, nextCursor: null },
    summary,
  });
}

function bindHostClient(): void {
  hostBindingState.current = {
    hostClient: {
      request: hostRequestMock,
      getActiveHostId: () => mockLocalHostEntry.hostId,
    },
  };
}

function defaultHostRequest(method: string): Promise<unknown> {
  if (
    method === "host.notifications.markRead" ||
    method === "host.notifications.resolve" ||
    method === "host.notifications.markAllRead"
  ) {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve({});
}

function unsupportedResolveError(): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "host.notifications.resolve is not supported",
    requestId: "req-unsupported-resolve",
    method: "host.notifications.resolve",
    fatalDetails: {
      code: "E_HOST_UNSUPPORTED",
      reason: "Method not advertised by this host",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function markAllReadCallParams(): { readonly beforeUpdatedAt: number } {
  const call = hostRequestMock.mock.calls.find(
    (entry) => entry[0] === "host.notifications.markAllRead",
  );
  const params: unknown = call === undefined ? undefined : call[1];
  if (!isRecord(params)) {
    throw new Error("expected host.notifications.markAllRead params");
  }
  const beforeUpdatedAt = params["beforeUpdatedAt"];
  if (typeof beforeUpdatedAt !== "number") {
    throw new Error("expected host.notifications.markAllRead params");
  }
  return { beforeUpdatedAt };
}

function resolveCallOccurrences(): ReadonlyArray<{
  readonly id: string;
  readonly updatedAt: number;
  readonly sourceRef: string | null;
}> {
  const call = hostRequestMock.mock.calls.find(
    (entry) => entry[0] === "host.notifications.resolve",
  );
  const params: unknown = call === undefined ? undefined : call[1];
  if (!isRecord(params)) {
    throw new Error("expected host.notifications.resolve params");
  }
  const occurrences = params["occurrences"];
  if (!Array.isArray(occurrences)) {
    throw new Error("expected host.notifications.resolve params");
  }
  return occurrences.map((raw: unknown) => {
    if (!isRecord(raw)) {
      throw new Error("expected resolve occurrence token");
    }
    const id = raw["id"];
    const updatedAt = raw["updatedAt"];
    const sourceRef = raw["sourceRef"];
    if (
      typeof id !== "string" ||
      typeof updatedAt !== "number" ||
      (sourceRef !== null && typeof sourceRef !== "string")
    ) {
      throw new Error("expected resolve occurrence token");
    }
    return {
      id,
      updatedAt,
      sourceRef: sourceRef === null ? null : sourceRef,
    };
  });
}

function entryResolvedAt(id: string): number | null {
  const byId = useHostNotificationsStore.getState().byId;
  if (!(id in byId)) {
    throw new Error(`missing host notification ${id}`);
  }
  const entry = byId[id];
  return "resolvedAt" in entry ? entry.resolvedAt : null;
}

describe("useMergedNotificationsActions markAllAsRead composition", () => {
  beforeEach(() => {
    hostRequestMock.mockReset();
    hostRequestMock.mockImplementation(defaultHostRequest);
    hostBindingState.current = null;
    vi.mocked(toastFromHostError).mockClear();
    vi.mocked(toast.error).mockClear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-actions");
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
  });

  afterEach(() => {
    cleanup();
    hostBindingState.current = null;
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("fires markAllRead and resolve concurrently with loaded blocking occurrence tokens", async () => {
    bindHostClient();
    applyHostSnapshot(
      [
        hostPrompt("prompt-a", 200, null),
        hostPrompt("prompt-b", 150, 40),
        hostDone("done-unread", 100, null),
      ],
      { unreadCount: 2, attentionCount: 2 },
    );

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        attentionIds: useAttentionNotificationIds(),
      }),
      { wrapper: createWrapper() },
    );

    expect(result.current.attentionIds).toEqual([
      "host:prompt-a",
      "host:prompt-b",
    ]);

    act(() => {
      result.current.actions.markAllAsRead();
    });

    await waitFor(() => {
      expect(markAllReadCallParams().beforeUpdatedAt).toBeTypeOf("number");
      expect(
        [...resolveCallOccurrences()].sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual([
        { id: "prompt-a", updatedAt: 200, sourceRef: "prompt-a" },
        { id: "prompt-b", updatedAt: 150, sourceRef: "prompt-b" },
      ]);
    });

    // No optimistic resolve: Attention still holds the loaded prompts until the
    // host's authoritative readStateChanged frame lands.
    expect(result.current.attentionIds).toEqual([
      "host:prompt-a",
      "host:prompt-b",
    ]);
    expect(entryResolvedAt("prompt-a")).toBeNull();

    act(() => {
      useHostNotificationsStore
        .getState()
        .applyReadStateFrame(["prompt-a", "prompt-b"], {
          readAt: 999,
          resolvedAt: 999,
          removedIds: [],
          summary: { unreadCount: 0, attentionCount: 0 },
        });
    });

    await waitFor(() => {
      expect(result.current.attentionIds).toEqual([]);
    });
  });

  it("skips resolve when no loaded blocking Attention rows exist", async () => {
    bindHostClient();
    applyHostSnapshot([hostDone("done-only", 100, null)], {
      unreadCount: 1,
      attentionCount: 0,
    });

    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markAllAsRead();
    });

    await waitFor(() => {
      expect(markAllReadCallParams().beforeUpdatedAt).toBeTypeOf("number");
    });

    expect(
      hostRequestMock.mock.calls.some(
        (call) => call[0] === "host.notifications.resolve",
      ),
    ).toBe(false);
  });

  it("keeps markAllRead when resolve is E_HOST_UNSUPPORTED without a failure row or double toast", async () => {
    bindHostClient();
    applyHostSnapshot(
      [
        hostPrompt("prompt-old-host", 200, null),
        hostDone("done-unread", 100, null),
      ],
      { unreadCount: 2, attentionCount: 1 },
    );

    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.resolve") {
        return Promise.reject(unsupportedResolveError());
      }
      return defaultHostRequest(method);
    });

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        attentionIds: useAttentionNotificationIds(),
      }),
      { wrapper: createWrapper() },
    );

    act(() => {
      result.current.actions.markAllAsRead();
    });

    await waitFor(() => {
      expect(markAllReadCallParams().beforeUpdatedAt).toBeTypeOf("number");
      expect(resolveCallOccurrences()).toEqual([
        {
          id: "prompt-old-host",
          updatedAt: 200,
          sourceRef: "prompt-old-host",
        },
      ]);
    });

    await waitFor(() => {
      expect(
        useHostNotificationsStore.getState().byId["done-unread"].readAt,
      ).toBeTypeOf("number");
    });

    await waitFor(() => {
      expect(toastFromHostError).toHaveBeenCalledTimes(1);
    });
    expect(toastFromHostError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "E_HOST_UNSUPPORTED",
        method: "host.notifications.resolve",
      }),
      "Couldn't dismiss the notifications.",
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "This needs a newer Traycer host. Update the host to continue.",
      {
        id: "host-error:E_HOST_UNSUPPORTED:E_HOST_UNSUPPORTED",
        cancel: null,
      },
    );
    expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(0);
    expect(result.current.attentionIds).toEqual(["host:prompt-old-host"]);
    expect(entryResolvedAt("prompt-old-host")).toBeNull();
  });
});

describe("useMergedNotificationsActions row-level resolve", () => {
  beforeEach(() => {
    hostRequestMock.mockReset();
    hostRequestMock.mockImplementation(defaultHostRequest);
    hostBindingState.current = null;
    vi.mocked(toastFromHostError).mockClear();
    vi.mocked(toast.error).mockClear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-actions");
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
  });

  afterEach(() => {
    cleanup();
    hostBindingState.current = null;
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("no-ops when the host binding is retained but has no active host", async () => {
    // A disconnect keeps the runtime binding (`client !== null`) and the
    // rendered blocking row, but drops the active host id to null. The Dismiss
    // tick stays clickable, yet firing resolve then would only yield an
    // unbound-rejection toast while the row cannot change - so it must no-op,
    // mirroring markAllAsRead's dismiss-all active-host gate.
    hostBindingState.current = {
      hostClient: {
        request: hostRequestMock,
        getActiveHostId: () => null,
      },
    };
    applyHostSnapshot([hostPrompt("prompt-a", 200, null)], {
      unreadCount: 1,
      attentionCount: 1,
    });

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        row: useMergedNotificationRow("host:prompt-a"),
      }),
      { wrapper: createWrapper() },
    );

    const row = result.current.row;
    expect(row).not.toBeNull();
    if (row === null) return;

    act(() => {
      result.current.actions.resolve(row);
    });
    // Flush any scheduled mutation so a regression that dropped the guard would
    // surface the resolve RPC here rather than pass on an unflushed microtask.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });

    expect(
      hostRequestMock.mock.calls.some(
        (call) => call[0] === "host.notifications.resolve",
      ),
    ).toBe(false);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(vi.mocked(toastFromHostError)).not.toHaveBeenCalled();
  });

  it("fires the resolve RPC with the occurrence token when an active host is bound", async () => {
    bindHostClient();
    applyHostSnapshot([hostPrompt("prompt-a", 200, null)], {
      unreadCount: 1,
      attentionCount: 1,
    });

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        row: useMergedNotificationRow("host:prompt-a"),
      }),
      { wrapper: createWrapper() },
    );

    const row = result.current.row;
    expect(row).not.toBeNull();
    if (row === null) return;

    act(() => {
      result.current.actions.resolve(row);
    });

    await waitFor(() => {
      expect(
        hostRequestMock.mock.calls.some(
          (call) => call[0] === "host.notifications.resolve",
        ),
      ).toBe(true);
    });
  });
});
