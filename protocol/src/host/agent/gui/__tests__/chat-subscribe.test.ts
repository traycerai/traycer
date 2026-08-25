import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  chatActiveTurnSchema,
  chatQueuedItemSchema,
  chatQueuedManagedCommandItemSchema,
  chatSubscribeClientFrameSchema,
  chatSubscribeLiveSchemaVersion,
  chatSubscribeServerFrameSchema,
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
  chatSubscribeV17,
  createImageResolutionUpdatedFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  guiAgentModelCapabilitiesSchema,
  guiAgentModelOptionSchema,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import {
  autonomousResumeTriggerSchema,
  imageGenerationResultSchema,
  toolCallBlockSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  imageResolutionEntrySchema,
  imageResolutionStateSchema,
} from "@traycer/protocol/persistence/epic/messages";
import type {
  Chat,
  ChatEvent,
  ImageResolutionEntry,
  ImageResolutionState,
  UserMessage,
} from "@traycer/protocol/persistence/epic/schemas";
import { describe, expect, it } from "vitest";

const attachmentMentionNodeSchema = getRecordSchema(
  commonRecordRegistry,
  "attachment-mention-node",
  "latest",
);

const userMessage: UserMessage = {
  role: "user",
  messageId: "message-1",
  sender: { type: "user", userId: "user-1" },
  message: {
    kind: "user",
    content: { type: "doc", content: [] },
  },
  timestamp: 1000,
  sessionAnchor: null,
};

const chat: Chat = {
  parentId: null,
  id: "chat-1",
  userId: "user-1",
  hostId: "test-host",
  title: "Chat",
  createdAt: 1000,
  updatedAt: 1000,
  isTitleEditedByUser: false,
  settings: null,
  activeSessionChain: null,
  claudePendingWakes: [],
  messages: [userMessage],
  events: [],
  archivedAt: null,
  pinnedUserProviderHandle: null,
  lastDeliveredRolesDigest: null,
};

const event: ChatEvent = {
  eventId: "event-1",
  type: "send.accepted",
  timestamp: 1001,
  clientActionId: "action-1",
  actor: { type: "user", userId: "user-1" },
  message: "Message accepted",
  turnId: null,
  messageId: "message-1",
  queueItemId: null,
  approvalId: null,
  blockId: null,
  severity: "info",
  metadata: null,
};

describe("chat.subscribe@1.2 open request", () => {
  it("requires an epicId and chatId", () => {
    const parsed = chatSubscribeV12.openRequestSchema.parse({
      epicId: "epic-1",
      chatId: "chat-1",
    });

    expect(parsed).toEqual({ epicId: "epic-1", chatId: "chat-1" });
    expect(() => chatSubscribeV12.openRequestSchema.parse({})).toThrow();
  });
});

describe("chat.subscribe@1.0 (frozen host-v1.0.0 shape)", () => {
  it("parses the actionAck shape host-v1.0.0 actually emits, before background-items existed", () => {
    expect(
      chatSubscribeV10.serverFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        action: "send",
        status: "accepted",
        reason: null,
        code: null,
      }),
    ).toMatchObject({ kind: "actionAck", status: "accepted" });
  });

  it("does not know the v1.1 background-stop client actions - host-v1.0.0 never learned them", () => {
    expect(
      chatSubscribeV10.clientFrameSchema.safeParse({
        kind: "stopBackgroundItem",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        taskId: "task-1",
      }).success,
    ).toBe(false);
  });
});

describe("chat.subscribe@1.1 server frames", () => {
  it("does not know the v1.2 wakeup background-item kind", () => {
    expect(
      chatSubscribeV11.serverFrameSchema.safeParse({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        runStatus: "running",
        activeTurn: null,
        backgroundItems: [
          {
            taskId: "wake-tool-1",
            kind: "wakeup",
            title: "Standup",
            blockId: "wake-tool-1",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("chat.subscribe@1.2 server frames", () => {
  it("parses queued steer-requested items with durable steer metadata", () => {
    const parsed = chatQueuedItemSchema.parse({
      queueItemId: "queue-1",
      messageId: "message-2",
      message: {
        kind: "user",
        content: { type: "doc", content: [] },
      },
      sender: { type: "user", userId: "user-1" },
      settings: {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        agentMode: "epic",
      },
      delivery: "same_turn",
      status: "steer_requested",
      targetTurnId: "turn-1",
      steerRequest: {
        mode: "safe_point",
        targetTurnId: "turn-1",
        requestedAt: 1002,
      },
      fallbackReason: null,
      createdAt: 1001,
      updatedAt: 1002,
    });

    expect(parsed.status).toBe("steer_requested");
    if (parsed.kind !== "prompt") throw new Error("expected prompt item");
    expect(parsed.steerRequest?.mode).toBe("safe_point");
  });

  it("parses a snapshot with generic, file-edit, and interview queues", () => {
    const parsed = chatSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat,
        access: {
          role: "owner",
          ownerUserId: "user-1",
          canAct: true,
        },
        queue: { status: "idle", items: [] },
        activeTurn: null,
        runStatus: "idle",
        pendingApprovals: [
          {
            approvalId: "approval-1",
            toolName: "bash",
            description: "Run a command",
            input: { command: "bun test" },
            requestedAt: 1002,
          },
        ],
        pendingInterviews: [
          {
            blockId: "question-1",
            requestedAt: 1004,
          },
        ],
        pendingFileEditApprovals: [
          {
            approvalId: "file-approval-1",
            toolName: "apply_patch",
            description: "Edit source files",
            paths: ["/repo/src/app.ts"],
            operation: "edit",
            input: { patch: "*** Begin Patch" },
            requestedAt: 1003,
          },
        ],
        worktreeBinding: null,
        missingWorktreePaths: [],
        accumulatedFileChanges: [],
      },
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") {
      expect(parsed.snapshot.chat.events ?? []).toEqual([]);
      expect(parsed.snapshot.pendingApprovals).toHaveLength(1);
      expect(parsed.snapshot.pendingInterviews).toHaveLength(1);
      expect(parsed.snapshot.pendingFileEditApprovals).toHaveLength(1);
      expect(parsed.snapshot.backgroundItems).toBeUndefined();
    }
  });

  it("parses background items on snapshots and turn-state deltas", () => {
    const item = {
      taskId: "task-1",
      kind: "command",
      title: "bun test",
      blockId: "tool-1",
    };
    const wakeupItem = {
      taskId: "wake-tool-1",
      kind: "wakeup",
      title: "Standup",
      blockId: "wake-tool-1",
      parentTaskId: null,
      scheduledFor: 123456,
    };
    const snapshot = chatSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat,
        access: {
          role: "owner",
          ownerUserId: "user-1",
          canAct: true,
        },
        queue: { status: "idle", items: [] },
        activeTurn: null,
        runStatus: "idle",
        pendingApprovals: [],
        pendingInterviews: [],
        pendingFileEditApprovals: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        accumulatedFileChanges: [],
        backgroundItems: [item, wakeupItem],
      },
    });
    const turnState = chatSubscribeServerFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: null,
      backgroundItems: [item, wakeupItem],
    });

    expect(snapshot).toMatchObject({
      kind: "snapshot",
      snapshot: { backgroundItems: [item, wakeupItem] },
    });
    expect(turnState).toMatchObject({
      kind: "turnStateChanged",
      backgroundItems: [item, wakeupItem],
    });
  });

  it("requires wakeup background items to carry a scheduled timestamp", () => {
    const wakeupBase = {
      taskId: "wake-tool-1",
      kind: "wakeup",
      title: "Standup",
      blockId: "wake-tool-1",
      parentTaskId: null,
    };
    const parseResults = [
      wakeupBase,
      { ...wakeupBase, scheduledFor: null },
    ].map((wakeupItem) =>
      chatSubscribeServerFrameSchema.safeParse({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        runStatus: "running",
        activeTurn: null,
        backgroundItems: [wakeupItem],
      }),
    );

    expect(parseResults.map((result) => result.success)).toEqual([
      false,
      false,
    ]);
  });

  it("defaults new background-item metadata when parsing old-host frames", () => {
    const parsed = chatSubscribeServerFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: null,
      backgroundItems: [
        {
          taskId: "task-1",
          kind: "command",
          title: "bun test",
          blockId: "tool-1",
        },
      ],
    });

    expect(parsed).toMatchObject({
      kind: "turnStateChanged",
      backgroundItems: [
        {
          taskId: "task-1",
          parentTaskId: null,
          scheduledFor: null,
        },
      ],
    });
  });

  it("parses the pinned wakeup autonomous-resume trigger shape", () => {
    const parsed = autonomousResumeTriggerSchema.parse({
      kind: "wakeup",
      title: "Standup",
      summary: "Write the standup update.",
      status: "completed",
      blockId: "wake-tool-1",
      outputFile: null,
    });

    expect(parsed).toEqual({
      kind: "wakeup",
      title: "Standup",
      summary: "Write the standup update.",
      status: "completed",
      blockId: "wake-tool-1",
      outputFile: null,
      mcp: null,
      // A fired schedule is not a managed command; there is nothing to open.
      managedCommand: null,
      live: false,
    });
  });

  it("defaults the trigger mcp identity on pre-mcp data and round-trips it when present", () => {
    const legacy = autonomousResumeTriggerSchema.parse({
      kind: "command",
      title: "probe/slow_op",
      summary: "MCP tool finished",
      status: "completed",
      blockId: "tool-9",
      outputFile: null,
    });
    expect(legacy.mcp).toBeNull();

    const mcpTrigger = autonomousResumeTriggerSchema.parse({
      kind: "command",
      title: "probe/slow_op",
      summary: "MCP tool finished",
      status: "completed",
      blockId: "tool-9",
      outputFile: null,
      mcp: { serverName: "probe", toolName: "slow_op" },
    });
    expect(mcpTrigger.kind).toBe("command");
    expect(mcpTrigger.mcp).toEqual({
      serverName: "probe",
      toolName: "slow_op",
    });
  });

  it("parses mcp background items on 1.4, defaulting startedAt for old-host frames", () => {
    const mcpItem = {
      taskId: "task-9",
      kind: "mcp",
      title: "probe/slow_op",
      blockId: "tool-9",
      parentTaskId: null,
      serverName: "probe",
      toolName: "slow_op",
    };
    const frame = (backgroundItem: Record<string, unknown>) => ({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: null,
      backgroundItems: [backgroundItem],
    });

    expect(
      chatSubscribeV14.serverFrameSchema.parse(frame(mcpItem)),
    ).toMatchObject({
      backgroundItems: [{ ...mcpItem, startedAt: null }],
    });
    expect(
      chatSubscribeV14.serverFrameSchema.parse(
        frame({ ...mcpItem, startedAt: 1_700_000_000_000 }),
      ),
    ).toMatchObject({
      backgroundItems: [{ ...mcpItem, startedAt: 1_700_000_000_000 }],
    });
    // The released ≤1.3 lines must never observe the kind at all.
    expect(
      chatSubscribeV13.serverFrameSchema.safeParse(
        frame({ ...mcpItem, startedAt: 1_700_000_000_000 }),
      ).success,
    ).toBe(false);
  });

  it("parses action acknowledgements for accepted and rejected owner actions", () => {
    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        action: "send",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      }),
    ).toMatchObject({ kind: "actionAck", status: "accepted" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-2",
        action: "stop",
        status: "rejected",
        reason: "Only the chat owner can stop a turn.",
        code: "NOT_OWNER",
        backgroundStopTaskIds: [],
      }),
    ).toMatchObject({ kind: "actionAck", status: "rejected" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-3",
        action: "editUserMessage",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      }),
    ).toMatchObject({ kind: "actionAck", action: "editUserMessage" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-4",
        action: "restoreCheckpoint",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      }),
    ).toMatchObject({ kind: "actionAck", action: "restoreCheckpoint" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-5",
        action: "fileEditApprovalDecision",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      }),
    ).toMatchObject({
      kind: "actionAck",
      action: "fileEditApprovalDecision",
    });
  });

  it("defaults backgroundStopTaskIds to [] on a chat.subscribe@1.0-shaped ack (host-v1.0.0 never sends it)", () => {
    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        action: "send",
        status: "accepted",
        reason: null,
        code: null,
        // backgroundStopTaskIds omitted - the exact shape a chat.subscribe@1.0
        // host emits, since it predates background-items support entirely.
      }),
    ).toMatchObject({ kind: "actionAck", backgroundStopTaskIds: [] });
  });

  it("parses durable event and live block delta frames separately", () => {
    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "eventAppended",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event,
      }),
    ).toMatchObject({ kind: "eventAppended" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "text.delta",
          blockId: "block-1",
          timestamp: 1002,
          delta: "hello",
        },
      }),
    ).toMatchObject({ kind: "blockDelta" });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "text.completed",
          blockId: "block-1",
          timestamp: 1003,
        },
      }),
    ).toMatchObject({ kind: "blockDelta" });
  });

  it("parses checkpoint restore server frames", () => {
    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "restoreStarted",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        checkpointId: "turn-1",
        restoringUserId: "user-1",
        restoringHostId: "host-1",
        startedAt: 1003,
      }),
    ).toMatchObject({
      kind: "restoreStarted",
      checkpointId: "turn-1",
    });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "restoreProgress",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        checkpointId: "turn-1",
        processedCount: 1,
        totalCount: 2,
      }),
    ).toMatchObject({ kind: "restoreProgress", processedCount: 1 });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "restoreCompleted",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        checkpointId: "turn-1",
        finishedAt: 1004,
        results: [
          {
            filePath: "/repo/src/app.ts",
            status: "restored",
            operation: "edit",
            reason: null,
          },
        ],
      }),
    ).toMatchObject({
      kind: "restoreCompleted",
      results: [{ status: "restored" }],
    });
  });

  it("parses file-edit approval request and resolution frames", () => {
    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "fileEditApprovalRequested",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        approval: {
          approvalId: "file-approval-1",
          toolName: "Write",
          description: "Create a file",
          paths: ["/repo/src/new-file.ts"],
          operation: "create",
          input: { path: "/repo/src/new-file.ts" },
          requestedAt: 1005,
        },
      }),
    ).toMatchObject({
      kind: "fileEditApprovalRequested",
      approval: { operation: "create" },
    });

    expect(
      chatSubscribeServerFrameSchema.parse({
        kind: "fileEditApprovalResolved",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        approvalId: "file-approval-1",
        decision: { approved: true },
        resolvedAt: 1006,
      }),
    ).toMatchObject({
      kind: "fileEditApprovalResolved",
      approvalId: "file-approval-1",
    });
  });

  it("rejects non-concrete file-edit operations", () => {
    expect(() =>
      chatSubscribeServerFrameSchema.parse({
        kind: "fileEditApprovalRequested",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        approval: {
          approvalId: "file-approval-1",
          toolName: "Write",
          description: "Write a file",
          paths: ["/repo/src/app.ts"],
          operation: "ambiguous",
          input: null,
          requestedAt: 1005,
        },
      }),
    ).toThrow();
  });
});

