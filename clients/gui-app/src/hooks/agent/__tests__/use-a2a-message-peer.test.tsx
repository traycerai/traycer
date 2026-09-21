import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentMessagePeer,
  AgentMessagePeerOrigin,
} from "@traycer/protocol/host/agent/message-peer";
import { useA2AMessagePeer } from "@/hooks/agent/use-a2a-message-peer";

interface QueryArgs {
  readonly client: unknown;
  readonly method: string;
  readonly params: {
    readonly epicId: string;
    readonly chatId: string;
    readonly agentId: string;
    readonly origin: AgentMessagePeerOrigin | null;
  };
  readonly options: { readonly enabled: boolean };
}

interface LocalNode {
  readonly id: string;
  readonly title: string;
  readonly hostId: string | null;
  readonly harnessId?: string;
}

type PeerResponse = { readonly peer: AgentMessagePeer | null } | undefined;

const mocks = vi.hoisted(() => ({
  local: null as LocalNode | null,
  transcript: null as { chatId: string } | null,
  /** Response of the primary query (`origin: null`). */
  primary: undefined as PeerResponse,
  primaryError: null as { code: string } | null,
  /** Response of the per-message origin query. */
  inherited: undefined as PeerResponse,
  live: undefined as { title: string } | undefined,
  liveRefs: [] as unknown[],
  queryArgs: [] as unknown[],
  client: { tag: "tab-host-client" },
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-current",
  useEpicAgentReference: () => mocks.local,
  useRegisteredEpicLiveAgents: (refs: readonly unknown[]) => {
    mocks.liveRefs.push(refs);
    return [mocks.live];
  },
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "tab-host",
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));

vi.mock("@/components/chat/chat-transcript-context", () => ({
  useMaybeChatTranscript: () => mocks.transcript,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: QueryArgs) => {
    mocks.queryArgs.push(args);
    if (args.params.origin === null) {
      return { data: mocks.primary, error: mocks.primaryError };
    }
    return { data: mocks.inherited, error: null };
  },
}));

/** Queries issued by the LAST render, keyed by whether they carry an origin. */
function lastRender(): { primary: QueryArgs; inherited: QueryArgs } {
  const [primary, inherited] = mocks.queryArgs.slice(-2) as [
    QueryArgs,
    QueryArgs,
  ];
  return { primary, inherited };
}

const REMOTE: AgentMessagePeer = {
  epicId: "epic-other",
  agentId: "agent-remote-1",
  hostId: "host-remote",
  title: "Remote Title",
  surface: "gui",
};

const SENT_ORIGIN: AgentMessagePeerOrigin = {
  direction: "sent",
  messageId: "receiver-message-1",
};

