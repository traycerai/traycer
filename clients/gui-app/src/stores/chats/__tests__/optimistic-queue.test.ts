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
} from "@/stores/chats/optimistic-queue";

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

function managedCommandItem(queueItemId: string): ChatQueuedManagedCommandItem {
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

function optimisticPromptItem(clientActionId: string): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: optimisticQueuedItemId(clientActionId),
    messageId: `${clientActionId}-message`,
    message: { kind: "user", content: CONTENT },
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