describe("chat.subscribe@1.3 client frames", () => {
  it("requires clientActionId on owner action frames", () => {
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "stop",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        turnId: "turn-1",
      }),
    ).toMatchObject({ kind: "stop", clientActionId: "action-1" });

    expect(() =>
      chatSubscribeClientFrameSchema.parse({
        kind: "stop",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        turnId: "turn-1",
      }),
    ).toThrow();
  });

  it("parses pause queue owner actions", () => {
    expect(chatSubscribeV13.schemaVersion).toEqual({ major: 1, minor: 3 });
    expect(
      chatSubscribeV12.clientFrameSchema.safeParse({
        kind: "pauseQueue",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "pause-queue-action-1",
      }).success,
    ).toBe(false);
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "pauseQueue",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "pause-queue-action-1",
      }),
    ).toMatchObject({
      kind: "pauseQueue",
      clientActionId: "pause-queue-action-1",
    });
  });

  it("parses background-item stop owner actions", () => {
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "stopBackgroundItem",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "stop-bg-action-1",
        taskId: "task-1",
      }),
    ).toMatchObject({
      kind: "stopBackgroundItem",
      taskId: "task-1",
    });

    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "stopAllBackgroundItems",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "stop-all-bg-action-1",
      }),
    ).toMatchObject({
      kind: "stopAllBackgroundItems",
    });
  });

  it("parses send frames with Tiptap JSONContent attachment mentions", () => {
    const attachmentMention = attachmentMentionNodeSchema.parse({
      type: "mention",
      attrs: {
        contextType: "attachment",
        fileName: "diagram.png",
        b64content: "aW1hZ2U=",
        url: "file://diagram.png",
        altText: "Architecture diagram",
      },
    });

    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "send",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
      messageId: "message-2",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [attachmentMention],
          },
        ],
      },
      sender: { type: "user", userId: "user-1" },
      settings: {
        harnessId: "codex",
        model: "gpt-5.4",
        permissionMode: "supervised",
        reasoningEffort: "high",
        agentMode: "epic",
      },
      accountContext: { type: "PERSONAL" },
    });

    expect(parsed.kind).toBe("send");
  });

  it("parses message suffix delete and user-message edit frames", () => {
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "deleteMessageSuffix",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "delete-action-1",
        fromMessageId: "message-2",
      }),
    ).toMatchObject({
      kind: "deleteMessageSuffix",
      fromMessageId: "message-2",
    });

    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "editUserMessage",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "edit-action-1",
      targetMessageId: "message-2",
      messageId: "message-3",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Edited prompt" }],
          },
        ],
      },
      sender: { type: "user", userId: "user-1" },
      settings: {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        agentMode: "epic",
      },
      accountContext: { type: "PERSONAL" },
      worktreeIntent: {
        entries: [
          {
            kind: "worktree",
            workspacePath: "/repo",
            repoIdentifier: null,
            isPrimary: true,
            branch: {
              type: "new",
              name: "edited-first-message",
              source: "main",
              carryUncommittedChanges: false,
            },
            scripts: null,
          },
        ],
      },
      revertFileChanges: false,
    });

    expect(parsed).toMatchObject({
      kind: "editUserMessage",
      targetMessageId: "message-2",
      messageId: "message-3",
      worktreeIntent: {
        entries: [
          {
            branch: { name: "edited-first-message" },
          },
        ],
      },
      revertFileChanges: false,
    });
  });

  it("parses revert file-change owner actions", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "revertFileChanges",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "revert-action-1",
      fromMessageId: null,
      filePaths: ["/repo/src/app.ts"],
    });

    expect(parsed).toMatchObject({
      kind: "revertFileChanges",
      fromMessageId: null,
      filePaths: ["/repo/src/app.ts"],
    });
  });

  it("parses queued steer-now owner actions", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "queueSteerNow",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "steer-action-1",
      queueItemId: "queue-1",
      newSettings: null,
    });

    expect(parsed).toMatchObject({
      kind: "queueSteerNow",
      queueItemId: "queue-1",
      newSettings: null,
    });
  });

  it("parses queued settings restamp owner actions", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "queueSettingsRestamp",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "restamp-action-1",
      settings: {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        agentMode: "epic",
      },
      accountContext: { type: "PERSONAL" },
      excludeQueueItemId: "queue-editing",
    });

    expect(parsed).toMatchObject({
      kind: "queueSettingsRestamp",
      excludeQueueItemId: "queue-editing",
    });
  });

  it("parses active permission mode update owner actions", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "activePermissionModeUpdate",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "permission-action-1",
      permissionMode: "full_access",
    });

    expect(parsed).toMatchObject({
      kind: "activePermissionModeUpdate",
      permissionMode: "full_access",
    });
  });

  it("parses heartbeat pings without clientActionId", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      kind: "ping",
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("ping");
  });

  it("parses restore checkpoint owner actions", () => {
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "restoreCheckpoint",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "restore-action-1",
        checkpointId: "turn-1",
      }),
    ).toMatchObject({
      kind: "restoreCheckpoint",
      checkpointId: "turn-1",
    });
  });

  it("parses file-edit approval decision owner actions", () => {
    expect(
      chatSubscribeClientFrameSchema.parse({
        kind: "fileEditApprovalDecision",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "file-edit-action-1",
        approvalId: "file-approval-1",
        decision: { approved: false, reason: "Needs review" },
      }),
    ).toMatchObject({
      kind: "fileEditApprovalDecision",
      approvalId: "file-approval-1",
    });
  });
});

