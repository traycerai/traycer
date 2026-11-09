import { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEpicDeleteAgentSubtree } from "@/hooks/epic/use-epic-delete-agent-subtree";

const deletionRuntime = vi.hoisted(() => {
  const calls: Array<{
    kind: "chat" | "terminal-agent";
    id: string;
    hostId: string;
  }> = [];
  const preparedIds: string[] = [];
  const rolledBackIds: string[] = [];
  let releaseFirst: (() => void) | null = null;
  let shouldHoldFirstChat = false;
  let failureChatId: string | null = null;
  let failureTuiAgentId: string | null = null;
  let blockedReason: string | null = null;
  let blockedReasonAfterFirstDelete: string | null = null;

  const node = (
    id: string,
    type: "chat" | "terminal-agent",
    parentId: string | null,
  ) => ({
    id,
    parentId,
    title: id,
    type,
    status: null,
    createdAt: 0,
    updatedAt: 0,
  });

  const makeState = () => ({
    chatRecordListAuthoritative: true,
    tuiAgentRecordListAuthoritative: true,
    tree: {
      rootIds: ["root"],
      childrenByParent: {
        root: ["chat-child", "terminal-child"],
        "chat-child": ["chat-grandchild"],
      },
      nodeById: {
        root: node("root", "chat", null),
        "chat-child": node("chat-child", "chat", "root"),
        "terminal-child": node("terminal-child", "terminal-agent", "root"),
        "chat-grandchild": node("chat-grandchild", "chat", "chat-child"),
      },
    },
    chats: {
      byId: {
        root: { hostId: "host-root", docResident: false },
        "chat-child": { hostId: "host-child", docResident: false },
        "chat-grandchild": { hostId: "host-grandchild", docResident: false },
      },
    },
    tuiAgents: {
      byId: { "terminal-child": { hostId: "host-terminal" } },
    },
  });
  let state = makeState();

  return {
    calls,
    preparedIds,
    rolledBackIds,
    get state() {
      return state;
    },
    resetState() {
      state = makeState();
    },
    setHoldFirstChat(value: boolean) {
      shouldHoldFirstChat = value;
    },
    setFailureChatId(id: string | null) {
      failureChatId = id;
    },
    setTuiAgentFailure(id: string | null) {
      failureTuiAgentId = id;
    },
    setBlockedReason(reason: string | null) {
      blockedReason = reason;
    },
    setBlockedReasonAfterFirstDelete(reason: string | null) {
      blockedReasonAfterFirstDelete = reason;
    },
    releaseFirst() {
      releaseFirst?.();
    },
    blockedReasonForState(current: typeof state): string | null {
      if (
        !current.chatRecordListAuthoritative ||
        !current.tuiAgentRecordListAuthoritative
      ) {
        return "Nested agents are still loading.";
      }
      return calls.length > 0 && blockedReasonAfterFirstDelete !== null
        ? blockedReasonAfterFirstDelete
        : blockedReason;
    },
    prepare(id: string): () => void {
      preparedIds.push(id);
      return () => rolledBackIds.push(id);
    },
    deleteChat: async (input: { chatId: string; hostId: string }) => {
      calls.push({ kind: "chat", id: input.chatId, hostId: input.hostId });
      if (calls.length === 1 && shouldHoldFirstChat) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      if (input.chatId === failureChatId) throw new Error("delete rejected");
      return { deleted: true, outcome: "applied" as const };
    },
    deleteTuiAgent: (input: { tuiAgentId: string; hostId: string }) => {
      calls.push({
        kind: "terminal-agent",
        id: input.tuiAgentId,
        hostId: input.hostId,
      });
      return Promise.resolve({
        deleted: input.tuiAgentId !== failureTuiAgentId,
        outcome: "applied" as const,
      });
    },
  };
});

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({
    epicId: "epic-cascade-test",
    store: { getState: () => deletionRuntime.state },
  }),
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "session-host",
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicDeleteChatInBatch: () => ({ mutateAsync: deletionRuntime.deleteChat }),
}));

vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicDeleteTuiAgentInBatch: () => ({
    mutateAsync: deletionRuntime.deleteTuiAgent,
  }),
}));

