import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedManagedCommandItem,
  ChatQueuedPromptItem,
  ChatQueueState,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  appendOptimisticQueuedItem,
  mergeQueueWithOptimisticQueuedItems,
  optimisticQueuedItemId,
  removeOptimisticQueuedItemByClientActionId,
  removeOptimisticQueuedItemByMessageId,
} from "@/stores/chats/optimistic-queue";
import { queuePausedAfterError } from "@/components/chat/chat-queue-utils";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const SENDER = { type: "user" as const, userId: "user-1" };

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

describe("optimistic-queue managed-command items", () => {
  it("drops a host-authored managed-command item that the authoritative snapshot no longer carries", () => {
    const current: ChatQueueState = {
      status: "running",
      items: [managedCommandItem("queue-managed")],
    };
    const authoritative: ChatQueueState = { status: "running", items: [] };

    const merged = mergeQueueWithOptimisticQueuedItems(
      authoritative,
      current,
      new Set(["action-1"]),
    );

    expect(merged).toBe(authoritative);
  });

  it("never retains a managed-command item as an optimistic local send", () => {
    // The chip is given an optimistic-shaped id and a retained action id so
    // every check downstream of the kind narrowing would wave it through - the
    // host authors these ids, so this state is unreachable in practice and the
    // kind check is the only thing that keeps it that way.
    const clientActionId = "action-1";
    const current: ChatQueueState = {
      status: "running",
      items: [managedCommandItem(optimisticQueuedItemId(clientActionId))],
    };
    const authoritative: ChatQueueState = { status: "running", items: [] };

    const merged = mergeQueueWithOptimisticQueuedItems(
      authoritative,
      current,
      new Set([clientActionId]),
    );

    expect(merged.items).toEqual([]);
  });

  it("appends an optimistic send even when a managed-command item is already queued", () => {
    const managed = managedCommandItem("queue-managed");
    const queue: ChatQueueState = { status: "running", items: [managed] };
    const send = optimisticPromptItem("action-1");

    const next = appendOptimisticQueuedItem(queue, send);

    // A content-free chip can never be the host's echo of this send, so the
    // optimistic row must still be appended.
    expect(next.items).toEqual([managed, send]);
  });
});

// Every rebuild in this module must SPREAD the queue it starts from:
// `pausedReason` is an optional key, so a copy that names its fields compiles
// and quietly drops it - and with it the "Paused after an error" pill.
describe("optimistic-queue keeps the queue's pausedReason", () => {
  const pausedReason = "turn_error";

  it("appendOptimisticQueuedItem keeps it on the queue it appends to", () => {
    const queue: ChatQueueState = {
      status: "paused",
      items: [managedCommandItem("queue-managed")],
      pausedReason,
    };

    const next = appendOptimisticQueuedItem(queue, optimisticPromptItem("a-1"));

    expect(next.items).toHaveLength(2);
    expect(next.pausedReason).toBe(pausedReason);
  });

  it("mergeQueueWithOptimisticQueuedItems keeps the AUTHORITATIVE queue's reason, not the stale current one", () => {
    const send = optimisticPromptItem("a-1");
    const current: ChatQueueState = {
      status: "running",
      items: [send],
      pausedReason: null,
    };
    const authoritative: ChatQueueState = {
      status: "paused",
      items: [],
      pausedReason,
    };

    const merged = mergeQueueWithOptimisticQueuedItems(
      authoritative,
      current,
      new Set(["a-1"]),
    );

    expect(merged.items).toEqual([send]);
    expect(merged.status).toBe("paused");
    expect(merged.pausedReason).toBe(pausedReason);
  });

  it("removing an optimistic item by client action id or message id keeps it", () => {
    const send = optimisticPromptItem("a-1");
    const queue: ChatQueueState = {
      status: "paused",
      items: [managedCommandItem("queue-managed"), send],
      pausedReason,
    };

    const byAction = removeOptimisticQueuedItemByClientActionId(queue, "a-1");
    const byMessage = removeOptimisticQueuedItemByMessageId(
      queue,
      send.messageId,
    );

    for (const next of [byAction, byMessage]) {
      expect(next.items).toHaveLength(1);
      expect(next.pausedReason).toBe(pausedReason);
    }
  });
});