describe("chat.subscribe@1.2 server frames", () => {
  it("stays frozen without workflow background items or workflow events", () => {
    const workflowItem = {
      taskId: "wf-task-1",
      kind: "workflow",
      title: "review",
      blockId: "wf-task-1",
      parentTaskId: null,
      phase: "Find",
      activeLabel: "find:host-core",
      agentsStarted: 16,
      agentsFinished: 3,
    };

    expect(
      chatSubscribeV12.serverFrameSchema.safeParse({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        runStatus: "running",
        activeTurn: null,
        backgroundItems: [workflowItem],
      }).success,
    ).toBe(false);

    expect(
      chatSubscribeV12.serverFrameSchema.safeParse({
        kind: "snapshot",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        snapshot: {
          chat,
          access: { role: "owner", ownerUserId: "user-1", canAct: true },
          queue: { status: "idle", items: [] },
          activeTurn: null,
          runStatus: "idle",
          pendingApprovals: [],
          pendingInterviews: [],
          pendingFileEditApprovals: [],
          worktreeBinding: null,
          missingWorktreePaths: [],
          accumulatedFileChanges: [],
          backgroundItems: [workflowItem],
        },
      }).success,
    ).toBe(false);

    expect(
      chatSubscribeV12.serverFrameSchema.safeParse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "workflow.started",
          blockId: "wf-1",
          timestamp: 1,
          name: "review",
          intent: "Review the diff",
        },
      }).success,
    ).toBe(false);
  });

  it("does not know the provider_notice.upsert blockDelta event", () => {
    expect(
      chatSubscribeV12.serverFrameSchema.safeParse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "provider_notice.upsert",
          blockId: "provider-notice:codex:turn-1:model-rerouted",
          timestamp: 1,
          parentBlockId: null,
          harnessId: "codex",
          noticeKind: "model_rerouted",
          tone: "warning",
          status: "completed",
          title: "Model changed",
          message: null,
          details: [],
          fallbackText: "Codex switched models.",
          metadata: null,
        },
      }).success,
    ).toBe(false);
  });
});

describe("chat.subscribe@1.3 server frames", () => {
  it("declares schemaVersion 1.3", () => {
    expect(chatSubscribeV13.schemaVersion).toEqual({ major: 1, minor: 3 });
  });

  it("parses a workflow background item on snapshot and turn-state frames", () => {
    const workflowItem = {
      taskId: "wf-task-1",
      kind: "workflow",
      title: "review",
      blockId: "wf-task-1",
      parentTaskId: null,
      phase: "Find",
      activeLabel: "find:host-core",
      agentsStarted: 16,
      agentsFinished: 3,
    };

    const snapshot = chatSubscribeV13.serverFrameSchema.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat,
        access: { role: "owner", ownerUserId: "user-1", canAct: true },
        queue: { status: "idle", items: [] },
        activeTurn: null,
        runStatus: "idle",
        pendingApprovals: [],
        pendingInterviews: [],
        pendingFileEditApprovals: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        accumulatedFileChanges: [],
        backgroundItems: [workflowItem],
      },
    });
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      snapshot: { backgroundItems: [workflowItem] },
    });

    const turnState = chatSubscribeV13.serverFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: null,
      backgroundItems: [workflowItem],
    });
    expect(turnState).toMatchObject({
      kind: "turnStateChanged",
      backgroundItems: [workflowItem],
    });
  });

  it("defaults new workflow background-item metadata when parsing an old-host frame", () => {
    const parsed = chatSubscribeV13.serverFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: null,
      backgroundItems: [
        {
          taskId: "wf-task-1",
          kind: "workflow",
          title: "review",
          blockId: "wf-task-1",
        },
      ],
    });

    expect(parsed).toMatchObject({
      kind: "turnStateChanged",
      backgroundItems: [
        {
          taskId: "wf-task-1",
          parentTaskId: null,
          phase: null,
          activeLabel: null,
          agentsStarted: null,
          agentsFinished: null,
        },
      ],
    });
  });

  it("round-trips workflow.started / workflow.progress / workflow.completed blockDelta events", () => {
    expect(
      chatSubscribeV13.serverFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "workflow.started",
          blockId: "wf-1",
          timestamp: 1,
          name: "review",
          intent: "Review the diff",
          spawnToolCallId: "toolu_workflow_1",
        },
      }),
    ).toMatchObject({ kind: "blockDelta" });

    expect(
      chatSubscribeV13.serverFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "workflow.progress",
          blockId: "wf-1",
          timestamp: 2,
          activity: { kind: "label", text: "find:host-core" },
          agentsStarted: 16,
          agentsFinished: 3,
          totalTokens: 120000,
        },
      }),
    ).toMatchObject({ kind: "blockDelta" });

    expect(
      chatSubscribeV13.serverFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "workflow.completed",
          blockId: "wf-1",
          timestamp: 3,
          outcome: "completed",
          result: "3 findings",
        },
      }),
    ).toMatchObject({ kind: "blockDelta" });
  });

  it("round-trips a provider_notice.upsert blockDelta event", () => {
    expect(
      chatSubscribeV13.serverFrameSchema.parse({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: {
          type: "provider_notice.upsert",
          blockId: "provider-notice:codex:turn-1:safety-buffering",
          timestamp: 1,
          parentBlockId: null,
          harnessId: "codex",
          noticeKind: "safety_buffering",
          tone: "info",
          status: "streaming",
          title: "Safety check in progress",
          message: "Buffering with gpt-5.",
          details: [{ label: "Model", value: "gpt-5" }],
          fallbackText: "Codex is running a safety check.",
          metadata: {
            type: "safety_buffering",
            model: "gpt-5",
            fasterModel: null,
            useCases: ["cyber"],
            reasons: ["trustedAccessForCyber"],
            terminalReason: null,
          },
        },
      }),
    ).toMatchObject({
      kind: "blockDelta",
      event: { type: "provider_notice.upsert" },
    });
  });
});

describe("chat.subscribe@1.4 (inReplyTo on senders)", () => {
  // An agent-authored user message whose sender carries `inReplyTo` (it
  // resumed an A2A thread the receiving chat opened).
  const agentUserMessage: UserMessage = {
    role: "user",
    messageId: "message-a2a",
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "agent-sender",
      displayName: "Sibling agent",
      reply: { expectsReply: false },
      inReplyTo: "response-7",
    },
    message: {
      kind: "agent",
      content: { type: "doc", content: [] },
      fromAgentId: "agent-sender",
      senderTitle: "Sibling agent",
      senderHarnessId: "codex",
      reply: { expectsReply: false },
    },
    timestamp: 2000,
    sessionAnchor: null,
  };

  const agentEvent: ChatEvent = {
    ...event,
    eventId: "event-a2a",
    actor: {
      type: "agent",
      harnessId: "codex",
      agentId: "agent-sender",
      displayName: "Sibling agent",
      reply: { expectsReply: false },
      inReplyTo: "response-7",
    },
  };

  const chatWithAgentSender: Chat = {
    ...chat,
    messages: [userMessage, agentUserMessage],
    events: [agentEvent],
  };

  const queueItem = {
    queueItemId: "q-a2a",
    messageId: "message-a2a",
    message: agentUserMessage.message,
    sender: agentUserMessage.sender,
    settings: {
      harnessId: "codex" as const,
      model: "gpt-5-codex",
      permissionMode: "supervised" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "epic" as const,
    },
    createdAt: 2000,
    updatedAt: 2000,
  };

  const snapshotFrame = {
    kind: "snapshot" as const,
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat: chatWithAgentSender,
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: [queueItem] },
      activeTurn: null,
      runStatus: "idle",
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      accumulatedFileChanges: [],
    },
  };

  it("declares schemaVersion 1.4", () => {
    expect(chatSubscribeV14.schemaVersion).toEqual({ major: 1, minor: 4 });
  });

  it("carries inReplyTo through message, queue-item, and event senders", () => {
    const parsed = chatSubscribeV14.serverFrameSchema.parse(snapshotFrame);
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    const [, message] = parsed.snapshot.chat.messages;
    expect(message.sender).toMatchObject({
      type: "agent",
      inReplyTo: "response-7",
    });
    expect(parsed.snapshot.queue.items[0]?.sender).toMatchObject({
      type: "agent",
      inReplyTo: "response-7",
    });
    expect(parsed.snapshot.chat.events[0]?.actor).toMatchObject({
      type: "agent",
      inReplyTo: "response-7",
    });
  });

  it("carries inReplyTo on the messageAccepted frame", () => {
    const parsed = chatSubscribeV14.serverFrameSchema.parse({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      message: agentUserMessage,
    });
    if (parsed.kind !== "messageAccepted")
      throw new Error("expected messageAccepted");
    expect(parsed.message.sender).toMatchObject({ inReplyTo: "response-7" });
  });

  it("strips inReplyTo from every sender path for a 1.3 (pre-inReplyTo) peer", () => {
    // The whole point of the frozen 1.0–1.3 lines: an older peer strict-parses
    // a frame the live host built and the unmodeled key drops out, rather than
    // rejecting the frame.
    const parsed = chatSubscribeV13.serverFrameSchema.parse(snapshotFrame);
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    const [, message] = parsed.snapshot.chat.messages;
    expect(message.sender).not.toHaveProperty("inReplyTo");
    expect(parsed.snapshot.queue.items[0]?.sender).not.toHaveProperty(
      "inReplyTo",
    );
    expect(parsed.snapshot.chat.events[0]?.actor).not.toHaveProperty(
      "inReplyTo",
    );
  });

  it("strips inReplyTo on the messageAccepted frame for a 1.3 peer", () => {
    const parsed = chatSubscribeV13.serverFrameSchema.parse({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      message: agentUserMessage,
    });
    if (parsed.kind !== "messageAccepted")
      throw new Error("expected messageAccepted");
    expect(parsed.message.sender).not.toHaveProperty("inReplyTo");
  });
});

