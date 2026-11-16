import { describe, expect, it } from "vitest";
import { chatSubscribeV144, chatSubscribeV145 } from "../subscribe";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";

const settings = (harnessId: string) => ({
  harnessId, model: "model-1", permissionMode: "supervised", reasoningEffort: null, agentMode: "regular",
});
const frame = (harnessId: string) => ({
  kind: "snapshot", hasBinaryPayload: false, epicId: "epic-1", chatId: "chat-1",
  snapshot: {
    chat: { parentId: null, id: "chat-1", userId: "user-1", hostId: "host-1", title: "Chat", createdAt: 1000, updatedAt: 1000, isTitleEditedByUser: false, settings: settings(harnessId) },
    access: { role: "owner", ownerUserId: "user-1", canAct: true },
    queue: { status: "idle", items: [] }, runStatus: "running",
    activeTurn: { turnId: "turn-1", status: "running", harnessId, model: "model-1", userMessageId: null, startedAt: 1000, updatedAt: 1000 },
    pendingApprovals: [], pendingInterviews: [], worktreeBinding: null, missingWorktreePaths: [], pendingFileEditApprovals: [], accumulatedFileChangeCount: 0, transcriptEpoch: 0, rowCount: 0, indexRevision: null,
    tail: { fromOrdinal: 0, messages: [], events: [] },
    derived: { latestAssistantUsage: null, pinnedTodo: null, pinnedTaskTodoItems: [], latestForkableAssistantMessageId: null, restorableSetupInterruption: null, interviewAnswerability: [], latestAssistantAuthFailureTurnKey: null, setupCardWindows: [] },
  },
});

describe("chat.subscribe Muse line", () => {
  it("registers 1.45 and preserves existing snapshots", () => {
    expect(hostStreamRpcRegistry["chat.subscribe"][1].latestMinor).toBe(45);
    const old = chatSubscribeV144.serverFrameSchema.parse(frame("claude"));
    expect(chatSubscribeV145.serverFrameSchema.parse(frame("claude"))).toEqual(old);
  });
  it("carries Muse settings and active turn only on 1.45", () => {
    expect(chatSubscribeV144.serverFrameSchema.safeParse(frame("muse")).success).toBe(false);
    const parsed = chatSubscribeV145.serverFrameSchema.parse(frame("muse"));
    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") {
      expect(parsed.snapshot.chat.settings?.harnessId).toBe("muse");
      expect(parsed.snapshot.activeTurn?.harnessId).toBe("muse");
    }
  });
  it("delivers Muse session anchors in runtime events", () => {
    const event = { kind: "blockDelta", hasBinaryPayload: false, epicId: "epic-1", chatId: "chat-1", event: { blockId: "block-1", timestamp: 1000, type: "user_message.anchor_resolved", messageId: "message-1", anchor: { harnessId: "muse", sessionId: "session-1" } } };
    expect(chatSubscribeV144.serverFrameSchema.safeParse(event).success).toBe(false);
    expect(chatSubscribeV145.serverFrameSchema.parse(event)).toMatchObject(event);
  });
});
