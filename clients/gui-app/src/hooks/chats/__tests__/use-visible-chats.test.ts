import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisibleChats } from "@/hooks/chats/use-visible-chats";

// The two registries are the seam: real ones hold whole chat and epic sessions
// (streams, replicas), and this hook reads only a store's `getState()` and
// `subscribe()` off each handle. Tiny fakes with exactly that surface let the
// hook's own logic - what it collects, and when it hands back the same map -
// be driven directly.
interface FakeStore<S> {
  getState: () => S;
  setState: (next: S) => void;
  subscribe: (listener: (state: S, previous: S) => void) => () => void;
}
interface FakeRegistry<H> {
  handles: H[];
  add: (handle: H) => void;
  listHandles: () => H[];
  liveHandles: () => H[];
  subscribe: (listener: () => void) => () => void;
}

const fakes = vi.hoisted(() => {
  function makeStore<S>(initial: S): FakeStore<S> {
    let state = initial;
    const listeners = new Set<(state: S, previous: S) => void>();
    return {
      getState: () => state,
      setState: (next) => {
        const previous = state;
        state = next;
        for (const listener of [...listeners]) listener(state, previous);
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }
  function makeRegistry<H>(): FakeRegistry<H> {
    const listeners = new Set<() => void>();
    const registry: FakeRegistry<H> = {
      handles: [],
      add: (handle) => {
        registry.handles.push(handle);
        for (const listener of [...listeners]) listener();
      },
      listHandles: () => registry.handles,
      liveHandles: () => registry.handles,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return registry;
  }
  return { makeStore, makeRegistry };
});

interface EpicState {
  chats: {
    byId: Record<
      string,
      { id: string; title: string | null; hostId: string | null }
    >;
  };
}
interface ChatState {
  worktreeBinding: {
    entries: ReadonlyArray<{
      isPrimary: boolean;
      branch: string | null;
      repoIdentifier: { owner: string; repo: string } | null;
    }>;
  } | null;
}
interface EpicHandle {
  store: FakeStore<EpicState>;
}
interface ChatHandle {
  chatId: string;
  hostId: string | null;
  store: FakeStore<ChatState>;
}

const chatRegistry = vi.hoisted(() => fakes.makeRegistry<ChatHandle>());
const epicRegistry = vi.hoisted(() => fakes.makeRegistry<EpicHandle>());

vi.mock("@/lib/registries/chat-session-registry", () => ({
  getChatSessionRegistry: () => chatRegistry,
  getChatSessionHandleHostId: (handle: ChatHandle) => handle.hostId,
}));
vi.mock("@/lib/registries/epic-session-registry", () => ({
  getOpenEpicRegistry: () => epicRegistry,
}));

function epicHandle(
  chats: EpicState["chats"]["byId"],
): EpicHandle & { store: FakeStore<EpicState> } {
  return { store: fakes.makeStore<EpicState>({ chats: { byId: chats } }) };
}

function chatHandle(
  chatId: string,
  hostId: string | null,
  worktreeBinding: ChatState["worktreeBinding"],
): ChatHandle {
  return {
    chatId,
    hostId,
    store: fakes.makeStore<ChatState>({ worktreeBinding }),
  };
}

beforeEach(() => {
  chatRegistry.handles = [];
  epicRegistry.handles = [];
});

afterEach(cleanup);

describe("useVisibleChats", () => {
  it("is empty when no session is open", () => {
    const { result } = renderHook(() => useVisibleChats());

    expect(result.current.size).toBe(0);
  });

  it("takes a chat's title and host from an open epic", () => {
    epicRegistry.handles.push(
      epicHandle({
        "chat-1": { id: "chat-1", title: "Fix the build", hostId: "host-a" },
      }),
    );

    const { result } = renderHook(() => useVisibleChats());

    expect(result.current.get("chat-1")).toEqual({
      title: "Fix the build",
      hostId: "host-a",
      workspace: { remote: null, branch: null },
    });
  });

  it("takes a chat's workspace from its session's worktree binding", () => {
    chatRegistry.handles.push(
      chatHandle("chat-2", "host-b", {
        entries: [
          {
            isPrimary: true,
            branch: "feature-x",
            repoIdentifier: { owner: "acme", repo: "web" },
          },
        ],
      }),
    );

    const { result } = renderHook(() => useVisibleChats());

    expect(result.current.get("chat-2")).toEqual({
      title: null,
      hostId: "host-b",
      workspace: { remote: "acme/web", branch: "feature-x" },
    });
  });

  it("joins an epic's title with the same chat's session workspace", () => {
    epicRegistry.handles.push(
      epicHandle({
        "chat-3": { id: "chat-3", title: "Both", hostId: "host-c" },
      }),
    );
    chatRegistry.handles.push(
      chatHandle("chat-3", "host-other", {
        entries: [
          {
            isPrimary: true,
            branch: null,
            repoIdentifier: { owner: "acme", repo: "api" },
          },
        ],
      }),
    );

    const { result } = renderHook(() => useVisibleChats());

    expect(result.current.get("chat-3")).toEqual({
      title: "Both",
      hostId: "host-c",
      workspace: { remote: "acme/api", branch: null },
    });
  });

  it("returns the same map instance across an update that changes nothing it reads", () => {
    const epic = epicHandle({
      "chat-1": { id: "chat-1", title: "Stable", hostId: "host-a" },
    });
    epicRegistry.handles.push(epic);
    const { result } = renderHook(() => useVisibleChats());
    const first = result.current;

    // A fresh `chats` object with identical content: the store notifies, the
    // hook re-reads, and the content-keyed cache hands back the SAME map.
    act(() => {
      epic.store.setState({
        chats: {
          byId: {
            "chat-1": { id: "chat-1", title: "Stable", hostId: "host-a" },
          },
        },
      });
    });

    expect(result.current).toBe(first);
  });

  it("returns a new map when a title it reads changes", () => {
    const epic = epicHandle({
      "chat-1": { id: "chat-1", title: "Before", hostId: "host-a" },
    });
    epicRegistry.handles.push(epic);
    const { result } = renderHook(() => useVisibleChats());
    const first = result.current;

    act(() => {
      epic.store.setState({
        chats: {
          byId: {
            "chat-1": { id: "chat-1", title: "After", hostId: "host-a" },
          },
        },
      });
    });

    expect(result.current).not.toBe(first);
    expect(result.current.get("chat-1")?.title).toBe("After");
  });

  it("picks up a session opened after the hook mounted", () => {
    const { result } = renderHook(() => useVisibleChats());
    expect(result.current.size).toBe(0);

    act(() => {
      chatRegistry.add(chatHandle("chat-9", "host-z", null));
    });

    expect(result.current.get("chat-9")?.hostId).toBe("host-z");
  });
});
