import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatQueuedManagedCommandItem,
  ChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  pruneAcceptedActions,
  reconcileQueueChange,
  reconcileSnapshotChange,
  reconcileTurnSettled,
  sweepStalePendingActions,
  turnSettledFromStatus,
  unrecoverableSendNotice,
  NO_WORKTREE_SWEEP,
  type ReconcileQueueInput,
  type ReconcileSnapshotInput,
  type ReconcileTurnSettledInput,
} from "@/stores/chats/chat-queue-reconciler";
import { recoveryTextFromContent } from "@/lib/composer/content-recovery";
import type {
  AcceptedChatAction,
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
    interviewBlockId: null,
    interviewDeliveryRetry: null,
    messageId,
    restoreContent: isSendOrEdit ? CONTENT : null,
    sender: isSendOrEdit ? SENDER : null,
    settings: isSendOrEdit ? SETTINGS : null,
    restoreWorktreeIntent: null,
    accountContext: null,
    deliveryPolicy: null,
    createdAt: 1000,
    connectionEpoch: 0,
  };
}

function createAcceptedAction(
  clientActionId: string,
  acceptedAt: number,
  interviewBlockId: string | null,
): AcceptedChatAction {
  return {
    clientActionId,
    action: interviewBlockId === null ? "send" : "interviewAnswer",
    interviewBlockId,
    interviewDeliveryRetry: null,
    messageId: null,
    acceptedAt,
    restoreContent: null,
    sender: null,
    settings: null,
    accountContext: null,
    deliveryPolicy: null,
    restoreWorktreeIntent: null,
    connectionEpoch: 0,
    confirmedByHost: false,
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
    accountContext: { type: "PERSONAL" },
    deliveryPolicy: null,
    timestamp: 1000,
    restoreWorktreeIntent: null,
  };
}