// A queue's `pausedReason` only means something while the queue is paused.
// Every rebuild that can change the status must clear a carried reason when it
// leaves `paused`, or the "Paused after an error" pill outlives the pause.
describe("optimistic-queue clears pausedReason when it leaves paused", () => {
  it.each([
    ["by client action id", removeOptimisticQueuedItemByClientActionId],
    [
      "by message id",
      (queue: ChatQueueState) =>
        removeOptimisticQueuedItemByMessageId(queue, "a-1-message"),
    ],
  ] as const)(
    "removing the only item %s from a turn_error queue makes it idle with no reason",
    (_name, remove) => {
      const queue: ChatQueueState = {
        status: "paused",
        items: [optimisticPromptItem("a-1")],
        pausedReason: "turn_error",
      };

      const result = remove(queue, "a-1");

      expect(result.items).toEqual([]);
      expect(result.status).toBe("idle");
      expect(result.pausedReason).toBeNull();
      expect(queuePausedAfterError(result)).toBe(false);
    },
  );

  it("removing an optimistic item leaves the queue paused, with its reason, when a host item remains", () => {
    const queue: ChatQueueState = {
      status: "paused",
      items: [managedCommandItem("queue-managed"), optimisticPromptItem("a-1")],
      pausedReason: "turn_error",
    };

    const result = removeOptimisticQueuedItemByClientActionId(queue, "a-1");

    expect(result.status).toBe("paused");
    expect(result.pausedReason).toBe("turn_error");
    expect(queuePausedAfterError(result)).toBe(true);
  });

  it("appending to an idle queue with a stale reason makes it running with no reason", () => {
    const queue: ChatQueueState = {
      status: "idle",
      items: [],
      pausedReason: "routing",
    };

    const result = appendOptimisticQueuedItem(
      queue,
      optimisticPromptItem("a-1"),
    );

    expect(result.status).toBe("running");
    expect(result.pausedReason).toBeNull();
  });

  it("appending to a paused queue keeps it paused with its reason", () => {
    const queue: ChatQueueState = {
      status: "paused",
      items: [managedCommandItem("queue-managed")],
      pausedReason: "turn_error",
    };

    const result = appendOptimisticQueuedItem(
      queue,
      optimisticPromptItem("a-1"),
    );

    expect(result.status).toBe("paused");
    expect(result.pausedReason).toBe("turn_error");
  });

  it("merging a running authoritative queue with a stale reason and a retained item gives running with no reason", () => {
    const current: ChatQueueState = {
      status: "running",
      items: [optimisticPromptItem("a-1")],
    };
    const authoritative: ChatQueueState = {
      status: "running",
      items: [],
      pausedReason: "turn_error",
    };

    const merged = mergeQueueWithOptimisticQueuedItems(
      authoritative,
      current,
      new Set(["a-1"]),
    );

    expect(merged.items).toHaveLength(1);
    expect(merged.status).toBe("running");
    expect(merged.pausedReason).toBeNull();
  });

  it("merging a paused authoritative queue keeps it paused with its reason", () => {
    const current: ChatQueueState = {
      status: "running",
      items: [optimisticPromptItem("a-1")],
    };
    const authoritative: ChatQueueState = {
      status: "paused",
      items: [],
      pausedReason: "turn_error",
    };

    const merged = mergeQueueWithOptimisticQueuedItems(
      authoritative,
      current,
      new Set(["a-1"]),
    );

    expect(merged.status).toBe("paused");
    expect(merged.pausedReason).toBe("turn_error");
  });

  it("leaves a queue with NO pausedReason key without one through a status-changing rebuild (an older host)", () => {
    const idle: ChatQueueState = { status: "idle", items: [] };
    const appended = appendOptimisticQueuedItem(
      idle,
      optimisticPromptItem("a-1"),
    );
    const removed = removeOptimisticQueuedItemByClientActionId(
      { status: "running", items: [optimisticPromptItem("a-2")] },
      "a-2",
    );
    const merged = mergeQueueWithOptimisticQueuedItems(
      { status: "idle", items: [] },
      { status: "running", items: [optimisticPromptItem("a-3")] },
      new Set(["a-3"]),
    );

    expect(appended.status).toBe("running");
    expect(removed.status).toBe("idle");
    expect(merged.status).toBe("running");
    for (const result of [appended, removed, merged]) {
      expect(Object.hasOwn(result, "pausedReason")).toBe(false);
    }
  });
});

function managedCommandItem(queueItemId: string): ChatQueuedManagedCommandItem {
  return {
    kind: "managed-command",
    queueItemId,
    commandId: `${queueItemId}-command`,
    hostId: null,
    description: "bun test --watch",
    monitoring: true,
    delivery: "next_turn",
    targetTurnId: null,
    status: "pending",
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function optimisticPromptItem(clientActionId: string): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: optimisticQueuedItemId(clientActionId),
    messageId: `${clientActionId}-message`,
    message: {
      kind: "user",
      content: CONTENT,
      browserAnnotations: [],
    },
    sender: SENDER,
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}
