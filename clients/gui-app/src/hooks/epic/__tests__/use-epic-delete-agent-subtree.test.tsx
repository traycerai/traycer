import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEpicDeleteAgentSubtree } from "@/hooks/epic/use-epic-delete-agent-subtree";

const deletionRuntime = vi.hoisted(() => {
  const calls: Array<{
    kind: "chat" | "terminal-agent";
    id: string;
    hostId: string;
  }> = [];
  let releaseFirst: (() => void) | null = null;
  let shouldHoldFirstChat = false;
  let failureChatId: string | null = null;
  let failureTuiAgentId: string | null = null;

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
    releaseFirst() {
      releaseFirst?.();
    },
    deleteChat: async (input: { chatId: string; hostId: string }) => {
      calls.push({ kind: "chat", id: input.chatId, hostId: input.hostId });
      if (calls.length === 1) {
        if (shouldHoldFirstChat) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      }
      if (input.chatId === failureChatId) throw new Error("delete rejected");
      return { deleted: true };
    },
    deleteTuiAgent: (input: { tuiAgentId: string; hostId: string }) => {
      calls.push({
        kind: "terminal-agent",
        id: input.tuiAgentId,
        hostId: input.hostId,
      });
      return Promise.resolve({
        deleted: input.tuiAgentId !== failureTuiAgentId,
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
  useEpicDeleteChat: () => ({ mutateAsync: deletionRuntime.deleteChat }),
}));

vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicDeleteTuiAgent: () => ({
    mutateAsync: deletionRuntime.deleteTuiAgent,
  }),
}));

vi.mock("@/hooks/epic/use-chat-write-route", () => ({
  resolveChatWriteRoute: () => "registry-rpc",
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

describe("useEpicDeleteAgentSubtree", () => {
  beforeEach(() => {
    deletionRuntime.calls.length = 0;
    deletionRuntime.setHoldFirstChat(false);
    deletionRuntime.setFailureChatId(null);
    deletionRuntime.setTuiAgentFailure(null);
    deletionRuntime.resetState();
  });

  it("deletes the all-depth mixed-host snapshot leaf-first", async () => {
    const { result } = renderHook(() => useEpicDeleteAgentSubtree());

    await act(async () => {
      await result.current.deleteSubtree("root");
    });

    expect(deletionRuntime.calls).toEqual([
      { kind: "chat", id: "chat-grandchild", hostId: "host-grandchild" },
      { kind: "chat", id: "chat-child", hostId: "host-child" },
      { kind: "terminal-agent", id: "terminal-child", hostId: "host-terminal" },
      { kind: "chat", id: "root", hostId: "host-root" },
    ]);
  });

  it("keeps the membership and host snapshot while earlier deletes are pending", async () => {
    deletionRuntime.setHoldFirstChat(true);
    const { result } = renderHook(() => useEpicDeleteAgentSubtree());
    let deletion: Promise<void> | null = null;

    act(() => {
      deletion = result.current.deleteSubtree("root");
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

  it("stops on the first rejected delete and leaves its parents and remaining rows unattempted", async () => {
    deletionRuntime.setFailureChatId("chat-child");
    const { result } = renderHook(() => useEpicDeleteAgentSubtree());

    await act(async () => {
      await expect(result.current.deleteSubtree("root")).rejects.toThrow(
        "delete rejected",
      );
    });

    expect(deletionRuntime.calls).toEqual([
      { kind: "chat", id: "chat-grandchild", hostId: "host-grandchild" },
      { kind: "chat", id: "chat-child", hostId: "host-child" },
    ]);
    expect(result.current.isPending).toBe(false);
  });

  it("stops when a terminal-agent delete reports false after an earlier delete succeeds", async () => {
    deletionRuntime.setTuiAgentFailure("terminal-child");
    const { result } = renderHook(() => useEpicDeleteAgentSubtree());

    await act(async () => {
      await expect(result.current.deleteSubtree("root")).rejects.toThrow(
        "Couldn't delete agent.",
      );
    });

    expect(deletionRuntime.calls).toEqual([
      { kind: "chat", id: "chat-grandchild", hostId: "host-grandchild" },
      { kind: "chat", id: "chat-child", hostId: "host-child" },
      { kind: "terminal-agent", id: "terminal-child", hostId: "host-terminal" },
    ]);
  });

  it("refuses an incomplete chat-record snapshot before attempting any row", async () => {
    deletionRuntime.state.chatRecordListAuthoritative = false;
    const { result } = renderHook(() => useEpicDeleteAgentSubtree());

    await act(async () => {
      await expect(result.current.deleteSubtree("root")).rejects.toThrow(
        "Nested agents are still loading",
      );
    });

    expect(deletionRuntime.calls).toEqual([]);
  });

  it("refuses an incomplete terminal-agent record snapshot before attempting any row", async () => {
    deletionRuntime.state.tuiAgentRecordListAuthoritative = false;
    const { result } = renderHook(() => useEpicDeleteAgentSubtree());

    await act(async () => {
      await expect(result.current.deleteSubtree("root")).rejects.toThrow(
        "Nested agents are still loading",
      );
    });

    expect(deletionRuntime.calls).toEqual([]);
  });
});