describe("chat.subscribe@1.6 (managed-command queue items)", () => {
  const managedCommandItem = {
    kind: "managed-command" as const,
    queueItemId: "queue-managed-1",
    commandId: "command-1",
    description: "bun test --watch",
    status: "pending" as const,
    createdAt: 3000,
    updatedAt: 3000,
  };

  // The exact shape a released 1.4 host persisted into `queue.added` metadata
  // and put on the wire: no `kind` key at all.
  const legacyKindlessItem = {
    queueItemId: "queue-legacy-1",
    messageId: "message-2",
    message: { kind: "user", content: { type: "doc", content: [] } },
    sender: { type: "user", userId: "user-1" },
    settings: {
      harnessId: "codex",
      model: "gpt-5-codex",
      permissionMode: "supervised",
      reasoningEffort: null,
      agentMode: "epic",
    },
    createdAt: 2001,
    updatedAt: 2002,
  };

  function snapshotFrameWithQueueItems(
    items: ReadonlyArray<unknown>,
  ): Record<string, unknown> {
    return {
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat,
        access: { role: "owner", ownerUserId: "user-1", canAct: true },
        queue: { status: "idle", items },
        activeTurn: null,
        runStatus: "idle",
        pendingApprovals: [],
        pendingInterviews: [],
        pendingFileEditApprovals: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        accumulatedFileChanges: [],
      },
    };
  }

  it("declares schemaVersion 1.6", () => {
    expect(chatSubscribeV16.schemaVersion).toEqual({ major: 1, minor: 6 });
  });

  // The load-bearing compat guarantee: every payload a ≤1.4 host ever wrote
  // carries no `kind`, and the defaulted prompt discriminant must adopt them
  // with no migration. This is why the union is a plain `z.union` (a
  // `z.discriminatedUnion` rejects a missing discriminant even when the
  // literal is defaulted) with the managed-command arm listed first.
  it("parses a legacy kind-less queued item as a prompt item", () => {
    const parsed = chatQueuedItemSchema.parse(legacyKindlessItem);

    expect(parsed.kind).toBe("prompt");
    if (parsed.kind !== "prompt") throw new Error("expected prompt item");
    expect(parsed.messageId).toBe("message-2");
    expect(parsed.sender).toMatchObject({ type: "user", userId: "user-1" });
  });

  it("parses a managed-command queued item as its own variant", () => {
    const parsed = chatQueuedItemSchema.parse(managedCommandItem);

    expect(parsed.kind).toBe("managed-command");
    if (parsed.kind !== "managed-command") {
      throw new Error("expected managed-command item");
    }
    expect(parsed.commandId).toBe("command-1");
    expect(parsed.description).toBe("bun test --watch");
    expect(parsed.status).toBe("pending");
    // The variant is content-free: no fabricated message/sender/settings ride
    // along on the durable record.
    expect(parsed).not.toHaveProperty("message");
    expect(parsed).not.toHaveProperty("sender");
    expect(parsed).not.toHaveProperty("messageId");
    expect(parsed).not.toHaveProperty("settings");
  });

  it("defaults a managed-command item's status to pending", () => {
    const parsed = chatQueuedManagedCommandItemSchema.parse({
      kind: "managed-command",
      queueItemId: "queue-managed-2",
      commandId: "command-2",
      description: "tail -f server.log",
      createdAt: 3000,
      updatedAt: 3000,
    });

    expect(parsed.status).toBe("pending");
  });

  it("rejects a managed-command item that omits its durable dispatch key", () => {
    expect(
      chatQueuedItemSchema.safeParse({
        kind: "managed-command",
        queueItemId: "queue-managed-3",
        description: "no commandId",
        createdAt: 3000,
        updatedAt: 3000,
      }).success,
    ).toBe(false);
  });

  it("carries a managed-command queue item through a 1.6 snapshot frame", () => {
    const parsed = chatSubscribeV17.serverFrameSchema.parse(
      snapshotFrameWithQueueItems([managedCommandItem]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.queue.items[0]).toMatchObject({
      kind: "managed-command",
      commandId: "command-1",
    });
  });

  it("carries a managed-command queue item through a 1.6 queueChanged frame", () => {
    const parsed = chatSubscribeV17.serverFrameSchema.parse({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      queue: { status: "idle", items: [managedCommandItem] },
    });
    if (parsed.kind !== "queueChanged")
      throw new Error("expected queueChanged");
    expect(parsed.queue.items[0]).toMatchObject({
      kind: "managed-command",
      commandId: "command-1",
    });
  });

  // The frozen 1.4 line must not be able to absorb the new variant - this is
  // what forces the host's per-minor frame projection to exist rather than
  // relying on zod stripping unknown keys.
  it("cannot parse a managed-command item on the frozen 1.4 line", () => {
    expect(
      chatSubscribeV14.serverFrameSchema.safeParse(
        snapshotFrameWithQueueItems([managedCommandItem]),
      ).success,
    ).toBe(false);
    expect(
      chatSubscribeV14.serverFrameSchema.safeParse({
        kind: "queueChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        queue: { status: "idle", items: [managedCommandItem] },
      }).success,
    ).toBe(false);
  });

  it("still parses ordinary prompt items on the frozen 1.4 line", () => {
    const parsed = chatSubscribeV14.serverFrameSchema.parse(
      snapshotFrameWithQueueItems([legacyKindlessItem]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.queue.items[0]).toMatchObject({
      queueItemId: "queue-legacy-1",
    });
    // The 1.4 line predates the discriminant and must never grow one.
    expect(parsed.snapshot.queue.items[0]).not.toHaveProperty("kind");
  });

  // Same guarantee one line up: 1.5 shipped before the union existed, so it
  // must reject the variant too, not just 1.4.
  it("cannot parse a managed-command item on the frozen 1.5 line", () => {
    expect(
      chatSubscribeV15.serverFrameSchema.safeParse(
        snapshotFrameWithQueueItems([managedCommandItem]),
      ).success,
    ).toBe(false);
  });
});

describe("chat.subscribe@1.6 (the chat's managed commands)", () => {
  const shell = {
    id: "command-1",
    monitoring: true,
    description: "deploy watcher",
    status: {
      state: "running" as const,
      pid: 4410,
      startedAtMs: 1_700_000_000_000,
    },
    chatId: "chat-1",
    createdAtMs: 1_699_999_000_000,
    updatedAtMs: 1_700_000_000_000,
  };

  function snapshotFrameWithManagedCommands(
    managedCommands: ReadonlyArray<unknown>,
  ): Record<string, unknown> {
    return {
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat,
        access: { role: "owner", ownerUserId: "user-1", canAct: true },
        queue: { status: "idle", items: [] },
        activeTurn: null,
        runStatus: "idle",
        pendingApprovals: [],
        pendingInterviews: [],
        pendingFileEditApprovals: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        accumulatedFileChanges: [],
        managedCommands,
      },
    };
  }

  const managedCommandsChangedFrame = {
    kind: "managedCommandsChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    managedCommands: [shell],
  };

  it("carries the chat's commands on a live snapshot", () => {
    const parsed = chatSubscribeV17.serverFrameSchema.parse(
      snapshotFrameWithManagedCommands([shell]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    // `toMatchObject`, not `toEqual`: 1.6 binds the LIVE managed-command shape
    // since the unreleased 1.7 collapsed into it, so the details widening
    // (`command`/`cwd`/`cadence`) arrives with its defaults on top of the
    // fields this fixture states. It was `toEqual` while 1.6 was pinned to
    // `managedCommandSchemaPreImage`, which modelled none of the three.
    expect(parsed.snapshot.managedCommands).toMatchObject([shell]);
    expect(parsed.snapshot.managedCommands[0]).toHaveProperty("command");
    expect(parsed.snapshot.managedCommands[0]).toHaveProperty("cwd");
    expect(parsed.snapshot.managedCommands[0]).toHaveProperty("cadence");
  });

  // Optional on the wire, always present after parsing: no consumer ever
  // null-checks the set, on either channel.
  it("defaults an omitted set to empty rather than undefined", () => {
    const frame = snapshotFrameWithManagedCommands([]);
    const snapshot = frame["snapshot"] as Record<string, unknown>;
    delete snapshot["managedCommands"];

    const parsed = chatSubscribeV17.serverFrameSchema.parse(frame);
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.managedCommands).toEqual([]);

    const changed = chatSubscribeV17.serverFrameSchema.parse({
      kind: "managedCommandsChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
    });
    if (changed.kind !== "managedCommandsChanged") {
      throw new Error("expected managedCommandsChanged");
    }
    expect(changed.managedCommands).toEqual([]);
  });

  it("drops the field on the frozen 1.5 line", () => {
    const parsed = chatSubscribeV15.serverFrameSchema.parse(
      snapshotFrameWithManagedCommands([shell]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot).not.toHaveProperty("managedCommands");
  });

  it("carries the whole set on every managedCommandsChanged frame", () => {
    const parsed = chatSubscribeV17.serverFrameSchema.parse(
      managedCommandsChangedFrame,
    );
    if (parsed.kind !== "managedCommandsChanged") {
      throw new Error("expected managedCommandsChanged");
    }
    // Same widening as the snapshot above - both frames read the live shape.
    expect(parsed.managedCommands).toMatchObject([shell]);
  });

  // The frame and the field arrive together or not at all - a 1.5 peer has no
  // variant for it, so the host must never send one (see the host's
  // `projectManagedCommandsForPreV16`).
  it("is not a frame a 1.5 peer can parse", () => {
    expect(
      chatSubscribeV15.serverFrameSchema.safeParse(managedCommandsChangedFrame)
        .success,
    ).toBe(false);
  });
});

describe("chat.subscribe@1.5 sameTurnSteeringSupported rolling upgrade", () => {
  // Pre-1.5 active turn shape: no sameTurnSteeringSupported field at all.
  // A 1.5 client parsing frames from a 1.4 host (or persisted pre-field state)
  // must still accept the carrier and default the capability to false.
  const preV15ActiveTurn = {
    turnId: "turn-1",
    status: "running" as const,
    harnessId: "claude" as const,
    model: "claude-sonnet-4-5",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "epic" as const,
    profileId: null,
    userMessageId: "message-1",
    startedAt: 1000,
    updatedAt: 1000,
  };

  const activeTurnWithCapability = {
    ...preV15ActiveTurn,
    sameTurnSteeringSupported: true,
  };

  it("defaults missing sameTurnSteeringSupported to false on the live schema", () => {
    const parsed = chatActiveTurnSchema.parse(preV15ActiveTurn);
    expect(parsed.sameTurnSteeringSupported).toBe(false);
  });

  it("defaults missing sameTurnSteeringSupported through a live snapshot frame", () => {
    const parsed = chatSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat,
        access: { role: "owner", ownerUserId: "user-1", canAct: true },
        queue: { status: "idle", items: [] },
        activeTurn: preV15ActiveTurn,
        runStatus: "running",
        pendingApprovals: [],
        pendingInterviews: [],
        pendingFileEditApprovals: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        accumulatedFileChanges: [],
      },
    });
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.activeTurn?.sameTurnSteeringSupported).toBe(false);
  });

  it("defaults missing sameTurnSteeringSupported through a live turnStateChanged frame", () => {
    const parsed = chatSubscribeServerFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: preV15ActiveTurn,
    });
    if (parsed.kind !== "turnStateChanged") {
      throw new Error("expected turnStateChanged");
    }
    expect(parsed.activeTurn?.sameTurnSteeringSupported).toBe(false);
  });

  it("strips sameTurnSteeringSupported for a 1.4 peer and retains it on 1.5", () => {
    const frame = {
      kind: "turnStateChanged" as const,
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running" as const,
      activeTurn: activeTurnWithCapability,
    };

    const v14 = chatSubscribeV14.serverFrameSchema.parse(frame);
    if (v14.kind !== "turnStateChanged") {
      throw new Error("expected turnStateChanged");
    }
    expect(v14.activeTurn).not.toHaveProperty("sameTurnSteeringSupported");

    const v15 = chatSubscribeV15.serverFrameSchema.parse(frame);
    if (v15.kind !== "turnStateChanged") {
      throw new Error("expected turnStateChanged");
    }
    expect(v15.activeTurn?.sameTurnSteeringSupported).toBe(true);
  });
});

