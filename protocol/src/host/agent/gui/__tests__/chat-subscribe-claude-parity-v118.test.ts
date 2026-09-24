import { describe, expect, it } from "vitest";
import {
  chatSubscribeV116,
  chatSubscribeV118,
  chatThinkingTokensEstimateSchema,
  backgroundItemSchema,
  backgroundItemKindSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { runtimeApprovalRequestSchema } from "@traycer/protocol/host/agent/gui/agent-runtime";

/**
 * `chat.subscribe@1.18`: the Claude-parity surfaces. Every addition is
 * accepted by the live line; the frozen `1.16` line rejects the two closed
 * unions it cannot carry (the `thinkingTokens` frame, a `cron` background
 * item) and strips the optional keys it never declared.
 */

const FACTS = [{ label: "Path", value: "/tmp/a" }] as const;

const CRON_ITEM = {
  taskId: "cron-1",
  title: "Every 5 minutes",
  blockId: "block-cron-1",
  parentTaskId: null,
  kind: "cron",
  schedule: "*/5 * * * *",
  humanSchedule: "Every 5 minutes",
  prompt: "check the deploy",
  recurring: true,
} as const;

const COMMAND_ITEM = {
  taskId: "task-1",
  title: "npm test",
  blockId: "block-1",
  parentTaskId: null,
  kind: "command",
  status: "running",
} as const;

function approval(withFacts: boolean): Record<string, unknown> {
  return {
    approvalId: "approval-1",
    toolName: "bash",
    description: "Run a command",
    input: null,
    requestedAt: 1_000,
    ...(withFacts ? { displayFacts: FACTS, cautious: true } : {}),
  };
}

function windowedSnapshot(): Record<string, unknown> {
  return {
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
    pendingApprovals: [approval(true)],
    pendingInterviews: [],
    worktreeBinding: null,
    missingWorktreePaths: [],
    pendingFileEditApprovals: [],
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
    suggestedPrompt: "Run the tests",
    thinkingTokensEstimate: 1234,
    backgroundItems: [COMMAND_ITEM, CRON_ITEM],
  };
}

function snapshotFrame(snapshot: Record<string, unknown>): unknown {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot,
  };
}

function turnStateFrame(
  backgroundItems: readonly unknown[],
  withSuggestion: boolean,
): unknown {
  return {
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    runStatus: "running",
    activeTurn: null,
    backgroundItems,
    ...(withSuggestion ? { suggestedPrompt: "Run the tests" } : {}),
  };
}

const THINKING_FRAME = {
  kind: "thinkingTokens",
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
  turnId: "turn-1",
  estimate: 42,
} as const;

const APPROVAL_REQUESTED_FRAME = {
  kind: "approvalRequested",
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
  approval: approval(true),
} as const;

const BLOCK_DELTA_FRAME = {
  kind: "blockDelta",
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
  event: {
    type: "approval.requested",
    blockId: "block-1",
    timestamp: 1_000,
    toolName: "bash",
    description: "Run a command",
    displayFacts: FACTS,
    cautious: true,
    ruleForced: true,
  },
} as const;

describe("chat.subscribe@1.18 accepts every Claude-parity addition", () => {
  const live = chatSubscribeV118.serverFrameSchema;

  it("windowed snapshot: suggestedPrompt, thinkingTokensEstimate, cron item, card facts", () => {
    const parsed = live.parse(snapshotFrame(windowedSnapshot()));
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.suggestedPrompt).toBe("Run the tests");
    expect(parsed.snapshot.thinkingTokensEstimate).toBe(1234);
    expect(parsed.snapshot.backgroundItems?.map((i) => i.kind)).toEqual([
      "command",
      "cron",
    ]);
    const [card] = parsed.snapshot.pendingApprovals;
    expect(card?.displayFacts).toEqual(FACTS);
    expect(card?.cautious).toBe(true);
  });

  it("turnStateChanged: suggestedPrompt and a cron item", () => {
    const parsed = live.parse(turnStateFrame([COMMAND_ITEM, CRON_ITEM], true));
    if (parsed.kind !== "turnStateChanged") throw new Error("wrong kind");
    expect(parsed.suggestedPrompt).toBe("Run the tests");
    expect(parsed.backgroundItems?.map((i) => i.kind)).toEqual([
      "command",
      "cron",
    ]);
  });

  it("thinkingTokens frame", () => {
    const parsed = live.parse(THINKING_FRAME);
    if (parsed.kind !== "thinkingTokens") throw new Error("wrong kind");
    expect(parsed.estimate).toBe(42);
    expect(parsed.turnId).toBe("turn-1");
  });

  it("approvalRequested with displayFacts and cautious", () => {
    const parsed = live.parse(APPROVAL_REQUESTED_FRAME);
    if (parsed.kind !== "approvalRequested") throw new Error("wrong kind");
    expect(parsed.approval.displayFacts).toEqual(FACTS);
    expect(parsed.approval.cautious).toBe(true);
  });

  it("blockDelta approval.requested with displayFacts, cautious and ruleForced", () => {
    const parsed = live.parse(BLOCK_DELTA_FRAME);
    if (parsed.kind !== "blockDelta") throw new Error("wrong kind");
    expect(parsed.event).toMatchObject({
      type: "approval.requested",
      displayFacts: FACTS,
      cautious: true,
      ruleForced: true,
    });
  });
});

