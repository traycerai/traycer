import { describe, expect, it } from "vitest";
import {
  chatSubscribeV116,
  chatSubscribeV117,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.17`: the file-edit approval card carries `cautious` and
 * `displayFacts`, as the command card does on the same line - an edit a user's
 * ask rule forced to a person must not be approvable by "Approve all". The
 * frozen `1.16` line never declared either key and strips both, on the frame
 * and on the snapshot.
 */

const RULE_FACT = [
  {
    label: "Rule",
    value: "An ask rule in project settings requires a person to approve this",
  },
] as const;

function fileEditCard(cautious: boolean): Record<string, unknown> {
  return {
    approvalId: "toolu_1:file-edit",
    toolName: "Edit",
    description: "Claude wants to use Edit",
    paths: ["/tmp/project/src/app.ts"],
    operation: "edit",
    input: { file_path: "/tmp/project/src/app.ts" },
    requestedAt: 1_000,
    ...(cautious ? { cautious: true, displayFacts: RULE_FACT } : {}),
  };
}

function fileEditRequestedFrame(cautious: boolean): unknown {
  return {
    kind: "fileEditApprovalRequested",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    approval: fileEditCard(cautious),
  };
}

function snapshotFrame(cautious: boolean): unknown {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat: {
        parentId: null,
        userId: "owner-1",
        id: "chat-1",
        hostId: "host-1",
        title: "Chat",
        createdAt: 1_000,
        updatedAt: 1_000,
        isTitleEditedByUser: false,
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [fileEditCard(cautious)],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      transcriptEpoch: 0,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, rowIds: [], messages: [], events: [] },
      derived: {
        latestAssistantUsage: null,
        pinnedTodo: null,
        pinnedTaskTodoItems: [],
        latestForkableAssistantMessageId: null,
        restorableSetupInterruption: null,
        interviewAnswerability: [],
        latestAssistantAuthFailureTurnKey: null,
        setupCardWindows: [],
      },
    },
  };
}

describe("chat.subscribe@1.17 carries cautious and displayFacts on the file-edit card", () => {
  const live = chatSubscribeV117.serverFrameSchema;

  it("fileEditApprovalRequested keeps both keys", () => {
    const parsed = live.parse(fileEditRequestedFrame(true));
    if (parsed.kind !== "fileEditApprovalRequested") {
      throw new Error("wrong kind");
    }
    expect(parsed.approval.cautious).toBe(true);
    expect(parsed.approval.displayFacts).toEqual(RULE_FACT);
  });

  it("the snapshot's pendingFileEditApprovals keeps both keys", () => {
    const parsed = live.parse(snapshotFrame(true));
    if (parsed.kind !== "snapshot") throw new Error("wrong kind");
    const [card] = parsed.snapshot.pendingFileEditApprovals;
    expect(card?.cautious).toBe(true);
    expect(card?.displayFacts).toEqual(RULE_FACT);
  });

  it("a card without them stays without them", () => {
    const parsed = live.parse(fileEditRequestedFrame(false));
    if (parsed.kind !== "fileEditApprovalRequested") {
      throw new Error("wrong kind");
    }
    expect(Object.hasOwn(parsed.approval, "cautious")).toBe(false);
    expect(Object.hasOwn(parsed.approval, "displayFacts")).toBe(false);
  });
});

describe("chat.subscribe@1.16 (frozen) never declared them", () => {
  const frozen = chatSubscribeV116.serverFrameSchema;

  it("strips both from fileEditApprovalRequested", () => {
    const parsed = frozen.parse(fileEditRequestedFrame(true));
    if (parsed.kind !== "fileEditApprovalRequested") {
      throw new Error("wrong kind");
    }
    expect(Object.hasOwn(parsed.approval, "cautious")).toBe(false);
    expect(Object.hasOwn(parsed.approval, "displayFacts")).toBe(false);
  });

  it("strips both from the snapshot's pendingFileEditApprovals", () => {
    const parsed = frozen.parse(snapshotFrame(true));
    if (parsed.kind !== "snapshot") throw new Error("wrong kind");
    const [card] = parsed.snapshot.pendingFileEditApprovals;
    if (card === undefined) throw new Error("expected the card");
    expect(Object.hasOwn(card, "cautious")).toBe(false);
    expect(Object.hasOwn(card, "displayFacts")).toBe(false);
  });
});
