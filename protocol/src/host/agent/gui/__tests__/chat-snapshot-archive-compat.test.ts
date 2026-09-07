import { describe, expect, it } from "vitest";
import { chatSnapshotSchema } from "../subscribe";

/**
 * `archivedAt` snapshot-propagation guard: the LIVE `chat.subscribe@1.4` snapshot carries the chat's `archivedAt` (it embeds the live `chatSchema` directly), while the frozen `chatSchemaPreInReplyTo` copy bound to.
 */

function baseChat() {
  return {
    parentId: null,
    id: "chat-1",
    userId: "user-1",
    hostId: "host-1",
    title: "Chat",
    createdAt: 1000,
    updatedAt: 1000,
    isTitleEditedByUser: false,
    messages: [],
  };
}

function baseSnapshot() {
  return {
    chat: baseChat(),
    access: { role: "owner" as const, ownerUserId: "user-1", canAct: true },
    queue: { status: "idle" as const, items: [] },
    runStatus: "idle" as const,
    activeTurn: null,
    pendingApprovals: [],
    pendingInterviews: [],
    worktreeBinding: null,
    missingWorktreePaths: [],
    pendingFileEditApprovals: [],
    accumulatedFileChanges: [],
  };
}

describe("chatSnapshotSchema propagates archivedAt on the live wire", () => {
  it("retains archivedAt on the embedded chat when present", () => {
    const parsed = chatSnapshotSchema.parse({
      ...baseSnapshot(),
      chat: { ...baseChat(), archivedAt: 4242 },
    });
    expect(parsed.chat.archivedAt).toBe(4242);
  });

  it("defaults the embedded chat's archivedAt to null when absent", () => {
    const parsed = chatSnapshotSchema.parse(baseSnapshot());
    expect(parsed.chat.archivedAt).toBeNull();
  });
});
