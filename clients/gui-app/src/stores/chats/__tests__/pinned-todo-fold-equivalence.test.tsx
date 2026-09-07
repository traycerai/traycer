import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { projectTranscriptRows } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { buildPinnedTodoRenderState } from "@/components/chat/chat-pinned-todos";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
// The shared half of the fold, from protocol.
import {
  contentBlocksById,
  foldPinnedTodo,
} from "@traycer/protocol/persistence/chat-transcript/pinned-todo-fold";


const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const ASSISTANT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const BINDING = {
  epicId: "epic-1",
  ownerId: "owner-1",
  ownerKind: "chat" as const,
  viewTabId: "tab-1",
};

function userMessage(
  messageId: string,
  timestamp: number,
): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function taskCreateBlock(
  blockId: string,
  timestamp: number,
  text: string,
): ContentBlock {
  return {
    blockId,
    type: "tool_call",
    status: "completed",
    timestamp,
    toolName: "TaskCreate",
    inputSummary: null,
    inputDetail: null,
    taskTodoItems: [
      {
        id: null,
        text,
        status: null,
        priority: null,
        activeForm: null,
        action: "create",
      },
    ],
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    progress: null,
    backgroundOutput: null,
    startedAt: null,
    endedAt: null,
    backgroundTask: false,
    stopped: false,
    imageResults: [],
  };
}

function steerBlock(
  blockId: string,
  timestamp: number,
  queueItemId: string,
): ContentBlock {
  return {
    blockId,
    type: "steer",
    status: "completed",
    timestamp,
    queueItemId,
    messageId: `steered:${queueItemId}`,
    content: CONTENT,
    mode: "safe_point",
    sender: null,
  };
}

function assistantMessage(input: {
  messageId: string;
  timestamp: number;
  turnId: string;
  blocks: readonly ContentBlock[];
}): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: ASSISTANT_SENDER,
    // Copied rather than aliased: `AssistantMessage.blocks` is mutable, and a
    // `readonly` parameter cannot widen into it.
    blocks: [...input.blocks],
    startedAt: input.timestamp,
    timestamp: input.timestamp,
    turnId: input.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: (_sender, reasoningEffort) =>
    reasoningEffort === null ? null : `Resolved ${reasoningEffort}`,
  contentBlocksPreview: () => "",
};

const CANONICAL_INPUT: RenderedMessagesInput = {
  messages: [],
  events: [],
  rowContext: {},
  pendingUserMessages: [],
  liveAssistantMessage: null,
  activeTurn: null,
  runStatus: "idle",
  setupCardWindows: [],
  ...BINDING,
};

function rendererPinnedTodoTexts(input: RenderedMessagesInput): string[] {
  const { result } = renderHook(() =>
    useRenderedMessages(input, displayContext),
  );
  const state = buildPinnedTodoRenderState(result.current, {
    kind: "derive",
  });
  return (state.todo?.items ?? []).map((item) => item.text);
}

/** Runs the REAL host fold over the same raw records, for direct comparison. */
function hostPinnedTodoTexts(input: RenderedMessagesInput): string[] {
  const rows = projectTranscriptRows({
    messages: input.messages,
    events: input.events,
    activeTurnId: input.activeTurn?.turnId ?? null,
    // `ownerId`, matching what the renderer builds setup-card row ids from.
    chatId: input.ownerId,
  });
  // `.todo` is the SELECTED todo; the fold's other half (`taskItems`, the task accumulator) is what
  // the windowed client resumes from and is compared by `chat-pinned-todos.test.ts` rather than here
  const folded = foldPinnedTodo(rows, contentBlocksById(input.messages));
  return (folded.todo?.items ?? []).map((item) => item.text);
}

/**
 * Runs one fixture through BOTH the renderer's real projection and the
 * host's real fold and returns both answers for comparison.
 */
function bothPinnedTodoTexts(input: Partial<RenderedMessagesInput>): {
  rendererTexts: string[];
  hostTexts: string[];
} {
  const value: RenderedMessagesInput = { ...CANONICAL_INPUT, ...input };
  return {
    rendererTexts: rendererPinnedTodoTexts(value),
    hostTexts: hostPinnedTodoTexts(value),
  };
}

describe("pinned-todo fold: renderer/host equivalence (real code, both sides)", () => {
  it("accumulates task-todo items across turns", () => {
    const { rendererTexts, hostTexts } = bothPinnedTodoTexts({
      messages: [
        assistantMessage({
          messageId: "a1",
          timestamp: 10,
          turnId: "t1",
          blocks: [taskCreateBlock("task-create-1", 10, "First")],
        }),
        assistantMessage({
          messageId: "a2",
          timestamp: 20,
          turnId: "t2",
          blocks: [taskCreateBlock("task-create-2", 20, "Second")],
        }),
      ],
    });
    expect(rendererTexts).toEqual(["First", "Second"]);
    expect(hostTexts).toEqual(rendererTexts);
  });

  it("resets the accumulated task items on the first create after a user row", () => {
    const { rendererTexts, hostTexts } = bothPinnedTodoTexts({
      messages: [
        assistantMessage({
          messageId: "a1",
          timestamp: 10,
          turnId: "t1",
          blocks: [taskCreateBlock("task-create-old", 10, "Old task")],
        }),
        userMessage("u2", 15),
        assistantMessage({
          messageId: "a2",
          timestamp: 20,
          turnId: "t2",
          blocks: [taskCreateBlock("task-create-new", 20, "New task")],
        }),
      ],
    });
    expect(rendererTexts).toEqual(["New task"]);
    expect(hostTexts).toEqual(rendererTexts);
  });

  it('resets the accumulated task items on a steer row too - THE case the host\'s `|| source.kind === "steer"` branch exists for', () => {
    const { rendererTexts, hostTexts } = bothPinnedTodoTexts({
      messages: [
        assistantMessage({
          messageId: "a1",
          timestamp: 10,
          turnId: "t1",
          blocks: [
            taskCreateBlock("task-create-old", 10, "Old task"),
            steerBlock("steer-1", 15, "queue-1"),
            taskCreateBlock("task-create-new", 20, "New task"),
          ],
        }),
      ],
    });
    // A steer block splits the turn into its own `role: "user"` row on the renderer side
    // (`renderAssistantTurnRows` / `renderSteerBlockUserMessage`) and into its own `kind: "steer"` row
    expect(rendererTexts).toEqual(["New task"]);
    expect(hostTexts).toEqual(rendererTexts);
  });
});