vi.mock("@/lib/epics/agent-subtree-delete", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/epics/agent-subtree-delete")>();
  return {
    ...actual,
    agentSubtreeDeleteBlockedReason: (state: typeof deletionRuntime.state) =>
      deletionRuntime.blockedReasonForState(state),
  };
});

vi.mock("@/lib/epics/prepare-agent-delete", () => ({
  prepareAgentDelete: (_handle: unknown, id: string) =>
    deletionRuntime.prepare(id),
}));

const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false } },
});

function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const CONFIRMED_IDS = [
  "chat-grandchild",
  "chat-child",
  "terminal-child",
  "root",
] as const;

describe("useEpicDeleteAgentSubtree", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    queryClient.clear();
    deletionRuntime.calls.length = 0;
    deletionRuntime.preparedIds.length = 0;
    deletionRuntime.rolledBackIds.length = 0;
    deletionRuntime.setHoldFirstChat(false);
    deletionRuntime.setFailureChatId(null);
    deletionRuntime.setTuiAgentFailure(null);
    deletionRuntime.setBlockedReason(null);
    deletionRuntime.setBlockedReasonAfterFirstDelete(null);
    deletionRuntime.resetState();
  });

  it("deletes the confirmed all-depth mixed-host snapshot leaf-first", async () => {
    const { result } = renderHook(() => useEpicDeleteAgentSubtree(), {
      wrapper,
    });

    let deleted = false;
    await act(async () => {
      deleted = await result.current.deleteSubtree("root", CONFIRMED_IDS);
    });

    expect(deleted).toBe(true);
    expect(deletionRuntime.calls).toEqual([
      { kind: "chat", id: "chat-grandchild", hostId: "host-grandchild" },
      { kind: "chat", id: "chat-child", hostId: "host-child" },
      { kind: "terminal-agent", id: "terminal-child", hostId: "host-terminal" },
      { kind: "chat", id: "root", hostId: "host-root" },
    ]);
    expect(deletionRuntime.preparedIds).toEqual([...CONFIRMED_IDS]);
  });

  it("keeps membership and host snapshots while earlier deletes are pending", async () => {
    deletionRuntime.setHoldFirstChat(true);
    const { result } = renderHook(() => useEpicDeleteAgentSubtree(), {
      wrapper,
    });
    let deletion: Promise<boolean> | null = null;

    act(() => {
      deletion = result.current.deleteSubtree("root", CONFIRMED_IDS);
    });
    await waitFor(() => expect(deletionRuntime.calls).toHaveLength(1));
    deletionRuntime.state.tree.childrenByParent.root = [];
    deletionRuntime.state.tree.childrenByParent["chat-child"] = [];
    deletionRuntime.state.chats.byId["chat-child"].hostId =
      "host-child-after-snapshot";

    await act(async () => {
      deletionRuntime.releaseFirst();
      await deletion;
    });

    expect(deletionRuntime.calls.map(({ id }) => id)).toEqual([
      "chat-grandchild",
      "chat-child",
      "terminal-child",
      "root",
    ]);
    expect(deletionRuntime.calls[0]?.hostId).toBe("host-grandchild");
    expect(deletionRuntime.calls[1]?.hostId).toBe("host-child");
  });

  it("stops on the first rejected delete and rolls back that member", async () => {
    deletionRuntime.setFailureChatId("chat-child");
    const { result } = renderHook(() => useEpicDeleteAgentSubtree(), {
      wrapper,
    });

    let deleted = true;
    await act(async () => {
      deleted = await result.current.deleteSubtree("root", CONFIRMED_IDS);
    });
    await waitFor(() =>
      expect(result.current.mutation.error?.message).toContain(
        "Deleted 1 of 4 agents",
      ),
    );

    expect(deleted).toBe(false);
    expect(deletionRuntime.calls).toEqual([
      { kind: "chat", id: "chat-grandchild", hostId: "host-grandchild" },
      { kind: "chat", id: "chat-child", hostId: "host-child" },
    ]);
    expect(deletionRuntime.rolledBackIds).toEqual(["chat-child"]);
    expect(result.current.mutation.isPending).toBe(false);
  });

  it("stops when a terminal-agent delete reports false after an earlier delete succeeds", async () => {
    deletionRuntime.setTuiAgentFailure("terminal-child");
    const { result } = renderHook(() => useEpicDeleteAgentSubtree(), {
      wrapper,
    });

    let deleted = true;
    await act(async () => {
      deleted = await result.current.deleteSubtree("root", CONFIRMED_IDS);
    });
    await waitFor(() =>
      expect(result.current.mutation.error?.message).toContain(
        "Deleted 2 of 4 agents",
      ),
    );

    expect(deleted).toBe(false);
    expect(deletionRuntime.calls.map(({ id }) => id)).toEqual([
      "chat-grandchild",
      "chat-child",
      "terminal-child",
    ]);
    expect(deletionRuntime.rolledBackIds).toEqual(["terminal-child"]);
  });

  it("refuses a confirmation snapshot that no longer matches the tree", async () => {
    const { result } = renderHook(() => useEpicDeleteAgentSubtree(), {
      wrapper,
    });

    let deleted = true;
    await act(async () => {
      deleted = await result.current.deleteSubtree("root", ["root"]);
    });
    await waitFor(() =>
      expect(result.current.mutation.error?.message).toContain(
        "nested agents changed",
      ),
    );

    expect(deleted).toBe(false);
    expect(deletionRuntime.calls).toEqual([]);
  });

  it("refuses a blocker before dispatch and reports the blocking reason", async () => {
    deletionRuntime.setBlockedReason("“chat-child” is working.");
    const { result } = renderHook(() => useEpicDeleteAgentSubtree(), {
      wrapper,
    });

    let deleted = true;
    await act(async () => {
      deleted = await result.current.deleteSubtree("root", CONFIRMED_IDS);
    });
    await waitFor(() =>
      expect(result.current.mutation.error?.message).toContain("chat-child"),
    );

    expect(deleted).toBe(false);
    expect(deletionRuntime.calls).toEqual([]);
  });

  it("rechecks blockers before each delete and leaves remaining parents untouched", async () => {
    deletionRuntime.setBlockedReasonAfterFirstDelete(
      "“chat-child” is working.",
    );
    const { result } = renderHook(() => useEpicDeleteAgentSubtree(), {
      wrapper,
    });

    let deleted = true;
    await act(async () => {
      deleted = await result.current.deleteSubtree("root", CONFIRMED_IDS);
    });
    await waitFor(() =>
      expect(result.current.mutation.error?.message).toContain(
        "Deleted 1 of 4 agents",
      ),
    );

    expect(deleted).toBe(false);
    expect(deletionRuntime.calls.map(({ id }) => id)).toEqual([
      "chat-grandchild",
    ]);
  });

  it("refuses an incomplete chat-record snapshot before attempting any row", async () => {
    deletionRuntime.state.chatRecordListAuthoritative = false;
    const { result } = renderHook(() => useEpicDeleteAgentSubtree(), {
      wrapper,
    });

    let deleted = true;
    await act(async () => {
      deleted = await result.current.deleteSubtree("root", CONFIRMED_IDS);
    });
    await waitFor(() =>
      expect(result.current.mutation.error?.message).toContain(
        "Nested agents are still loading",
      ),
    );

    expect(deleted).toBe(false);
    expect(deletionRuntime.calls).toEqual([]);
  });

  it("refuses an incomplete terminal-agent record snapshot before attempting any row", async () => {
    deletionRuntime.state.tuiAgentRecordListAuthoritative = false;
    const { result } = renderHook(() => useEpicDeleteAgentSubtree(), {
      wrapper,
    });

    let deleted = true;
    await act(async () => {
      deleted = await result.current.deleteSubtree("root", CONFIRMED_IDS);
    });
    await waitFor(() =>
      expect(result.current.mutation.error?.message).toContain(
        "Nested agents are still loading",
      ),
    );

    expect(deleted).toBe(false);
    expect(deletionRuntime.calls).toEqual([]);
  });
});