describe("useA2AMessagePeer", () => {
  beforeEach(() => {
    mocks.local = null;
    mocks.transcript = { chatId: "chat-current" };
    mocks.primary = undefined;
    mocks.primaryError = null;
    mocks.inherited = undefined;
    mocks.live = undefined;
    mocks.liveRefs = [];
    mocks.queryArgs = [];
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses an exact current-task projection hit and keeps both RPCs disabled", () => {
    mocks.local = {
      id: "agent-local-1",
      title: "Local Title",
      hostId: "host-local",
    };

    const { result } = renderHook(() =>
      useA2AMessagePeer("agent-local-1", SENT_ORIGIN),
    );

    expect(result.current).toEqual({
      epicId: "epic-current",
      agentId: "agent-local-1",
      hostId: "host-local",
      title: "Local Title",
      surface: "gui",
    });
    const { primary, inherited } = lastRender();
    expect(primary.options.enabled).toBe(false);
    expect(inherited.options.enabled).toBe(false);
  });

  it("falls back to the tab host for an optimistic node, and maps a terminal agent and empty title", () => {
    mocks.local = {
      id: "agent-tui-1",
      title: "",
      hostId: null,
      harnessId: "claude",
    };

    const { result } = renderHook(() => useA2AMessagePeer("agent-tui-1", null));

    expect(result.current).toEqual({
      epicId: "epic-current",
      agentId: "agent-tui-1",
      hostId: "tab-host",
      title: null,
      surface: "tui",
    });
  });

  it("issues the primary query with origin null: current task, this transcript's chat, tab client, given id", () => {
    renderHook(() => useA2AMessagePeer("agent-rem", SENT_ORIGIN));

    const { primary } = lastRender();
    expect(primary.method).toBe("agent.resolveMessagePeer");
    expect(primary.client).toBe(mocks.client);
    expect(primary.params).toEqual({
      epicId: "epic-current",
      chatId: "chat-current",
      agentId: "agent-rem",
      origin: null,
    });
    expect(primary.options.enabled).toBe(true);
  });

  it("returns the resolved remote peer and keys live titles by the canonical peer", () => {
    mocks.primary = { peer: REMOTE };

    const { result } = renderHook(() =>
      useA2AMessagePeer("agent-rem", SENT_ORIGIN),
    );

    expect(result.current).toEqual(REMOTE);
    expect(mocks.liveRefs[mocks.liveRefs.length - 1]).toEqual([
      { epicId: "epic-other", agentId: "agent-remote-1" },
    ]);
  });

  it("prefers the current registered live title over the resolved title", () => {
    mocks.primary = { peer: REMOTE };
    mocks.live = { title: "Renamed Live" };

    const { result } = renderHook(() =>
      useA2AMessagePeer("agent-rem", SENT_ORIGIN),
    );

    expect(result.current).toEqual({ ...REMOTE, title: "Renamed Live" });
  });

  it("keeps the resolved title when the live title is empty or whitespace", () => {
    mocks.primary = { peer: REMOTE };
    for (const blank of ["", "   \n\t"]) {
      mocks.live = { title: blank };

      const { result } = renderHook(() =>
        useA2AMessagePeer("agent-rem", SENT_ORIGIN),
      );

      expect(result.current).toEqual(REMOTE);
    }
  });

  it("stays null-titled when both the live and the resolved titles are blank, so the card's own fallback applies", () => {
    mocks.primary = { peer: { ...REMOTE, title: null } };
    for (const blank of ["", "  "]) {
      mocks.live = { title: blank };

      const { result } = renderHook(() =>
        useA2AMessagePeer("agent-rem", SENT_ORIGIN),
      );

      expect(result.current).toEqual({ ...REMOTE, title: null });
    }
  });

  it("maps an empty or whitespace-only exact local title to null", () => {
    for (const blank of ["", "   \n"]) {
      mocks.local = {
        id: "agent-local-1",
        title: blank,
        hostId: "host-local",
      };

      const { result } = renderHook(() =>
        useA2AMessagePeer("agent-local-1", null),
      );

      expect(result.current).toMatchObject({
        agentId: "agent-local-1",
        title: null,
      });
    }
  });

  describe("forked chats (inherited cards)", () => {
    it("does not run the origin query while the primary is pending or resolved", () => {
      renderHook(() => useA2AMessagePeer("agent-rem", SENT_ORIGIN));
      expect(lastRender().inherited.options.enabled).toBe(false);

      mocks.primary = { peer: REMOTE };
      renderHook(() => useA2AMessagePeer("agent-rem", SENT_ORIGIN));
      expect(lastRender().inherited.options.enabled).toBe(false);
    });

    it("does not run the origin query when the card has no origin", () => {
      mocks.primary = { peer: null };

      renderHook(() => useA2AMessagePeer("agent-rem", null));

      expect(lastRender().inherited.options.enabled).toBe(false);
    });

    it("asks by receiver message id after the primary misses, and resolves the true peer", () => {
      mocks.primary = { peer: null };
      mocks.inherited = { peer: REMOTE };

      const { result } = renderHook(() =>
        useA2AMessagePeer("agent-rem", SENT_ORIGIN),
      );

      const { inherited } = lastRender();
      expect(inherited.options.enabled).toBe(true);
      expect(inherited.params).toEqual({
        epicId: "epic-current",
        chatId: "chat-current",
        agentId: "agent-rem",
        origin: SENT_ORIGIN,
      });
      expect(result.current).toEqual(REMOTE);
    });

    it("forwards a received-direction origin unchanged", () => {
      const received: AgentMessagePeerOrigin = {
        direction: "received",
        messageId: "message-9",
      };
      mocks.primary = { peer: null };
      mocks.inherited = { peer: { ...REMOTE, surface: "tui" } };

      const { result } = renderHook(() =>
        useA2AMessagePeer("agent-rem", received),
      );

      expect(lastRender().inherited.params.origin).toEqual(received);
      expect(result.current).toMatchObject({
        hostId: "host-remote",
        surface: "tui",
      });
    });
  });

  describe("a local short-id match never authorizes a link on its own", () => {
    const COLLIDING: LocalNode = {
      id: "abcd0001-local-unrelated",
      title: "Unrelated Local Chat",
      hostId: "host-local",
    };

    it("prefers the remote canonical result over a colliding local prefix", () => {
      mocks.local = COLLIDING;
      mocks.primary = { peer: REMOTE };

      const { result } = renderHook(() =>
        useA2AMessagePeer("abcd", SENT_ORIGIN),
      );

      expect(result.current).toEqual(REMOTE);
    });

    it("stays unlinked when the host reports null/ambiguous, even with a local prefix match", () => {
      mocks.local = COLLIDING;
      mocks.primary = { peer: null };
      mocks.inherited = { peer: null };

      const { result } = renderHook(() =>
        useA2AMessagePeer("abcd", SENT_ORIGIN),
      );

      expect(result.current).toBeNull();
    });

    it("stays unlinked while the host answer is still pending", () => {
      mocks.local = COLLIDING;

      const { result } = renderHook(() =>
        useA2AMessagePeer("abcd", SENT_ORIGIN),
      );

      expect(result.current).toBeNull();
    });

    it("may use the local prefix when there is no transcript to ask on behalf of", () => {
      mocks.local = COLLIDING;
      mocks.transcript = null;

      const { result } = renderHook(() => useA2AMessagePeer("abcd", null));

      expect(result.current).toMatchObject({ agentId: COLLIDING.id });
      expect(lastRender().primary.options.enabled).toBe(false);
    });

    it("may use the local prefix when the host does not support the method", () => {
      mocks.local = COLLIDING;
      mocks.primaryError = { code: "E_HOST_UNSUPPORTED" };

      const { result } = renderHook(() =>
        useA2AMessagePeer("abcd", SENT_ORIGIN),
      );

      expect(result.current).toMatchObject({ agentId: COLLIDING.id });
    });
  });

  it("is null while unresolved, when the host finds no peer, and asks for no live titles", () => {
    const pending = renderHook(() => useA2AMessagePeer("agent-rem", null));
    expect(pending.result.current).toBeNull();
    expect(mocks.liveRefs[mocks.liveRefs.length - 1]).toEqual([]);

    mocks.primary = { peer: null };
    const missing = renderHook(() => useA2AMessagePeer("agent-rem", null));
    expect(missing.result.current).toBeNull();
  });

  it("does not query outside a chat transcript", () => {
    mocks.transcript = null;

    const { result } = renderHook(() =>
      useA2AMessagePeer("agent-rem", SENT_ORIGIN),
    );

    const { primary, inherited } = lastRender();
    expect(primary.options.enabled).toBe(false);
    expect(inherited.options.enabled).toBe(false);
    expect(result.current).toBeNull();
  });
});
