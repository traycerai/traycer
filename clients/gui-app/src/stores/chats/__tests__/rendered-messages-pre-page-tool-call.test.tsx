import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { normalizeV16InterviewFieldsInFrame } from "@traycer/protocol/host/agent/gui/chat-frame-compat";
import {
  chatSubscribeSnapshotServerFrameShallowSchema,
  chatSubscribeSnapshotServerFrameShallowSchemaV16,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import {
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import { useRenderedMessages } from "./rendered-messages-test-utils";

/**
 * A host older than agent pages stores tool calls without `page` / `mcpApp`.
 * Its snapshot reaches the GUI through a SHALLOW parse that runs no zod
 * defaults, so the field arrives `undefined` while typed `ToolCallPageStamp |
 * null` - and a `page !== null` classifier promoted every such tool to a page
 * row that threw on `page.path`.
 */

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
  contentBlocksPreview: () => "",
};

/** A tool call exactly as a pre-pages host stores it: no `page`, no `mcpApp`. */
function prePageToolCall(): Record<string, unknown> {
  return {
    type: "tool_call",
    blockId: "tool-1",
    status: "completed",
    timestamp: 20,
    startedAt: 10,
    endedAt: 20,
    parentBlockId: null,
    toolName: "Bash",
    inputSummary: "ls",
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    agentMessageReceipt: null,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    stopped: false,
    imageResults: [],
  };
}

function v16SnapshotEnvelope(): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat: {
        id: "chat-1",
        parentId: null,
        userId: "owner-1",
        hostId: "test-host",
        title: "Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        sessionRef: null,
        messages: [
          {
            role: "assistant",
            messageId: "turn-1",
            sender: {
              type: "agent",
              harnessId: "claude",
              agentId: "agent-1",
              displayName: "Claude",
              reply: { expectsReply: false },
              inReplyTo: null,
            },
            blocks: [prePageToolCall()],
            startedAt: 10,
            timestamp: 20,
            turnId: "turn-1",
            usage: null,
            reasoningEffort: null,
            serviceTier: null,
            imageResolutions: [],
          },
        ],
        events: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      backgroundItems: [],
      managedCommands: [],
      heldUpdates: [],
    },
  };
}

/** Exactly what `ChatStreamClient` does with a `1.6` snapshot frame. */
function receiveV16SnapshotMessages(): ReadonlyArray<Message> {
  const shallowV16 = chatSubscribeSnapshotServerFrameShallowSchemaV16.parse(
    v16SnapshotEnvelope(),
  );
  normalizeV16InterviewFieldsInFrame(shallowV16);
  return chatSubscribeSnapshotServerFrameShallowSchema.parse(shallowV16)
    .snapshot.chat.messages;
}

describe("useRenderedMessages tool calls from a pre-pages host", () => {
  it("projects a tool call without a page stamp as an ordinary tool", () => {
    const input: RenderedMessagesInput = {
      messages: [...receiveV16SnapshotMessages()],
      events: [],
      rowContext: {},
      pendingUserMessages: [],
      withdrawnMessageId: null,
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle",
      setupCardWindows: [],
      epicId: "epic-1",
      ownerId: "chat-1",
      ownerKind: "chat",
      viewTabId: "tab-1",
    };
    const { result } = renderHook(() =>
      useRenderedMessages(input, displayContext),
    );

    // `null`, not `undefined`: every page classifier tests `page !== null`.
    const tool = result.current[0]?.segments.find(
      (segment) => segment.kind === "tool",
    );
    expect(tool).toMatchObject({ kind: "tool", toolName: "Bash", page: null });
  });
});