// ─── chat.subscribe@1.6 image generation + rendering ───────────────────────
//
// Live image shapes land on the head line only. Every earlier minor is pinned
// to a pre-image freeze so additive image fields cannot leak onto a released
// wire line (the bug this ticket closed). The head was 1.7 until the release
// collapsed it into 1.6 - neither minor had ever been negotiated, so the freeze
// separating them protected no peer.
describe("chat.subscribe@1.6 (image generation)", () => {
  const imageHashA = "a".repeat(64);
  const imageHashB = "b".repeat(64);
  const resolutionHash = "c".repeat(64);
  const imageResultA = {
    attachmentHash: imageHashA,
    mediaType: "image/png" as const,
    byteLength: 1024,
    width: 64,
    height: 48,
    alt: "generated chart",
    revisedPrompt: "a clean chart",
    filePath: "/tmp/chart.png",
  };

  const imageResultB = {
    attachmentHash: imageHashB,
    mediaType: "image/jpeg" as const,
    byteLength: 2048,
    width: null,
    height: null,
    alt: null,
    revisedPrompt: null,
    filePath: null,
  };

  const toolCallBlockWithImages = {
    type: "tool_call" as const,
    blockId: "tool-image-1",
    status: "completed" as const,
    timestamp: 5000,
    parentBlockId: null,
    toolName: "image_gen",
    inputSummary: "draw a chart",
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    progress: null,
    backgroundOutput: null,
    startedAt: 4900,
    endedAt: 5000,
    backgroundTask: false,
    stopped: false,
    imageResults: [imageResultA, imageResultB],
  };

  const resolutionStates = imageResolutionStateSchema.options;

  function buildResolutionEntry(
    state: ImageResolutionState,
    index: number,
  ): ImageResolutionEntry {
    const source = `https://example.com/img-${index}.png`;
    const canonicalSource = source;
    if (state === "resolved") {
      return {
        source,
        canonicalSource,
        state,
        attachmentHash: resolutionHash,
        mediaType: "image/png",
        width: 100,
        height: 80,
      };
    }
    return {
      source,
      canonicalSource,
      state,
      attachmentHash: null,
      mediaType: null,
      width: null,
      height: null,
    };
  }

  const imageResolutions = resolutionStates.map((state, index) =>
    buildResolutionEntry(state, index),
  );

  const assistantWithImages = {
    role: "assistant" as const,
    messageId: "assistant-image-1",
    sender: {
      type: "agent" as const,
      harnessId: "codex" as const,
      agentId: "agent-1",
      displayName: "Coder",
      reply: { expectsReply: false as const },
      inReplyTo: null,
    },
    blocks: [toolCallBlockWithImages],
    startedAt: 4900,
    timestamp: 5000,
    turnId: "turn-image-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions,
  };

  const chatWithImages: Chat = {
    ...chat,
    messages: [userMessage, assistantWithImages],
  };

  function snapshotFrameWithChat(
    chatPayload: Chat,
  ): Record<string, unknown> {
    return {
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat: chatPayload,
        access: { role: "owner", ownerUserId: "user-1", canAct: true },
        queue: { status: "idle", items: [] },
        activeTurn: null,
        runStatus: "idle",
        pendingApprovals: [],
        pendingInterviews: [],
        pendingFileEditApprovals: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        accumulatedFileChanges: [],
      },
    };
  }

  function blockDeltaFrame(event: Record<string, unknown>): Record<string, unknown> {
    return {
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      event,
    };
  }

  const frozenSubscribeContracts = [
    { label: "1.0", contract: chatSubscribeV10 },
    { label: "1.1", contract: chatSubscribeV11 },
    { label: "1.2", contract: chatSubscribeV12 },
    { label: "1.3", contract: chatSubscribeV13 },
    { label: "1.4", contract: chatSubscribeV14 },
    { label: "1.5", contract: chatSubscribeV15 },
  ] as const;

  it("declares schemaVersion 1.6", () => {
    expect(chatSubscribeV16.schemaVersion).toEqual({ major: 1, minor: 6 });
  });

  it("round-trips a tool_call content block with multiple imageResults", () => {
    const parsed = toolCallBlockSchema.parse(toolCallBlockWithImages);
    expect(parsed.imageResults).toHaveLength(2);
    expect(parsed.imageResults[0]).toMatchObject(imageResultA);
    expect(parsed.imageResults[1]).toMatchObject({
      attachmentHash: imageHashB,
      mediaType: "image/jpeg",
      byteLength: 2048,
      width: null,
      height: null,
      alt: null,
      revisedPrompt: null,
      filePath: null,
    });
  });

  it("defaults omitted imageResults to an empty array on the live tool_call block", () => {
    const { imageResults: _omit, ...withoutImages } = toolCallBlockWithImages;
    const parsed = toolCallBlockSchema.parse(withoutImages);
    expect(parsed.imageResults).toEqual([]);
  });

  it("defaults omitted imageGenerationResult optionals to null", () => {
    expect(
      imageGenerationResultSchema.parse({
        attachmentHash: imageHashA,
        mediaType: "image/png",
        byteLength: 1,
      }),
    ).toEqual({
      attachmentHash: imageHashA,
      mediaType: "image/png",
      byteLength: 1,
      width: null,
      height: null,
      alt: null,
      revisedPrompt: null,
      filePath: null,
    });
  });

  it("round-trips tool_call.completed with imageResults through the head-line frame", () => {
    const withImages = chatSubscribeV17.serverFrameSchema.parse(
      blockDeltaFrame({
        type: "tool_call.completed",
        blockId: "tool-image-1",
        timestamp: 5000,
        toolName: "image_gen",
        imageResults: [imageResultA, imageResultB],
      }),
    );
    expect(withImages).toMatchObject({
      kind: "blockDelta",
      event: {
        type: "tool_call.completed",
        imageResults: [
          expect.objectContaining({ attachmentHash: imageHashA }),
          expect.objectContaining({ attachmentHash: imageHashB }),
        ],
      },
    });

    const omitted = chatSubscribeV17.serverFrameSchema.parse(
      blockDeltaFrame({
        type: "tool_call.completed",
        blockId: "tool-image-1",
        timestamp: 5000,
        toolName: "image_gen",
      }),
    );
    if (omitted.kind !== "blockDelta") throw new Error("expected blockDelta");
    if (omitted.event.type !== "tool_call.completed") {
      throw new Error("expected tool_call.completed");
    }
    expect(omitted.event.imageResults).toEqual([]);
  });

  it("round-trips a resolution entry for every imageResolution state", () => {
    for (const state of resolutionStates) {
      if (state === "resolved") {
        const parsed = imageResolutionEntrySchema.parse({
          source: "https://example.com/a.png",
          canonicalSource: "https://example.com/a.png",
          state,
          attachmentHash: resolutionHash,
          mediaType: "image/png",
        });
        expect(parsed.state).toBe("resolved");
        expect(parsed.attachmentHash).toBe(resolutionHash);
        expect(parsed.mediaType).toBe("image/png");
        expect(parsed.width).toBeNull();
        expect(parsed.height).toBeNull();
        continue;
      }
      const parsed = imageResolutionEntrySchema.parse({
        source: "https://example.com/a.png",
        canonicalSource: "https://example.com/a.png",
        state,
      });
      expect(parsed.state).toBe(state);
      expect(parsed.attachmentHash).toBeNull();
      expect(parsed.mediaType).toBeNull();
      expect(parsed.width).toBeNull();
      expect(parsed.height).toBeNull();
    }
  });

  it("rejects a resolved resolution entry without an attachment", () => {
    expect(
      imageResolutionEntrySchema.safeParse({
        source: "https://example.com/a.png",
        canonicalSource: "https://example.com/a.png",
        state: "resolved",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-resolved resolution entry that carries attachment data", () => {
    for (const state of resolutionStates) {
      if (state === "resolved") continue;
      expect(
        imageResolutionEntrySchema.safeParse({
          source: "https://example.com/a.png",
          canonicalSource: "https://example.com/a.png",
          state,
          attachmentHash: resolutionHash,
          mediaType: "image/png",
        }).success,
        state,
      ).toBe(false);
    }
  });

  it("round-trips image_resolution.updated through the head-line serverFrame", () => {
    for (const entry of imageResolutions) {
      const parsed = chatSubscribeV17.serverFrameSchema.parse(
        createImageResolutionUpdatedFrame({
          epicId: "epic-1",
          chatId: "chat-1",
          event: {
            type: "image_resolution.updated",
            blockId: "assistant-image-1",
            timestamp: 5100,
            turnId: "turn-image-1",
            messageId: "assistant-image-1",
            entry,
          },
        }),
      );
      expect(parsed).toMatchObject({
        kind: "blockDelta",
        event: {
          type: "image_resolution.updated",
          messageId: "assistant-image-1",
          entry: { state: entry.state, canonicalSource: entry.canonicalSource },
        },
      });
    }
  });

  it("carries imageResults and imageResolutions through a live 1.6 snapshot", () => {
    const parsed = chatSubscribeV17.serverFrameSchema.parse(
      snapshotFrameWithChat(chatWithImages),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    const assistant = parsed.snapshot.chat.messages.find(
      (message) => message.role === "assistant",
    );
    if (!assistant || assistant.role !== "assistant") {
      throw new Error("expected assistant message");
    }
    expect(assistant.imageResolutions).toHaveLength(resolutionStates.length);
    const toolCall = assistant.blocks.find((block) => block.type === "tool_call");
    if (!toolCall || toolCall.type !== "tool_call") {
      throw new Error("expected tool_call block");
    }
    expect(toolCall.imageResults).toHaveLength(2);
  });

  it("stays frozen without image fields on every released minor 1.0-1.5", () => {
    const snapshotFrame = snapshotFrameWithChat(chatWithImages);
    const completedWithImages = blockDeltaFrame({
      type: "tool_call.completed",
      blockId: "tool-image-1",
      timestamp: 5000,
      toolName: "image_gen",
      imageResults: [imageResultA],
    });
    const resolutionUpdated = blockDeltaFrame({
      type: "image_resolution.updated",
      blockId: "assistant-image-1",
      timestamp: 5100,
      turnId: "turn-image-1",
      messageId: "assistant-image-1",
      entry: imageResolutions[0],
    });

    for (const { label, contract } of frozenSubscribeContracts) {
      const snapshot = contract.serverFrameSchema.parse(snapshotFrame);
      if (snapshot.kind !== "snapshot") {
        throw new Error(`expected snapshot on ${label}`);
      }
      const assistant = snapshot.snapshot.chat.messages.find(
        (message) => message.role === "assistant",
      );
      if (!assistant || assistant.role !== "assistant") {
        throw new Error(`expected assistant message on ${label}`);
      }
      // Frozen assistant message has no imageResolutions key at all.
      expect(assistant, label).not.toHaveProperty("imageResolutions");
      const toolCall = assistant.blocks.find(
        (block) => block.type === "tool_call",
      );
      if (!toolCall || toolCall.type !== "tool_call") {
        throw new Error(`expected tool_call block on ${label}`);
      }
      expect(toolCall, label).not.toHaveProperty("imageResults");

      const completed = contract.serverFrameSchema.parse(completedWithImages);
      if (completed.kind !== "blockDelta") {
        throw new Error(`expected blockDelta on ${label}`);
      }
      expect(completed.event.type, label).toBe("tool_call.completed");
      expect(completed.event, label).not.toHaveProperty("imageResults");

      // New event variant must not exist on any pre-image line.
      expect(
        contract.serverFrameSchema.safeParse(resolutionUpdated).success,
        label,
      ).toBe(false);
    }
  });

  it("binds the LIVE line (1.7) to the live chat schema, with 1.6 now pinned", () => {
    expect(chatSubscribeV17.schemaVersion).toEqual({ major: 1, minor: 7 });

    // The inverse of what this asserted while a 1.7 sat above a pre-image-
    // pinned 1.6. Collapsing that unreleased minor made 1.6 the live line, so
    // an image-bearing chat must now arrive INTACT rather than stripped -
    // stripping is what a frozen line does, and 1.6 has no peer to be frozen
    // against. The lines below it stay pinned because they DO have peers.
    const parsed = chatSubscribeV17.serverFrameSchema.parse(
      snapshotFrameWithChat(chatWithImages),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    const assistant = parsed.snapshot.chat.messages.find(
      (message) => message.role === "assistant",
    );
    if (!assistant || assistant.role !== "assistant") {
      throw new Error("expected assistant message");
    }
    expect(assistant.imageResolutions).toHaveLength(resolutionStates.length);
    const toolCall = assistant.blocks.find((block) => block.type === "tool_call");
    if (!toolCall || toolCall.type !== "tool_call") {
      throw new Error("expected tool_call block");
    }
    expect(toolCall.imageResults).toHaveLength(2);
    expect(parsed.snapshot.chat).toHaveProperty("pinnedUserProviderHandle");
    expect(parsed.snapshot.chat).toHaveProperty("lastDeliveredRolesDigest");
  });
});

describe("chat.subscribe registry membership", () => {
  it("registers chat.subscribe major 1 latestMinor 7 as chatSubscribeV17", () => {
    const entry = hostStreamRpcRegistry["chat.subscribe"];
    expect(entry).toBeDefined();
    expect(entry[1].latestMinor).toBe(7);
    expect(entry[1].versions[6].contract).toBe(chatSubscribeV16);
    expect(entry[1].versions[7].contract).toBe(chatSubscribeV17);
    expect(chatSubscribeV17.schemaVersion).toEqual({ major: 1, minor: 7 });
    expect(entry[1].versions).not.toHaveProperty("8");
  });
});

describe("chat.subscribe Reasonix anchor versioning", () => {
  const reasonixMessage: UserMessage = {
    ...userMessage,
    sessionAnchor: {
      harnessId: "reasonix",
      hostId: "test-host",
      sessionId: "reasonix-session-1",
      sessionWorkspaceSnapshot: {
        workspaceKind: "session-snapshot",
        primaryWorkspace: "/repo",
        secondaryWorkspaces: [],
      },
      createdAt: 1000,
      coveredUntilMessageId: null,
      profileId: null,
      labelSnapshot: null,
      accountUuid: null,
      accentColor: null,
    },
  };
  const frame = {
    kind: "messageAccepted" as const,
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    message: reasonixMessage,
  };

  it.each([
    ["1.0", chatSubscribeV10],
    ["1.1", chatSubscribeV11],
    ["1.2", chatSubscribeV12],
    ["1.3", chatSubscribeV13],
    ["1.4", chatSubscribeV14],
    ["1.5", chatSubscribeV15],
    ["1.6", chatSubscribeV16],
  ])("keeps a Reasonix anchor off released %s frames", (_version, contract) => {
    expect(contract.serverFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("carries a Reasonix anchor on the unreleased 1.7 line", () => {
    expect(chatSubscribeV17.serverFrameSchema.parse(frame)).toMatchObject({
      kind: "messageAccepted",
      message: { sessionAnchor: { harnessId: "reasonix" } },
    });
  });

  const anchorResolvedFrame = {
    kind: "blockDelta" as const,
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    event: {
      type: "user_message.anchor_resolved" as const,
      blockId: "message-1",
      timestamp: 1000,
      messageId: "message-1",
      anchor: {
        harnessId: "reasonix" as const,
        sessionId: "reasonix-session-1",
        reasonixSessionId: "reasonix-session-1",
      },
    },
  };

  it.each([
    ["1.0", chatSubscribeV10],
    ["1.1", chatSubscribeV11],
    ["1.2", chatSubscribeV12],
    ["1.3", chatSubscribeV13],
    ["1.4", chatSubscribeV14],
    ["1.5", chatSubscribeV15],
    ["1.6", chatSubscribeV16],
  ])(
    "keeps a Reasonix anchor-resolved event off released %s frames",
    (_version, contract) => {
      expect(
        contract.serverFrameSchema.safeParse(anchorResolvedFrame).success,
      ).toBe(false);
    },
  );

  it("carries a Reasonix anchor-resolved event on the unreleased 1.7 line", () => {
    expect(
      chatSubscribeV17.serverFrameSchema.parse(anchorResolvedFrame),
    ).toMatchObject({
      kind: "blockDelta",
      event: {
        type: "user_message.anchor_resolved",
        anchor: { harnessId: "reasonix" },
      },
    });
  });
});

// The anchor freezes above cover `user_message.anchor_resolved` only. A harness
// id also reaches a released server frame through the runtime session/plan
// events, the active turn, and every settings tuple (queue items + the chat
// record). Each of those is an independent path to the same break: a newer host
// projecting `"reasonix"` onto a negotiated minor whose installed client has a
// strict enum without it.
describe("chat.subscribe Reasonix released-frame freezes", () => {
  const RELEASED_CONTRACTS = [
    ["1.0", chatSubscribeV10],
    ["1.1", chatSubscribeV11],
    ["1.2", chatSubscribeV12],
    ["1.3", chatSubscribeV13],
    ["1.4", chatSubscribeV14],
    ["1.5", chatSubscribeV15],
    ["1.6", chatSubscribeV16],
  ] as const;

  const blockDelta = (event: unknown) => ({
    kind: "blockDelta" as const,
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    event,
  });

  const reasonixSettings = {
    harnessId: "reasonix" as const,
    model: "reasonix-pro",
    permissionMode: "supervised" as const,
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular" as const,
    profileId: null,
  };

  const reasonixActiveTurn = {
    turnId: "turn-1",
    status: "running" as const,
    harnessId: "reasonix" as const,
    model: "reasonix-pro",
    userMessageId: "message-1",
    startedAt: 2000,
    updatedAt: 2000,
  };

  const reasonixQueueItem = {
    queueItemId: "q-reasonix",
    messageId: "message-1",
    message: userMessage.message,
    sender: userMessage.sender,
    settings: reasonixSettings,
    createdAt: 2000,
    updatedAt: 2000,
  };

  const snapshotWith = (overrides: {
    chat?: Chat;
    activeTurn?: unknown;
    queueItems?: unknown[];
  }) => ({
    kind: "snapshot" as const,
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat: overrides.chat ?? chat,
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: overrides.queueItems ?? [] },
      activeTurn: overrides.activeTurn ?? null,
      runStatus: "idle",
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      accumulatedFileChanges: [],
    },
  });

  // Every frame below carries `reasonix` through a DIFFERENT schema path, so a
  // fix that freezes one and misses another still fails here.
  const reasonixFrames = [
    [
      "session.created blockDelta",
      blockDelta({
        type: "session.created",
        blockId: "block-1",
        timestamp: 1000,
        session: {
          id: "reasonix-session-1",
          harnessId: "reasonix",
          createdAt: 1000,
        },
      }),
    ],
    [
      "session.resumed blockDelta",
      blockDelta({
        type: "session.resumed",
        blockId: "block-1",
        timestamp: 1000,
        session: {
          id: "reasonix-session-1",
          harnessId: "reasonix",
          createdAt: 1000,
        },
      }),
    ],
    [
      "plan.delta blockDelta",
      blockDelta({
        type: "plan.delta",
        blockId: "block-1",
        timestamp: 1000,
        planId: "plan-1",
        source: {
          harnessId: "reasonix",
          sessionId: "reasonix-session-1",
          turnId: "turn-1",
          kind: "native",
        },
        delta: "step",
      }),
    ],
    [
      "plan.updated blockDelta",
      blockDelta({
        type: "plan.updated",
        blockId: "block-1",
        timestamp: 1000,
        planId: "plan-1",
        source: {
          harnessId: "reasonix",
          sessionId: "reasonix-session-1",
          turnId: "turn-1",
          kind: "native",
        },
      }),
    ],
    [
      "plan.completed blockDelta",
      blockDelta({
        type: "plan.completed",
        blockId: "block-1",
        timestamp: 1000,
        planId: "plan-1",
        source: {
          harnessId: "reasonix",
          sessionId: "reasonix-session-1",
          turnId: "turn-1",
          kind: "native",
        },
      }),
    ],
    [
      "turnStateChanged activeTurn",
      {
        kind: "turnStateChanged" as const,
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        runStatus: "running",
        activeTurn: reasonixActiveTurn,
      },
    ],
    ["snapshot activeTurn", snapshotWith({ activeTurn: reasonixActiveTurn })],
    [
      "queueChanged queue-item settings",
      {
        kind: "queueChanged" as const,
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        queue: { status: "idle", items: [reasonixQueueItem] },
      },
    ],
    [
      "snapshot queue-item settings",
      snapshotWith({ queueItems: [reasonixQueueItem] }),
    ],
    [
      "snapshot chat.settings",
      snapshotWith({ chat: { ...chat, settings: reasonixSettings } }),
    ],
  ] as const;

  it.each(
    reasonixFrames.flatMap(([path, frame]) =>
      RELEASED_CONTRACTS.map(
        ([version, contract]) => [path, version, contract, frame] as const,
      ),
    ),
  )("keeps %s off released %s frames", (_path, _version, contract, frame) => {
    expect(contract.serverFrameSchema.safeParse(frame).success).toBe(false);
  });

  it.each(reasonixFrames)(
    "carries %s on the unreleased 1.7 line",
    (_path, frame) => {
      expect(chatSubscribeV17.serverFrameSchema.safeParse(frame).success).toBe(
        true,
      );
    },
  );

  // The freezes above must narrow ONLY the harness enum. If a released line
  // stopped accepting the harnesses it already ships with, the same freeze that
  // fixes Reasonix would break every existing client instead.
  it.each(RELEASED_CONTRACTS)(
    "still accepts a pre-Reasonix harness on released %s frames",
    (_version, contract) => {
      const claudeFrames = [
        blockDelta({
          type: "session.created",
          blockId: "block-1",
          timestamp: 1000,
          session: { id: "session-1", harnessId: "claude", createdAt: 1000 },
        }),
        {
          kind: "turnStateChanged" as const,
          hasBinaryPayload: false,
          epicId: "epic-1",
          chatId: "chat-1",
          runStatus: "running",
          activeTurn: { ...reasonixActiveTurn, harnessId: "claude" },
        },
        {
          kind: "queueChanged" as const,
          hasBinaryPayload: false,
          epicId: "epic-1",
          chatId: "chat-1",
          queue: {
            status: "idle",
            items: [
              {
                ...reasonixQueueItem,
                settings: { ...reasonixSettings, harnessId: "claude" },
              },
            ],
          },
        },
      ];

      for (const frame of claudeFrames) {
        expect(contract.serverFrameSchema.safeParse(frame).success).toBe(true);
      }
    },
  );

  // `1.5` shipped `sameTurnSteeringSupported`; the Reasonix freeze must not roll
  // that field back while pinning the enum.
  it("keeps the 1.5 steering-capability field on the 1.5 active turn", () => {
    const parsed = chatSubscribeV15.serverFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: {
        ...reasonixActiveTurn,
        harnessId: "claude",
        sameTurnSteeringSupported: true,
      },
    });
    if (parsed.kind !== "turnStateChanged") {
      throw new Error("expected turnStateChanged");
    }
    expect(parsed.activeTurn).toMatchObject({
      sameTurnSteeringSupported: true,
    });
  });

  // Every NEWLY frozen harness-bearing path gets its own runtime negative, so a
  // future edit to any single leaf fails here rather than only in the
  // structural compat gate. Each frame names `reasonix` in exactly one place.
  const agentSender = (harnessId: string) => ({
    type: "agent" as const,
    harnessId,
    agentId: "agent-1",
    displayName: null,
    reply: { expectsReply: false as const },
    inReplyTo: null,
  });

  const assistantRow = (harnessId: string) => ({
    role: "assistant" as const,
    messageId: "assistant-1",
    sender: agentSender(harnessId),
    blocks: [],
    startedAt: null,
    timestamp: 2000,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  });

  const planBlock = (harnessId: string) => ({
    blockId: "block-1",
    status: "completed" as const,
    timestamp: 1,
    type: "plan" as const,
    planStatus: "ready" as const,
    planId: "plan-1",
    harnessId,
    source: { harnessId, sessionId: "s1", turnId: "t1", kind: "native" },
  });

  const noticeBlock = (harnessId: string) => ({
    blockId: "block-1",
    status: "completed" as const,
    timestamp: 1,
    type: "text" as const,
    text: "hi",
    providerNotice: {
      harnessId,
      noticeKind: "model_rerouted" as const,
      tone: "info" as const,
      title: "t",
      message: null,
      details: [],
      metadata: null,
    },
  });

  const steerBlock = (harnessId: string) => ({
    blockId: "block-1",
    status: "completed" as const,
    timestamp: 1,
    type: "steer" as const,
    queueItemId: "q1",
    messageId: "m1",
    content: { type: "doc", content: [] },
    mode: "safe_point" as const,
    sender: agentSender(harnessId),
  });

  const sessionChain = (harnessId: string) => ({
    harnessId,
    sessionId: "s1",
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    coveredUntilMessageId: null,
    profileId: null,
  });

  const eventWithActor = (harnessId: string) => ({
    ...event,
    actor: agentSender(harnessId),
  });

  const assistantWithBlocks = (harnessId: string, block: unknown) => ({
    ...assistantRow("claude"),
    blocks: [block],
  });

  // Each entry builds the SAME frame twice - once naming `reasonix`, once
  // naming `claude` - so the negative and its control cannot drift apart.
  const perPathFrames = [
    [
      "snapshot chat.messages[].sender",
      (h: string) =>
        snapshotWith({ chat: { ...chat, messages: [assistantRow(h)] } as Chat }),
    ],
    [
      "snapshot chat.activeSessionChain",
      (h: string) =>
        snapshotWith({ chat: { ...chat, activeSessionChain: sessionChain(h) } as Chat }),
    ],
    [
      "snapshot chat.messages[].blocks[plan]",
      (h: string) =>
        snapshotWith({
          chat: {
            ...chat,
            messages: [assistantWithBlocks(h, planBlock(h))],
          } as Chat,
        }),
    ],
    [
      "snapshot chat.messages[].blocks[text].providerNotice",
      (h: string) =>
        snapshotWith({
          chat: {
            ...chat,
            messages: [assistantWithBlocks(h, noticeBlock(h))],
          } as Chat,
        }),
    ],
    [
      "snapshot chat.messages[].blocks[steer].sender",
      (h: string) =>
        snapshotWith({
          chat: {
            ...chat,
            messages: [assistantWithBlocks(h, steerBlock(h))],
          } as Chat,
        }),
    ],
    [
      "snapshot chat.events[].actor",
      (h: string) =>
        snapshotWith({ chat: { ...chat, events: [eventWithActor(h)] } as Chat }),
    ],
    [
      "messageAccepted message.sender",
      (h: string) => ({
        kind: "messageAccepted" as const,
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        message: {
          ...userMessage,
          sender: agentSender(h),
          message: {
            kind: "agent" as const,
            content: { type: "doc", content: [] },
            fromAgentId: "agent-1",
            senderTitle: null,
            senderHarnessId: null,
            reply: { expectsReply: false as const },
          },
        },
      }),
    ],
    [
      "eventAppended event.actor",
      (h: string) => ({
        kind: "eventAppended" as const,
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        event: eventWithActor(h),
      }),
    ],
    [
      "queueChanged queue-item sender",
      (h: string) => ({
        kind: "queueChanged" as const,
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        queue: {
          status: "idle",
          items: [
            {
              ...reasonixQueueItem,
              settings: { ...reasonixSettings, harnessId: "claude" },
              sender: agentSender(h),
              message: {
                kind: "agent" as const,
                content: { type: "doc", content: [] },
                fromAgentId: "agent-1",
                senderTitle: null,
                senderHarnessId: null,
                reply: { expectsReply: false as const },
              },
            },
          ],
        },
      }),
    ],
    [
      "blockDelta steer.submitted sender",
      (h: string) =>
        blockDelta({
          type: "steer.submitted",
          blockId: "block-1",
          timestamp: 1,
          queueItemId: "q1",
          messageId: "m1",
          content: { type: "doc", content: [] },
          mode: "safe_point",
          sender: agentSender(h),
        }),
    ],
    [
      // `provider_notice.upsert` arrived on 1.3, so 1.1/1.2 reject it outright
      // and have no meaningful `claude` control - the negative still holds
      // there, trivially.
      "blockDelta provider_notice.upsert",
      (h: string) =>
        blockDelta({
          type: "provider_notice.upsert",
          blockId: "block-1",
          timestamp: 1,
          harnessId: h,
          noticeKind: "model_rerouted",
          tone: "info",
          status: "completed",
          title: "t",
          message: null,
          details: [],
          fallbackText: "t",
          metadata: null,
        }),
    ],
  ] as const;

  // Rows whose EVENT predates a given minor: the negative still holds, but the
  // `claude` control cannot, because that line has no such variant at all.
  const CONTROL_NOT_APPLICABLE: Readonly<Record<string, readonly string[]>> = {
    "blockDelta provider_notice.upsert": ["1.1", "1.2"],
  };

  it.each(
    perPathFrames.flatMap(([path, build]) =>
      RELEASED_CONTRACTS.map(
        ([version, contract]) => [path, version, contract, build] as const,
      ),
    ),
  )(
    "keeps %s off released %s frames",
    (path, version, contract, build) => {
      expect(contract.serverFrameSchema.safeParse(build("reasonix")).success).toBe(
        false,
      );
      if ((CONTROL_NOT_APPLICABLE[path] ?? []).includes(version)) return;
      // Paired control: the identical frame naming a shipped harness parses,
      // so the negative above cannot be passing for a structural reason.
      expect(contract.serverFrameSchema.safeParse(build("claude")).success).toBe(
        true,
      );
    },
  );

  it.each(perPathFrames)("carries %s on the unreleased 1.7 line", (_path, build) => {
    expect(
      chatSubscribeV17.serverFrameSchema.safeParse(build("reasonix")).success,
    ).toBe(true);
  });

  // ...and ≤1.4 must still strip it, exactly as before the enum pin.
  it("still strips the steering-capability field on the 1.4 active turn", () => {
    const parsed = chatSubscribeV14.serverFrameSchema.parse({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: {
        ...reasonixActiveTurn,
        harnessId: "claude",
        sameTurnSteeringSupported: true,
      },
    });
    if (parsed.kind !== "turnStateChanged") {
      throw new Error("expected turnStateChanged");
    }
    expect(parsed.activeTurn).not.toHaveProperty("sameTurnSteeringSupported");
  });

  it("carries a Reasonix active turn and queue item on the unreleased 1.7 line", () => {
    const parsed = chatSubscribeV17.serverFrameSchema.parse(
      snapshotWith({
        activeTurn: reasonixActiveTurn,
        queueItems: [reasonixQueueItem],
        chat: { ...chat, settings: reasonixSettings },
      }),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.activeTurn).toMatchObject({
      harnessId: "reasonix",
    });
    expect(parsed.snapshot.chat.settings).toMatchObject({
      harnessId: "reasonix",
    });
    expect(parsed.snapshot.queue.items[0]).toMatchObject({
      settings: { harnessId: "reasonix" },
    });
  });

  it("keeps `1.6` registered and bound to its own frozen contract", () => {
    // `1.6` shipped in `host-v1.2.0-rc.1`, so it must stay negotiable AND stop
    // following the live schemas. It used to BE the live line; the assertion
    // that matters now is that the two contracts are distinct objects.
    const entry = hostStreamRpcRegistry["chat.subscribe"];
    expect(entry[1].versions[6].contract).toBe(chatSubscribeV16);
    expect(chatSubscribeV16.schemaVersion).toEqual({ major: 1, minor: 6 });
    expect(chatSubscribeV16.serverFrameSchema).not.toBe(
      chatSubscribeV17.serverFrameSchema,
    );
    expect(chatSubscribeV16.clientFrameSchema).not.toBe(
      chatSubscribeV17.clientFrameSchema,
    );
  });

  it("points the live-line constant at `1.7`", () => {
    expect(chatSubscribeLiveSchemaVersion).toEqual({ major: 1, minor: 7 });
  });
});

describe("guiAgentModelCapabilitiesSchema (imageGeneration)", () => {
  it("parses { imageGeneration: true } and defaults omitted imageGeneration to false", () => {
    expect(
      guiAgentModelCapabilitiesSchema.parse({ imageGeneration: true }),
    ).toEqual({ imageGeneration: true });
    expect(guiAgentModelCapabilitiesSchema.parse({})).toEqual({
      imageGeneration: false,
    });
  });

  it("leaves guiAgentModelOptionSchema.metadata as an open record", () => {
    const parsed = guiAgentModelOptionSchema.parse({
      harnessId: "codex",
      slug: "gpt-5",
      label: "GPT-5",
      description: null,
      contextWindow: 200000,
      maxOutputTokens: 8192,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
      metadata: {
        capabilities: { imageGeneration: true, extraFutureFlag: "ok" },
        anythingElse: 42,
      },
    });
    expect(parsed.metadata).toEqual({
      capabilities: { imageGeneration: true, extraFutureFlag: "ok" },
      anythingElse: 42,
    });
  });
});