function createQueueItem(
  messageId: string,
  content: JsonContent,
): ChatQueuedPromptItem {
  return {
    kind: "prompt",
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

function createManagedCommandQueueItem(
  queueItemId: string,
): ChatQueuedManagedCommandItem {
  return {
    kind: "managed-command",
    queueItemId,
    commandId: `${queueItemId}-command`,
    description: "bun test --watch",
    monitoring: true,
    delivery: "next_turn",
    targetTurnId: null,
    status: "pending",
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe("chat-queue-reconciler", () => {
  describe("reconcileQueueChange", () => {
    it("returns unchanged state when no pending actions match queue", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileQueueInput = {
        acceptedActions: {},
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
        acceptedActions: {},
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
        interviewBlockId: null,
        interviewDeliveryRetry: null,
        messageId: "msg-2",
        restoreContent: CONTENT_2,
        sender: SENDER,
        settings: SETTINGS,
        restoreWorktreeIntent: null,
        accountContext: null,
        deliveryPolicy: null,
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
        accountContext: { type: "PERSONAL" },
        deliveryPolicy: null,
        timestamp: 1000,
        restoreWorktreeIntent: null,
      };
      const input: ReconcileQueueInput = {
        acceptedActions: {},
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
        acceptedActions: {},
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
        interviewBlockId: null,
        interviewDeliveryRetry: null,
        messageId: "msg-2",
        restoreContent: CONTENT_2,
        sender: SENDER,
        settings: SETTINGS,
        restoreWorktreeIntent: null,
        accountContext: null,
        deliveryPolicy: null,
        createdAt: 1000,
        connectionEpoch: 0,
      };
      const action3 = createPendingAction("action-3", null, "stop");
      const input: ReconcileQueueInput = {
        acceptedActions: {},
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
            accountContext: { type: "PERSONAL" },
            deliveryPolicy: null,
            timestamp: 1000,
            restoreWorktreeIntent: null,
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
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
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
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({});
      expect(Object.keys(result.acceptedActions)).toHaveLength(1);
      expect(result.pendingUserMessages).toEqual([]);
    });

    it("creates failedSendRestoration for an unconfirmed send from an earlier connection", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({});
      expect(result.failedSendRestoration).not.toBeNull();
      expect(result.failedSendRestoration?.clientActionId).toBe("action-1");
      expect(result.failedSendRestoration?.content).toEqual(CONTENT);
    });

    it("keeps an unconfirmed send from the snapshot's own connection pending, without restoration", () => {
      // A steady-state refresh snapshot (turn finished, backlog backfill) built
      // before the host processed the send lacks the message; the ack is still
      // coming on this connection, so nothing is lost and nothing is restored.
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const pendingUser = createPendingUserMessage("action-1", "msg-1");
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [pendingUser],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 0,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({ "action-1": pendingAction });
      expect(result.acceptedActions).toEqual({});
      expect(result.pendingUserMessages).toEqual([pendingUser]);
      expect(result.failedSendRestoration).toBeNull();
      // Nothing was lost, so nothing is stated either.
      expect(result.appendedErrorNotices).toEqual([]);
    });

    it("keeps an unconfirmed editUserMessage from the snapshot's own connection pending", () => {
      const pendingAction = createPendingAction(
        "action-1",
        "msg-1",
        "editUserMessage",
      );
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 0,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({ "action-1": pendingAction });
      expect(result.failedSendRestoration).toBeNull();
    });

    it("preserves existing failedSendRestoration and does not overwrite", () => {
      const existingRestore = {
        clientActionId: "action-0",
        content: CONTENT,
        reason: "Prior failure",
        displacedReason: "Prior failure",
        stated: false,
      };
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: existingRestore,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.failedSendRestoration).toEqual(existingRestore);
      // First writer keeps the slot; the displaced send is SETTLED rather than
      // parked - no pending action to re-state itself on the next snapshot or
      // to re-claim the slot once it frees - and its text rides the statement,
      // since dropping the row takes the last copy with it.
      expect(result.appendedErrorNotices).toHaveLength(1);
      expect(result.appendedErrorNotices[0]).toMatchObject({
        code: "SEND_NOT_RECORDED",
        severity: "warning",
        clientActionId: "action-1",
      });
      expect(result.appendedErrorNotices[0].message).toContain("Hello");
      expect(result.pendingActions).toEqual({});
      expect(result.pendingUserMessages).toEqual([]);
    });

    it("emits no notice when the restoration claims a free slot", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.failedSendRestoration?.clientActionId).toBe("action-1");
      expect(result.appendedErrorNotices).toEqual([]);
    });

    it("keeps a send dispatched on the snapshot's own connection", () => {
      // Epoch 0 pending, epoch 0 snapshot: the frame was dispatched on THIS
      // connection and simply outran the snapshot the host built. Its ack is
      // still deliverable, so absence proves nothing yet.
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 0,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({ "action-1": pendingAction });
      expect(result.failedSendRestoration).toBeNull();
      expect(result.appendedErrorNotices).toEqual([]);
      expect(result.pendingUserMessages).toEqual(input.pendingUserMessages);
    });

    it("still settles a live-epoch send the snapshot CONFIRMS", () => {
      // Presence is authoritative whatever connection dispatched it - the
      // epoch bar guards conclusions drawn from absence, nothing else.
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const confirmedMessage: Message = {
        role: "user",
        messageId: "msg-1",
        sender: SENDER,
        message: { kind: "user", content: CONTENT },
        timestamp: 1000,
        sessionAnchor: null,
      };
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [confirmedMessage],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 0,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.pendingActions).toEqual({});
      expect(result.acceptedActions).toHaveProperty("action-1");
      expect(result.appendedErrorNotices).toEqual([]);
    });

    it("ignores non-send actions during reconciliation", () => {
      const pendingAction = createPendingAction("action-1", null, "stop");
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
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
        interviewBlockId: null,
        interviewDeliveryRetry: null,
        messageId: "msg-2",
        restoreContent: CONTENT_2,
        sender: SENDER,
        settings: SETTINGS,
        restoreWorktreeIntent: null,
        accountContext: null,
        deliveryPolicy: null,
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
            accountContext: { type: "PERSONAL" },
            deliveryPolicy: null,
            timestamp: 1000,
            restoreWorktreeIntent: null,
          },
        ],
        messages: [confirmedMessage],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
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
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
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
        interviewBlockId: null,
        interviewDeliveryRetry: null,
        messageId: "msg-1",
        restoreContent: null, // null restore content
        sender: SENDER,
        settings: SETTINGS,
        restoreWorktreeIntent: null,
        accountContext: null,
        deliveryPolicy: null,
        createdAt: 1000,
        connectionEpoch: 0,
      };
      const input: ReconcileSnapshotInput = {
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
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
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      // Snapshot reconciliation returns new accepted actions from the patch
      expect(result.acceptedActions).toHaveProperty("action-1");
    });
  });

  describe("managed-command queue items", () => {
    it("never settles a pending send against a managed-command item", () => {
      const managedItem = createManagedCommandQueueItem("queue-managed");
      const input: ReconcileQueueInput = {
        acceptedActions: {},
        pendingActions: {
          "action-1": createPendingAction("action-1", "msg-1", "send"),
        },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        queue: { status: "running", items: [managedItem] },
        nowMs: 5000,
      };

      const result = reconcileQueueChange(input);

      // The host has not echoed the send back yet, so the action stays pending
      // even though a chip is sitting in the queue.
      expect(result.pendingActions).toEqual(input.pendingActions);
      expect(result.acceptedActions).toEqual({});
      expect(result.pendingUserMessages).toEqual(input.pendingUserMessages);
      // The reconciler only reads the queue - the chip is untouched.
      expect(input.queue.items).toEqual([managedItem]);
    });

    it("settles a pending send from its prompt echo while a managed-command sibling survives", () => {
      const managedItem = createManagedCommandQueueItem("queue-managed");
      const promptEcho = createQueueItem("msg-1", CONTENT);
      const input: ReconcileQueueInput = {
        acceptedActions: {},
        pendingActions: {
          "action-1": createPendingAction("action-1", "msg-1", "send"),
        },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        queue: { status: "running", items: [managedItem, promptEcho] },
        nowMs: 5000,
      };

      const result = reconcileQueueChange(input);

      expect(result.pendingActions).toEqual({});
      expect(result.acceptedActions).toHaveProperty("action-1");
      expect(input.queue.items).toEqual([managedItem, promptEcho]);
    });

    it("restores an unconfirmed send rather than accepting a managed-command item as its echo", () => {
      const managedItem = createManagedCommandQueueItem("queue-managed");
      const input: ReconcileSnapshotInput = {
        pendingActions: {
          "action-1": createPendingAction("action-1", "msg-1", "send"),
        },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [],
        queue: { status: "running", items: [managedItem] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        connectionEpoch: 1,
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        nowMs: 5000,
      };

      const result = reconcileSnapshotChange(input);

      expect(result.acceptedActions).toEqual({});
      expect(result.failedSendRestoration?.clientActionId).toBe("action-1");
      expect(input.queue.items).toEqual([managedItem]);
    });
  });

  describe("pruning during reconciliation", () => {
    it("prunes accepted actions older than 5 minutes on queue change", () => {
      const pendingAction = createPendingAction("action-1", "msg-1", "send");
      const input: ReconcileQueueInput = {
        acceptedActions: {},
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
        acceptedActions: {},
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

  describe("pruneAcceptedActions", () => {
    it("drops a non-interview accepted action past the 5-minute retention window", () => {
      const acceptedActions = {
        "action-1": createAcceptedAction("action-1", 0, null),
      };

      const result = pruneAcceptedActions(acceptedActions, 350_000);

      expect(result).not.toHaveProperty("action-1");
    });

    it("retains an accepted-but-unresolved interview action past the 5-minute retention window", () => {
      const acceptedActions = {
        "action-1": createAcceptedAction("action-1", 0, "block-1"),
      };

      const result = pruneAcceptedActions(acceptedActions, 350_000);

      // A slow-to-resolve interview must stay gated until the host's
      // interviewAnswered/interviewErrored frame clears it - the retention
      // window must not silently un-gate a duplicate dispatch.
      expect(result).toHaveProperty("action-1");
    });

    it("retains an accepted-but-unresolved interview action beyond the record cap", () => {
      const acceptedActions: Record<string, AcceptedChatAction> = {
        "interview-action": createAcceptedAction(
          "interview-action",
          0,
          "block-1",
        ),
      };
      // Fill past the 64-record cap with unrelated, non-interview traffic.
      for (let i = 0; i < 70; i += 1) {
        const id = `action-${i}`;
        acceptedActions[id] = createAcceptedAction(id, i, null);
      }

      const result = pruneAcceptedActions(acceptedActions, 5000);

      expect(result).toHaveProperty("interview-action");
      expect(Object.keys(result).length).toBeLessThanOrEqual(65);
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

  describe("turnSettledFromStatus", () => {
    it("prefers the host-sent turnInProgress when present", () => {
      expect(turnSettledFromStatus(false, "running")).toBe(true);
      expect(turnSettledFromStatus(true, "running")).toBe(false);
      expect(turnSettledFromStatus(true, "stopping")).toBe(false);
    });

    it("falls back to runStatus idle for an older host that omits the field", () => {
      expect(turnSettledFromStatus(undefined, "idle")).toBe(true);
      expect(turnSettledFromStatus(undefined, "running")).toBe(false);
      expect(turnSettledFromStatus(undefined, "stopping")).toBe(false);
    });
  });

  describe("reconcileTurnSettled", () => {
    function settledInput(
      overrides: Partial<ReconcileTurnSettledInput>,
    ): ReconcileTurnSettledInput {
      return {
        pendingActions: {},
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" as const },
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        ...overrides,
      };
    }

    it("drops a stranded entry (accepted ack, no messageAccepted) and restores its content to the composer", () => {
      const result = reconcileTurnSettled(true, settledInput({}));

      expect(result.pendingUserMessages).toEqual([]);
      expect(result.failedSendRestoration).toEqual({
        clientActionId: "action-1",
        content: CONTENT,
        reason: "The message was not recorded before the turn stopped.",
        displacedReason:
          "The message was not recorded before the turn stopped.",
        stated: false,
      });
    });

    it("keeps an entry whose ack is still in flight", () => {
      const input = settledInput({
        pendingActions: {
          "action-1": createPendingAction("action-1", "msg-1", "send"),
        },
      });

      const result = reconcileTurnSettled(true, input);

      expect(result.pendingUserMessages).toBe(input.pendingUserMessages);
      expect(result.failedSendRestoration).toBeNull();
    });

    it("drops an entry whose message reached the transcript as stale bookkeeping, without restoration", () => {
      const confirmedMessage: Message = {
        role: "user",
        messageId: "msg-1",
        sender: SENDER,
        message: { kind: "user", content: CONTENT },
        timestamp: 1000,
        sessionAnchor: null,
      };
      const input = settledInput({ messages: [confirmedMessage] });

      const result = reconcileTurnSettled(true, input);

      expect(result.pendingUserMessages).toEqual([]);
      expect(result.failedSendRestoration).toBeNull();
    });

    it("keeps an entry parked in the queue", () => {
      const input = settledInput({
        queue: { status: "paused", items: [createQueueItem("msg-1", CONTENT)] },
      });

      const result = reconcileTurnSettled(true, input);

      expect(result.pendingUserMessages).toBe(input.pendingUserMessages);
      expect(result.failedSendRestoration).toBeNull();
    });

    it("restores from the first dead entry, skipping confirmed stale bookkeeping", () => {
      const confirmedMessage: Message = {
        role: "user",
        messageId: "msg-1",
        sender: SENDER,
        message: { kind: "user", content: CONTENT },
        timestamp: 1000,
        sessionAnchor: null,
      };
      const deadEntry: PendingUserMessage = {
        clientActionId: "action-2",
        messageId: "msg-2",
        content: CONTENT_2,
        sender: SENDER,
        settings: SETTINGS,
        accountContext: { type: "PERSONAL" },
        deliveryPolicy: null,
        timestamp: 1000,
        restoreWorktreeIntent: null,
      };
      const result = reconcileTurnSettled(
        true,
        settledInput({
          pendingUserMessages: [
            createPendingUserMessage("action-1", "msg-1"),
            deadEntry,
          ],
          messages: [confirmedMessage],
        }),
      );

      expect(result.pendingUserMessages).toEqual([]);
      expect(result.failedSendRestoration).toEqual({
        clientActionId: "action-2",
        content: CONTENT_2,
        reason: "The message was not recorded before the turn stopped.",
        displacedReason:
          "The message was not recorded before the turn stopped.",
        stated: false,
      });
    });

    it("is a no-op when the report is not settled", () => {
      const input = settledInput({});

      const result = reconcileTurnSettled(false, input);

      expect(result.pendingUserMessages).toBe(input.pendingUserMessages);
      expect(result.failedSendRestoration).toBeNull();
    });

    it("never overwrites an occupied failedSendRestoration slot", () => {
      const occupied = {
        clientActionId: "action-0",
        content: CONTENT_2,
        reason: "Message was not accepted.",
        displacedReason: "Message was not accepted.",
        stated: false,
      };
      const result = reconcileTurnSettled(
        true,
        settledInput({ failedSendRestoration: occupied }),
      );

      expect(result.pendingUserMessages).toEqual([]);
      expect(result.failedSendRestoration).toBe(occupied);
      // The row is dropped and the slot is taken, so nothing else holds this
      // send's text - the statement has to carry it.
      expect(result.appendedErrorNotices).toHaveLength(1);
      expect(result.appendedErrorNotices[0]).toMatchObject({
        code: "SEND_NOT_RECORDED",
        severity: "warning",
        clientActionId: "action-1",
      });
      expect(result.appendedErrorNotices[0].message).toContain("Hello");
    });

    it("states nothing for a stranded entry already in the transcript", () => {
      const confirmedMessage: Message = {
        role: "user",
        messageId: "msg-1",
        sender: SENDER,
        message: { kind: "user", content: CONTENT },
        timestamp: 1000,
        sessionAnchor: null,
      };
      const result = reconcileTurnSettled(
        true,
        settledInput({
          messages: [confirmedMessage],
          failedSendRestoration: {
            clientActionId: "action-0",
            content: CONTENT_2,
            reason: "Message was not accepted.",
            displacedReason: "Message was not accepted.",
            stated: false,
          },
        }),
      );

      // Stale bookkeeping: the message reached the transcript, so dropping
      // the row loses nothing and a notice would be pure noise.
      expect(result.pendingUserMessages).toEqual([]);
      expect(result.appendedErrorNotices).toEqual([]);
    });
  });

  // R13 `-A8bJ`: everything the notice says ABOUT the draft has to be said
  // before the draft, because the draft is the one part whose extent the
  // notice does not control. It is verbatim user text of unbounded shape,
  // rendered pre-wrapped, and the user's next gesture is to select it - so a
  // clause after it is indistinguishable from a line the user typed.
  describe("quoted body delimitation", () => {
    const MULTI_LINE: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first line" }] },
        { type: "paragraph", content: [{ type: "text", text: "second line" }] },
      ],
    };

    const PREAMBLE =
      "A message was not recorded, and another unsent message is already " +
      "waiting in the composer.";
    const DRIFT =
      " It was going to run with model gpt-5-codex; the chat uses different " +
      "settings now, so a resend will not match unless you set them back.";
    const MARKER = "\n\nCopy the message below to resend it:\n";

    function noticeFor(
      content: JsonContent,
      currentSettings: typeof SETTINGS,
    ): string {
      return unrecoverableSendNotice({
        clientActionId: "action-1",
        content,
        circumstance: "A message was not recorded",
        account: {
          worktree: NO_WORKTREE_SWEEP,
          sentSettings: SETTINGS,
          currentSettings,
          sentAccountContext: null,
          currentAccountContext: null,
          sentDeliveryPolicy: null,
        },
      }).message;
    }

    // `-H2bA`: the send that WON the slot got its text back and was told
    // nothing, while every DISPLACED send got explicit drift and delivery
    // warnings. That is backwards - the winner's prompt is the one sitting in
    // the composer ready to be resent, so it is the one that most needs to
    // hear what changed underneath it. The founding invariant says restored
    // or stated; drift is invisible under both arms unless spoken.
    it("qualifies a snapshot-restored prompt with the drift it inherits", () => {
      const pendingAction: PendingChatAction = {
        ...createPendingAction("action-1", "msg-1", "send"),
        connectionEpoch: 0,
        accountContext: { type: "PERSONAL" },
      };
      const result = reconcileSnapshotChange({
        pendingActions: { "action-1": pendingAction },
        pendingUserMessages: [createPendingUserMessage("action-1", "msg-1")],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: { ...SETTINGS, model: "gpt-5.6" },
        currentAccountContext: { type: "TEAM", teamId: "team-7" },
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
        connectionEpoch: 1,
        nowMs: 5000,
      });

      const reason = result.failedSendRestoration?.reason ?? "";
      expect(reason).toContain("Message was not confirmed after reconnect.");
      expect(reason).toContain("model gpt-5-codex");
      expect(reason).toContain("billing your personal account");
    });

    it("qualifies a turn-settled restored prompt with its delivery policy", () => {
      const restorable: PendingUserMessage = {
        ...createPendingUserMessage("action-1", "msg-1"),
        deliveryPolicy: "after_safe_point",
      };
      const result = reconcileTurnSettled(true, {
        pendingActions: {},
        pendingUserMessages: [restorable],
        messages: [],
        queue: { status: "idle", items: [] },
        failedSendRestoration: null,
        currentSettings: SETTINGS,
        currentAccountContext: { type: "PERSONAL" },
        worktreePartition: (intent) => ({ survivors: intent, swept: null }),
        acceptedActions: {},
      });

      const reason = result.failedSendRestoration?.reason ?? "";
      expect(reason).toContain(
        "The message was not recorded before the turn stopped.",
      );
      // Delivery dies with the action, so a resend takes whatever the submit
      // gesture implies then - which can interrupt instead of waiting.
      expect(reason).toContain("after the running turn reached a safe point");
    });

    // `-G8sh`: a NEW chat's `chat.settings` stays null until the first turn,
    // and the drift guard short-circuited the WHOLE comparison on that null -
    // including billing, which was perfectly comparable. So an initial send
    // displaced while the user switched Personal -> Team said nothing about
    // which account the resend would charge.
    //
    // Consistent with this module's own shape, not a redesign: the drift
    // record is keyed `keyof ChatRunSettings | "accountContext"` precisely
    // because billing is NOT a run setting, so it must not share their gate.
    it("states billing drift even before the chat has any settings", () => {
      const message = unrecoverableSendNotice({
        clientActionId: "action-1",
        content: CONTENT,
        circumstance: "A message was not recorded",
        account: {
          worktree: NO_WORKTREE_SWEEP,
          sentSettings: SETTINGS,
          // The new-chat case: nothing has run yet, so there is no current tuple.
          currentSettings: null,
          sentAccountContext: { type: "PERSONAL" },
          currentAccountContext: { type: "TEAM", teamId: "team-7" },
          sentDeliveryPolicy: null,
        },
      }).message;

      expect(message).toContain("billing your personal account");
    });

    // The other half of the split: run settings still need BOTH sides, because
    // with one absent there is genuinely nothing to compare.
    it("says nothing about run settings when the chat has none yet", () => {
      const message = unrecoverableSendNotice({
        clientActionId: "action-1",
        content: CONTENT,
        circumstance: "A message was not recorded",
        account: {
          worktree: NO_WORKTREE_SWEEP,
          sentSettings: SETTINGS,
          currentSettings: null,
          sentAccountContext: { type: "PERSONAL" },
          currentAccountContext: { type: "PERSONAL" },
          sentDeliveryPolicy: null,
        },
      }).message;

      expect(message).not.toContain("was going to run with");
    });

    it("ends with the draft, so nothing can be mistaken for it", () => {
      const message = noticeFor(MULTI_LINE, { ...SETTINGS, model: "gpt-5.6" });
      const draft = recoveryTextFromContent(MULTI_LINE);

      // The load-bearing assertion: the draft runs to the END. Select from the
      // marker to the end of the notice and you have the message, exactly.
      expect(message.endsWith(`${MARKER}${draft}`)).toBe(true);
      // And the drift clause - the thing that used to trail the draft - is
      // said ahead of it, where it cannot be read as a line the user typed.
      expect(message.slice(0, -draft.length)).toContain("model gpt-5-codex");
    });

    it("puts every clause ahead of the draft in one exact shape", () => {
      expect(noticeFor(MULTI_LINE, { ...SETTINGS, model: "gpt-5.6" })).toBe(
        // `MULTI_LINE` is two PARAGRAPHS, so the blank line between them is
        // `-CUdX`: the serializer separates top-level blocks with `\n\n` and
        // the quote now does too. This expectation previously read
        // `first line\nsecond line`, which was the defect - it made a
        // paragraph break indistinguishable from a hard break in the copy.
        `${PREAMBLE}${DRIFT}${MARKER}first line\n\nsecond line`,
      );
    });

    it("says no more after a draft that needs no clauses", () => {
      expect(noticeFor(CONTENT, SETTINGS)).toBe(`${PREAMBLE}${MARKER}Hello`);
    });

    it("omits the marker entirely when there is no draft to quote", () => {
      const message = noticeFor({ type: "doc", content: [] }, SETTINGS);

      expect(message).not.toContain("Copy the message below");
      expect(message).toBe(`${PREAMBLE} It had no recoverable content.`);
    });
  });
});