describe("chat.subscribe@1.16 (frozen) cannot carry the additions", () => {
  const frozen = chatSubscribeV116.serverFrameSchema;

  it("rejects the thinkingTokens frame (closed union)", () => {
    expect(frozen.safeParse(THINKING_FRAME).success).toBe(false);
  });

  it("rejects a cron item on turnStateChanged, and accepts the same frame without it", () => {
    expect(
      frozen.safeParse(turnStateFrame([COMMAND_ITEM, CRON_ITEM], false))
        .success,
    ).toBe(false);
    expect(
      frozen.safeParse(turnStateFrame([COMMAND_ITEM], false)).success,
    ).toBe(true);
  });

  it("rejects a windowed snapshot carrying a cron item, and accepts it without", () => {
    expect(frozen.safeParse(snapshotFrame(windowedSnapshot())).success).toBe(
      false,
    );
    expect(
      frozen.safeParse(
        snapshotFrame({
          ...windowedSnapshot(),
          backgroundItems: [COMMAND_ITEM],
        }),
      ).success,
    ).toBe(true);
  });

  it("strips the optional keys it never declared from the snapshot", () => {
    const parsed = frozen.parse(
      snapshotFrame({
        ...windowedSnapshot(),
        backgroundItems: [COMMAND_ITEM],
      }),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(Object.hasOwn(parsed.snapshot, "suggestedPrompt")).toBe(false);
    expect(Object.hasOwn(parsed.snapshot, "thinkingTokensEstimate")).toBe(
      false,
    );
    const [card] = parsed.snapshot.pendingApprovals;
    if (card === undefined) throw new Error("expected a card");
    expect(Object.hasOwn(card, "displayFacts")).toBe(false);
    expect(Object.hasOwn(card, "cautious")).toBe(false);
  });

  it("strips suggestedPrompt from turnStateChanged", () => {
    const parsed = frozen.parse(turnStateFrame([COMMAND_ITEM], true));
    expect(Object.hasOwn(parsed, "suggestedPrompt")).toBe(false);
  });

  it("strips displayFacts / cautious from approvalRequested", () => {
    const parsed = frozen.parse(APPROVAL_REQUESTED_FRAME);
    if (parsed.kind !== "approvalRequested") throw new Error("wrong kind");
    expect(Object.hasOwn(parsed.approval, "displayFacts")).toBe(false);
    expect(Object.hasOwn(parsed.approval, "cautious")).toBe(false);
  });

  it("strips displayFacts / cautious / ruleForced from a blockDelta approval.requested", () => {
    const parsed = frozen.parse(BLOCK_DELTA_FRAME);
    if (parsed.kind !== "blockDelta") throw new Error("wrong kind");
    expect(parsed.event.type).toBe("approval.requested");
    expect(Object.hasOwn(parsed.event, "displayFacts")).toBe(false);
    expect(Object.hasOwn(parsed.event, "cautious")).toBe(false);
    expect(Object.hasOwn(parsed.event, "ruleForced")).toBe(false);
  });
});

describe("the cron background item", () => {
  it("is a member of backgroundItemKindSchema", () => {
    expect(backgroundItemKindSchema.options).toContain("cron");
  });

  it("parses without scheduledFor, and does not carry one", () => {
    const parsed = backgroundItemSchema.parse(CRON_ITEM);
    expect(parsed.kind).toBe("cron");
    expect(Object.hasOwn(parsed, "scheduledFor")).toBe(false);
  });

  it.each(["schedule", "humanSchedule", "prompt", "recurring"] as const)(
    "requires %s",
    (field) => {
      const rest = Object.fromEntries(
        Object.entries(CRON_ITEM).filter(([key]) => key !== field),
      );
      expect(backgroundItemSchema.safeParse(rest).success).toBe(false);
    },
  );
});

describe("thinkingTokens estimate", () => {
  it("rejects a negative estimate and a non-integer, accepts zero", () => {
    expect(
      chatSubscribeV118.serverFrameSchema.safeParse({
        ...THINKING_FRAME,
        estimate: -1,
      }).success,
    ).toBe(false);
    expect(
      chatSubscribeV118.serverFrameSchema.safeParse({
        ...THINKING_FRAME,
        estimate: 1.5,
      }).success,
    ).toBe(false);
    expect(
      chatSubscribeV118.serverFrameSchema.safeParse({
        ...THINKING_FRAME,
        estimate: 0,
      }).success,
    ).toBe(true);
    expect(chatThinkingTokensEstimateSchema.safeParse(-1).success).toBe(false);
    expect(chatThinkingTokensEstimateSchema.safeParse(2.5).success).toBe(false);
  });
});

describe("runtimeApprovalRequestSchema", () => {
  it("accepts displayFacts and cautious, and both stay optional", () => {
    const base = {
      approvalId: "approval-1",
      toolName: "bash",
      description: "Run a command",
    };
    const parsed = runtimeApprovalRequestSchema.parse({
      ...base,
      displayFacts: FACTS,
      cautious: true,
    });
    expect(parsed.displayFacts).toEqual(FACTS);
    expect(parsed.cautious).toBe(true);
    expect(runtimeApprovalRequestSchema.safeParse(base).success).toBe(true);
    expect(
      runtimeApprovalRequestSchema.safeParse({
        ...base,
        displayFacts: [{ label: "x" }],
      }).success,
    ).toBe(false);
  });
});
