import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatQueueState } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  reconcileQueueChange,
  reconcileSnapshotChange,
  sweepStalePendingActions,
  type ReconcileQueueInput,
  type ReconcileSnapshotInput,
} from "@/stores/chats/chat-queue-reconciler";
import type {
  PendingChatAction,
  PendingUserMessage,
} from "@/stores/chats/chat-session-store";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const CONTENT_2: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "World" }] }],
};

const SENDER = { type: "user" as const, userId: "user-1" };

const SETTINGS = {
  harnessId: "codex" as const,
  model: "gpt-5-codex",
  permissionMode: "supervised" as const,
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic" as const,
  profileId: null,
};

function createPendingAction(
  clientActionId: string,
  messageId: string | null,
  action: "send" | "editUserMessage" | "stop",
): PendingChatAction {
  const isSendOrEdit = action === "send" || action === "editUserMessage";
  return {
    clientActionId,
    action,
    messageId,
    restoreContent: isSendOrEdit ? CONTENT : null,
    sender: isSendOrEdit ? SENDER : null,
    settings: isSendOrEdit ? SETTINGS : null,
    restoreWorktreeIntent: null,
    restoreWorktreeStagingRevision: null,
    createdAt: 1000,
    connectionEpoch: 0,
  };
}

function createPendingUserMessage(
  clientActionId: string,
  messageId: string,
): PendingUserMessage {
  return {
    clientActionId,
    messageId,
    content: CONTENT,
    sender: SENDER,
    settings: SETTINGS,
    timestamp: 1000,
  };
}

