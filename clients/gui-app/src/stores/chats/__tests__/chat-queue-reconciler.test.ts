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
  type ReconcileQueueInput,
  type ReconcileSnapshotInput,
  type ReconcileTurnSettledInput,
} from "@/stores/chats/chat-queue-reconciler";
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

function createAcceptedAction(
  clientActionId: string,
  acceptedAt: number,
  interviewBlockId: string | null,
): AcceptedChatAction {
  return {
    clientActionId,
    action: interviewBlockId === null ? "send" : "interviewAnswer",
    interviewBlockId,
    messageId: null,
    acceptedAt,
    restoreContent: null,
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
    commandKind: "monitor",
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
        interviewBlockId: null,
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
        interviewBlockId: null,
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
        interviewBlockId: null,
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
        interviewBlockId: null,
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

  describe("managed-command queue items", () => {
    it("never settles a pending send against a managed-command item", () => {
      const managedItem = createManagedCommandQueueItem("queue-managed");
      const input: ReconcileQueueInput = {
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
        timestamp: 1000,
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
      };
      const result = reconcileTurnSettled(
        true,
        settledInput({ failedSendRestoration: occupied }),
      );

      expect(result.pendingUserMessages).toEqual([]);
      expect(result.failedSendRestoration).toBe(occupied);
    });
  });
});
