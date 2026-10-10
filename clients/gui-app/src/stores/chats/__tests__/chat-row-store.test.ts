import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  AgentSender,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatSessionStoreHandle,
  LiveAssistantMessage,
} from "@/stores/chats/chat-session-store";
import { createTestChatSession } from "@/stores/chats/test-support/create-test-chat-session";

const ASSISTANT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

function activeTurn(turnId: string): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId,
    status: "running",
    harnessId: "claude",
    model: "claude-sonnet-4-5",
    profileId: null,
    userMessageId: null,
    startedAt: 1,
    updatedAt: 2,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function content(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function userMessage(
  messageId: string,
  text: string,
  timestamp: number,
): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: content(text), browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ContentBlock = AssistantMessage["blocks"][number];

function settledAssistantWithTodo(turnId: string): AssistantMessage {
  const blocks: ContentBlock[] = [
    {
      blockId: `${turnId}-todo`,
      type: "tool_call",
      status: "completed",
      timestamp: 1500,
      toolName: "TaskCreate",
      inputSummary: null,
      inputDetail: null,
      taskTodoItems: [
        {
          id: null,
          text: "ship it",
          status: null,
          priority: null,
          activeForm: null,
          action: "create",
        },
      ],
      error: null,
      agentMessageSend: null,
      managedCommand: null,
      agentMessageReceipt: null,
      progress: null,
      backgroundOutput: null,
      startedAt: null,
      endedAt: null,
      backgroundTask: false,
      stopped: false,
      imageResults: [],
      page: null,
      mcpApp: null,
    },
    {
      type: "text",
      blockId: `${turnId}-text`,
      status: "completed",
      timestamp: 1600,
      text: "done",
      providerNotice: null,
    },
  ];
  return {
    role: "assistant",
    messageId: `a-${turnId}`,
    sender: ASSISTANT_SENDER,
    blocks,
    startedAt: 1500,
    timestamp: 1700,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function liveAssistant(
  turnId: string,
  text: string,
  blocksVersion: number,
): LiveAssistantMessage {
  return {
    turnId,
    blocks: [
      {
        type: "text",
        blockId: "text-1",
        text,
        status: "streaming",
        timestamp: 10 + blocksVersion,
        providerNotice: null,
      },
    ],
    startedAt: 2000,
    blocksVersion,
    imageResolutions: [],
    imageResolutionsVersion: 0,
    timestamp: 2000,
    sender: ASSISTANT_SENDER,
    reasoningEffort: null,
    serviceTier: null,
  };
}

let session: ChatSessionStoreHandle | null = null;

function openSession(): ChatSessionStoreHandle {
  session = createTestChatSession();
  return session;
}

afterEach(() => {
  session?.dispose();
  session = null;
});

describe("session row store", () => {
  it("keeps settled rows and rowIds by identity while the live row streams", () => {
    const { store: source, rows } = openSession();
    source.setState({
      messages: [userMessage("u-1", "hello", 1000)],
      activeTurn: activeTurn("turn-1"),
      runStatus: "running",
      liveAssistantMessage: liveAssistant("turn-1", "a", 1),
    });
    const before = rows.getState();
    expect(before.rowIds).toEqual(["u-1", "assistant:turn-1"]);
    expect(before.settledRows.map((row) => row.id)).toEqual(["u-1"]);
    expect(before.liveRows.map((row) => row.id)).toEqual(["assistant:turn-1"]);

    source.setState({ liveAssistantMessage: liveAssistant("turn-1", "ab", 2) });

    const after = rows.getState();
    expect(after.rowIds).toBe(before.rowIds);
    expect(after.settledRows).toBe(before.settledRows);
    expect(after.listEntries).toBe(before.listEntries);
    expect(after.liveRows).not.toBe(before.liveRows);
    expect(after.byId.get("assistant:turn-1")).not.toBe(
      before.byId.get("assistant:turn-1"),
    );
  });

  it("keeps a settled row that carries a pinned todo by identity while the next turn streams", () => {
    // The pinned todo strips the TaskCreate segment out of its turn's row. That
    // stripped copy used to be rebuilt on every token, cloning a settled row.
    const { store: source, rows } = openSession();
    source.setState({
      messages: [
        userMessage("u-1", "hello", 1000),
        settledAssistantWithTodo("turn-1"),
      ],
      activeTurn: activeTurn("turn-2"),
      runStatus: "running",
      liveAssistantMessage: liveAssistant("turn-2", "a", 1),
    });
    const before = rows.getState();
    expect(before.todo?.items.map((item) => item.text)).toEqual(["ship it"]);
    const settledIds = before.settledRows.map((row) => row.id);
    expect(settledIds).toContain("assistant:turn-1");

    source.setState({ liveAssistantMessage: liveAssistant("turn-2", "ab", 2) });

    const after = rows.getState();
    expect(after.settledRows).toBe(before.settledRows);
    expect(after.todo).toBe(before.todo);
    expect(after.byId.get("assistant:turn-1")).toBe(
      before.byId.get("assistant:turn-1"),
    );
  });

  it("publishes new settled rows when a persisted message is corrected", () => {
    const { store: source, rows } = openSession();
    source.setState({ messages: [userMessage("u-1", "hello", 1000)] });
    const before = rows.getState();

    source.setState({
      messages: [userMessage("u-1", "hello, corrected", 1000)],
    });

    const after = rows.getState();
    expect(after.settledRows).not.toBe(before.settledRows);
    expect(after.byId.get("u-1")).not.toBe(before.byId.get("u-1"));
    expect(after.rowIds).toBe(before.rowIds);
  });

  it("stops following the session store once the handle is disposed", () => {
    const handle = openSession();
    handle.dispose();
    const before = handle.rows.getState();

    handle.store.setState({ messages: [userMessage("u-1", "late", 1000)] });

    expect(handle.rows.getState()).toBe(before);
  });
});