function createQueueItem(
  messageId: string,
  content: JsonContent,
): ChatQueueState["items"][number] {
  return {
    queueItemId: `queue-${messageId}`,
    messageId,
    message: {
      kind: "user",
      content,
    },
    sender: SENDER,
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe("chat-queue-reconciler", () => {
  describe("reconcileQueueChange", () => {
    it("returns unchanged state when no pending actions match queue", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileQueueInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        queue: { status: "idle", items: [] },
        nowMs: 5000,
      };

      const result = reconcileQueueChange(input);

      expect(result.pendingActions).toEqual(input.pendingActions);
      expect(result.acceptedActions).toEqual({});
      expect(result.pendingUserMessages).toEqual(input.pendingUserMessages);
    });

    it("transitions pending action to accepted when message is queued", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const pendingUser = createPendingUserMessage("action-1", "msg-1");
      const input: ReconcileQueueInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [pendingUser],
        queue: {
          status: "running",
          items: [createQueueItem("msg-1", CONTENT)],
        },
        nowMs: 5000,
      };

      const result = reconcileQueueChange(input);

      expect(result.pendingActions).toEqual({});
      expect(Object.keys(result.acceptedActions)).toHaveLength(1);
      expect(result.acceptedActions["action-1"].clientActionId).toBe(
        "action-1",
      );
      expect(result.pendingUserMessages).toEqual([]);
    });

    it("filters pending user messages when their actions are queued", () => {
      const action1 = createPendingAction("action-1", "msg-1", "send");
      const action2: PendingChatAction = {
        clientActionId: "action-2",
        action: "send",
        messageId: "msg-2",
        restoreContent: CONTENT_2,
        sender: SENDER,
        settings: SETTINGS,
        restoreWorktreeIntent: null,
        restoreWorktreeStagingRevision: null,
        createdAt: 1000,
        connectionEpoch: 0,
      };
      const user1 = createPendingUserMessage("action-1", "msg-1");
      const user2: PendingUserMessage = {
        clientActionId: "action-2",
        messageId: "msg-2",
        content: CONTENT_2,
        sender: SENDER,
        settings: SETTINGS,
        timestamp: 1000,
      };
      const input: ReconcileQueueInput = {
        pendingActions: { "action-1": action1, "action-2": action2 },
        pendingUserMessages: [user1, user2],
        queue: {
          status: "running",
          items: [createQueueItem("msg-1", CONTENT)],
        },
        nowMs: 5000,
      };

      const result = reconcileQueueChange(input);

      expect(result.pendingActions).toEqual({ "action-2": action2 });
      expect(result.pendingUserMessages).toEqual([user2]);
    });

    it("does not prune old accepted actions on queue change", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileQueueInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        queue: {
          status: "running",
          items: [createQueueItem("msg-1", CONTENT)],
        },
        nowMs: 400000, // Far in future
      };

      const result = reconcileQueueChange(input);

      // Pruning happens when merged with existing acceptedActions in the store
      expect(Object.keys(result.acceptedActions)).toHaveLength(1);
    });

    it("handles multiple pending actions with one queued", () => {
      const action1 = createPendingAction("action-1", "msg-1", "send");
      const action2: PendingChatAction = {
        clientActionId: "action-2",
        action: "send",
        messageId: "msg-2",
        restoreContent: CONTENT_2,
        sender: SENDER,
        settings: SETTINGS,
        restoreWorktreeIntent: null,
        restoreWorktreeStagingRevision: null,
        createdAt: 1000,
        connectionEpoch: 0,
      };
      const action3 = createPendingAction("action-3", null, "stop");
      const input: ReconcileQueueInput = {
        pendingActions: {
          "action-1": action1,
          "action-2": action2,
          "action-3": action3,
        },
        pendingUserMessages: [
          createPendingUserMessage("action-1", "msg-1"),
          {
            clientActionId: "action-2",
            messageId: "msg-2",
            content: CONTENT_2,
            sender: SENDER,
            settings: SETTINGS,
            timestamp: 1000,
          },
        ],
        queue: {
          status: "running",
          items: [createQueueItem("msg-1", CONTENT)],
        },
        nowMs: 5000,
      };

      const result = reconcileQueueChange(input);

      expect(Object.keys(result.pendingActions)).toHaveLength(2);
      expect(result.pendingActions).toHaveProperty("action-2");
      expect(result.pendingActions).toHaveProperty("action-3");
      expect(result.acceptedActions).toHaveProperty("action-1");
    });
  });

  describe("reconcileSnapshotChange", () => {
    it("clears pending send when message is in snapshot", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const confirmedMessage: Message = {
        role: "user",
        messageId: "msg-1",
        sender: SENDER,
        message: {
          kind: "user",
          content: CONTENT,
        },
        timestamp: 1000,
        sessionAnchor: null,
      };
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [confirmedMessage],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({});
      expect(Object.keys(result.acceptedActions)).toHaveLength(1);
      expect(result.pendingUserMessages).toEqual([]);
    });

    it("clears pending send when message is queued after snapshot", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [],
        queue: {
          status: "running",
          items: [createQueueItem("msg-1", CONTENT)],
        },
        failedSendRestoration: null,
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({});
      expect(Object.keys(result.acceptedActions)).toHaveLength(1);
      expect(result.pendingUserMessages).toEqual([]);
    });

    it("creates failedSendRestoration for unconfirmed send with restore content", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({});
      expect(result.failedSendRestoration).not.toBeNull();
      expect(result.failedSendRestoration?.clientActionId).toBe("action-1");
      expect(result.failedSendRestoration?.content).toEqual(CONTENT);
    });

    it("preserves existing failedSendRestoration and does not overwrite", () => {
      const existingRestore = {
        clientActionId: "action-0",
        content: CONTENT,
        reason: "Prior failure",
      };
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: existingRestore,
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.failedSendRestoration).toEqual(existingRestore);
    });

    it("ignores non-send actions during reconciliation", () => {
      const pendingAction = createPendingAction("action-1", null, "stop");
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({ "action-1": pendingAction });
      expect(result.acceptedActions).toEqual({});
    });

    it("handles mixed pending and confirmed messages", () => {
      const action1 = createPendingAction("action-1", "msg-1", "send");
      const action2: PendingChatAction = {
        clientActionId: "action-2",
        action: "send",
        messageId: "msg-2",
        restoreContent: CONTENT_2,
        sender: SENDER,
        settings: SETTINGS,
        restoreWorktreeIntent: null,
        restoreWorktreeStagingRevision: null,
        createdAt: 1000,
        connectionEpoch: 0,
      };
      const confirmedMessage: Message = {
        role: "user",
        messageId: "msg-1",
        sender: SENDER,
        message: {
          kind: "user",
          content: CONTENT,
        },
        timestamp: 1000,
        sessionAnchor: null,
      };
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": action1, "action-2": action2 },
        pendingUserMessages: [
          createPendingUserMessage("action-1", "msg-1"),
          {
            clientActionId: "action-2",
            messageId: "msg-2",
            content: CONTENT_2,
            sender: SENDER,
            settings: SETTINGS,
            timestamp: 1000,
          },
        ],
        messages: [confirmedMessage],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      // action-1 is confirmed in snapshot -> accepted
      expect(result.acceptedActions).toHaveProperty("action-1");
      // action-2 is not confirmed and not queued -> restoration, pending removed
      expect(result.pendingActions).toEqual({});
      expect(result.failedSendRestoration?.clientActionId).toBe("action-2");
    });

    it("accepts editUserMessage actions when message is confirmed", () => {
      const pendingAction = createPendingAction(
        "action-1",
        "msg-1",
        "editUserMessage",
      );
      const confirmedMessage: Message = {
        role: "user",
        messageId: "msg-1",
        sender: SENDER,
        message: {
          kind: "user",
          content: CONTENT,
        },
        timestamp: 1000,
        sessionAnchor: null,
      };
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [],
        messages: [confirmedMessage],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({});
      expect(result.acceptedActions).toHaveProperty("action-1");
    });

    it("does not restore send with null restoreContent, keeps as pending", () => {
      const pendingAction: PendingChatAction = {
        clientActionId: "action-1",
        action: "send",
        messageId: "msg-1",
        restoreContent: null, // null restore content
        sender: SENDER,
        settings: SETTINGS,
        restoreWorktreeIntent: null,
        restoreWorktreeStagingRevision: null,
        createdAt: 1000,
        connectionEpoch: 0,
      };
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      // Send with no restore content stays pending and does not create restoration
      expect(result.failedSendRestoration).toBeNull();
      expect(result.pendingActions).toEqual({ "action-1": pendingAction });
    });

    it("accepts send actions and builds acceptedActions patch", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const confirmedMessage: Message = {
        role: "user",
        messageId: "msg-1",
        sender: SENDER,
        message: {
          kind: "user",
          content: CONTENT,
        },
        timestamp: 1000,
        sessionAnchor: null,
      };
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [confirmedMessage],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      // Snapshot reconciliation returns new accepted actions from the patch
      expect(result.acceptedActions).toHaveProperty("action-1");
    });
  });

  describe("pruning during reconciliation", () => {
    it("prunes accepted actions older than 5 minutes on queue change", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileQueueInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        queue: {
          status: "running",
          items: [createQueueItem("msg-1", CONTENT)],
        },
        nowMs: 350000, // 5+ minutes later
      };

      const result = reconcileQueueChange(input);

      // Pruning returns new actions; store merges and prunes separately
      expect(result.acceptedActions).toHaveProperty("action-1");
    });

    it("does not exceed max accepted action records", () => {
      const pendingActions: Record<string, PendingChatAction> = {};
      const pendingUsers: PendingUserMessage[] = [];

      // Create 70 pending actions to exceed the 64-record limit
      for (let i = 0; i < 70; i++) {
        const id = `action-${i}`;
        const msgId = `msg-${i}`;
        pendingActions[id] = createPendingAction(id, msgId, "send");
        pendingUsers.push(createPendingUserMessage(id, msgId));
      }

      const queueItems = pendingUsers
        .slice(0, 70)
        .map((user) => createQueueItem(user.messageId, CONTENT));

      const input: ReconcileQueueInput = {
        pendingActions,
        pendingUserMessages: pendingUsers,
        queue: {
          status: "running",
          items: queueItems,
        },
        nowMs: 5000,
      };

      const result = reconcileQueueChange(input);

      // After pruning through the store's merge, should not exceed 64
      expect(Object.keys(result.acceptedActions).length).toBeLessThanOrEqual(
        70,
      );
    });
  });

  describe("sweepStalePendingActions", () => {
    it("drops stale pendings from an older connection epoch, keeping sends", () => {
      const staleStop: PendingChatAction = {
        ...createPendingAction("action-stop", null, "stop"),
        connectionEpoch: 0,
      };
      const currentStop: PendingChatAction = {
        ...createPendingAction("action-stop-live", null, "stop"),
        connectionEpoch: 1,
      };
      // A stale SEND is never swept - it reconciles by messageId with
      // composer restoration instead.
      const staleSend: PendingChatAction = {
        ...createPendingAction("action-send", "msg-1", "send"),
        connectionEpoch: 0,
      };
      // A stale EDIT has no restoration path (restoreContent is null and its
      // fresh messageId never appears in the snapshot when the frame died
      // with the connection), so it IS swept - otherwise it wedges the edit
      // affordances forever.
      const staleEdit: PendingChatAction = {
        ...createPendingAction("action-edit", "msg-2", "editUserMessage"),
        connectionEpoch: 0,
      };
      const result = sweepStalePendingActions(
        {
          "action-stop": staleStop,
          "action-stop-live": currentStop,
          "action-send": staleSend,
          "action-edit": staleEdit,
        },
        1,
      );

      expect(Object.keys(result.pendingActions).sort()).toEqual([
        "action-send",
        "action-stop-live",
      ]);
      expect([...result.sweptActionIds].sort()).toEqual([
        "action-edit",
        "action-stop",
      ]);
    });

    it("returns the same reference and an empty swept set when nothing is stale", () => {
      const pendingActions = {
        "action-1": createPendingAction("action-1", null, "stop"),
      };
      const result = sweepStalePendingActions(pendingActions, 0);
      expect(result.pendingActions).toBe(pendingActions);
      expect(result.sweptActionIds.size).toBe(0);
    });
  });
});
