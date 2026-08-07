import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  chatActiveTurnSchema,
  chatQueuedItemSchema,
  chatQueuedManagedCommandItemSchema,
  chatSubscribeClientFrameSchema,
  chatSubscribeServerFrameSchema,
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { autonomousResumeTriggerSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  Chat,
  ChatEvent,
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
    const parsed = chatSubscribeV16.serverFrameSchema.parse(
      snapshotFrameWithQueueItems([managedCommandItem]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.queue.items[0]).toMatchObject({
      kind: "managed-command",
      commandId: "command-1",
    });
  });

  it("carries a managed-command queue item through a 1.6 queueChanged frame", () => {
    const parsed = chatSubscribeV16.serverFrameSchema.parse({
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
  const monitor = {
    id: "command-1",
    kind: "monitor" as const,
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
    managedCommands: [monitor],
  };

  it("carries the chat's commands on a live snapshot", () => {
    const parsed = chatSubscribeV16.serverFrameSchema.parse(
      snapshotFrameWithManagedCommands([monitor]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.managedCommands).toEqual([monitor]);
  });

  // Optional on the wire, always present after parsing: no consumer ever
  // null-checks the set, on either channel.
  it("defaults an omitted set to empty rather than undefined", () => {
    const frame = snapshotFrameWithManagedCommands([]);
    const snapshot = frame["snapshot"] as Record<string, unknown>;
    delete snapshot["managedCommands"];

    const parsed = chatSubscribeV16.serverFrameSchema.parse(frame);
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.managedCommands).toEqual([]);

    const changed = chatSubscribeV16.serverFrameSchema.parse({
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
      snapshotFrameWithManagedCommands([monitor]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot).not.toHaveProperty("managedCommands");
  });

  it("carries the whole set on every managedCommandsChanged frame", () => {
    const parsed = chatSubscribeV16.serverFrameSchema.parse(
      managedCommandsChangedFrame,
    );
    if (parsed.kind !== "managedCommandsChanged") {
      throw new Error("expected managedCommandsChanged");
    }
    expect(parsed.managedCommands).toEqual([monitor]);
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
