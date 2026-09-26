import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  chatSubscribeV117,
  chatSubscribeV118,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  providerNoticeMetadataSchema,
  providerNoticeMetadataSchemaPreReceipt,
  providerNoticeReceiptStepSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * `chat.subscribe@1.18`: `receipt` on a provider notice and `pausedReason` on
 * the queue state. Both are `.nullable().optional()` keys: ABSENT parses to
 * `undefined`, `null` and a value round-trip. Every line below 1.18 binds a
 * frozen schema that STRIPS them (projection, not tolerance), so a frame
 * carrying them parses on those lines with the keys gone and all else intact.
 */

const RECEIPT = {
  causeLabel: "Rate limited",
  steps: [
    {
      kind: "switch" as const,
      providerLabel: "Codex",
      modelLabel: "gpt-5.4",
      profileLabel: "Personal",
      resumedAt: null,
      endedLabel: "Ended 12:04",
    },
    {
      kind: "wait" as const,
      providerLabel: "Claude",
      modelLabel: "Sonnet",
      profileLabel: "Work",
      resumedAt: 1234,
      endedLabel: "Resumed 12:30",
    },
  ],
};

function notice(receipt: { present: boolean; value: unknown }) {
  const base = {
    harnessId: "claude",
    noticeKind: "fallback_settled" as const,
    tone: "info" as const,
    title: "Settled",
    message: null,
    details: [],
    metadata: null,
  };
  return receipt.present ? { ...base, receipt: receipt.value } : base;
}

function assistantRow(providerNotice: unknown): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: "Coder",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        blockId: "block-1",
        status: "completed",
        timestamp: 1,
        type: "text",
        text: "hi",
        providerNotice,
      },
    ],
    startedAt: 1,
    timestamp: 2,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function queue(pausedReason: { present: boolean; value: unknown }) {
  const base = { status: "paused" as const, items: [] };
  return pausedReason.present
    ? { ...base, pausedReason: pausedReason.value }
    : base;
}

function snapshotFrame(
  message: Record<string, unknown>,
  queueState: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat: {
        parentId: null,
        id: "chat-1",
        userId: "user-1",
        hostId: "host-1",
        title: "Chat",
        createdAt: 1000,
        updatedAt: 1000,
        isTitleEditedByUser: false,
      },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: queueState,
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      transcriptEpoch: 0,
      rowCount: 1,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [message], events: [] },
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

function rangeFrame(message: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "range",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    range: {
      requestId: "range-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: ["assistant-1"],
      messages: [message],
      events: [],
      reachedStart: true,
      reachedEnd: true,
    },
  };
}

function queueChangedFrame(
  queueState: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    queue: queueState,
  };
}

/** The first block's providerNotice of a parsed snapshot tail / range row. */
function noticeOf(message: unknown): Record<string, unknown> {
  const parsed = z
    .object({
      blocks: z.array(
        z.object({ providerNotice: z.record(z.string(), z.unknown()) }),
      ),
    })
    .safeParse(message);
  if (!parsed.success)
    throw new Error("expected an assistant row with a notice");
  const first = parsed.data.blocks[0];
  if (first === undefined) throw new Error("expected a block");
  return first.providerNotice;
}

type HeadFrame = z.infer<typeof chatSubscribeV118.serverFrameSchema>;

function parseAtHead(frame: Record<string, unknown>): HeadFrame {
  const result = chatSubscribeV118.serverFrameSchema.safeParse(frame);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

function snapshotParts(data: HeadFrame) {
  if (data.kind !== "snapshot") throw new Error("expected snapshot");
  return {
    message: data.snapshot.tail.messages[0],
    queue: data.snapshot.queue,
  };
}

function rangeMessage(data: HeadFrame) {
  if (data.kind !== "range") throw new Error("expected range");
  return data.range.messages[0];
}

function queueOf(data: HeadFrame) {
  if (data.kind !== "queueChanged") throw new Error("expected queueChanged");
  return data.queue;
}

describe("chat.subscribe@1.18 receipt on a notice", () => {
  const cases = [
    { name: "absent", input: { present: false, value: undefined } },
    { name: "null", input: { present: true, value: null } },
    { name: "a value", input: { present: true, value: RECEIPT } },
  ] as const;

  for (const { name, input } of cases) {
    it(`snapshot tail: receipt ${name} round-trips`, () => {
      const { message } = snapshotParts(
        parseAtHead(
          snapshotFrame(
            assistantRow(notice(input)),
            queue({ present: false, value: undefined }),
          ),
        ),
      );
      const parsedNotice = noticeOf(message);
      if (!input.present) {
        expect(parsedNotice.receipt).toBeUndefined();
      } else {
        expect(parsedNotice.receipt).toEqual(input.value);
      }
    });

    it(`range frame: receipt ${name} round-trips`, () => {
      const parsedNotice = noticeOf(
        rangeMessage(parseAtHead(rangeFrame(assistantRow(notice(input))))),
      );
      if (!input.present) {
        expect(parsedNotice.receipt).toBeUndefined();
      } else {
        expect(parsedNotice.receipt).toEqual(input.value);
      }
    });
  }
});

describe("chat.subscribe@1.18 pausedReason on the queue", () => {
  const cases = [
    { name: "absent", input: { present: false, value: undefined } },
    { name: "null", input: { present: true, value: null } },
    { name: "a value", input: { present: true, value: "turn_error" } },
  ] as const;
  const plainRow = assistantRow(null);

  for (const { name, input } of cases) {
    it(`snapshot queue: pausedReason ${name} round-trips`, () => {
      const { queue: parsed } = snapshotParts(
        parseAtHead(snapshotFrame(plainRow, queue(input))),
      );
      if (!input.present) {
        expect(parsed.pausedReason).toBeUndefined();
      } else {
        expect(parsed.pausedReason).toBe(input.value);
      }
    });

    it(`queueChanged frame: pausedReason ${name} round-trips`, () => {
      const parsed = queueOf(parseAtHead(queueChangedFrame(queue(input))));
      if (!input.present) {
        expect(parsed.pausedReason).toBeUndefined();
      } else {
        expect(parsed.pausedReason).toBe(input.value);
      }
    });
  }
});

/**
 * Reads a frame an older line already parsed. The registry erases each line's
 * frame type, so this names the three shapes the projection tests inspect -
 * WITHOUT stripping: the queue is a record and a message stays `unknown`, so a
 * `receipt` / `pausedReason` the older line failed to drop is still here for
 * the `not.toHaveProperty` assertions to catch.
 */
const olderLineFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    snapshot: z.object({
      queue: z.record(z.string(), z.unknown()),
      tail: z.object({ messages: z.array(z.unknown()) }),
    }),
  }),
  z.object({
    kind: z.literal("range"),
    range: z.object({ messages: z.array(z.unknown()) }),
  }),
  z.object({
    kind: z.literal("queueChanged"),
    queue: z.record(z.string(), z.unknown()),
  }),
]);

type OlderLineFrame = z.infer<typeof olderLineFrameSchema>;

function parseAtOlderLine(
  serverFrameSchema: z.ZodType,
  frame: Record<string, unknown>,
): OlderLineFrame {
  const result = serverFrameSchema.safeParse(frame);
  if (!result.success) throw new Error(result.error.message);
  return olderLineFrameSchema.parse(result.data);
}

describe("projection: lines below 1.18 parse the same frames with both keys stripped", () => {
  const line = hostStreamRpcRegistry["chat.subscribe"][1];
  const projectedMinors = [13, 14, 15, 16, 17] as const;

  it("1.17 binds a frozen server schema, not the 1.18 one", () => {
    expect(chatSubscribeV117.serverFrameSchema).not.toBe(
      chatSubscribeV118.serverFrameSchema,
    );
  });

  for (const minor of projectedMinors) {
    const { contract } = line.versions[minor];
    const pausedQueue = {
      status: "paused",
      items: [],
      pausedReason: "turn_error",
    };
    const routedRow = assistantRow(notice({ present: true, value: RECEIPT }));

    it(`1.${minor}: snapshot tail row and queue lose receipt / pausedReason, all else intact`, () => {
      const data = parseAtOlderLine(
        contract.serverFrameSchema,
        snapshotFrame(routedRow, pausedQueue),
      );
      if (data.kind !== "snapshot") throw new Error("expected snapshot");
      const parsedNotice = noticeOf(data.snapshot.tail.messages[0]);
      expect(parsedNotice).not.toHaveProperty("receipt");
      expect(parsedNotice).toMatchObject({
        harnessId: "claude",
        noticeKind: "fallback_settled",
        tone: "info",
        title: "Settled",
        message: null,
        details: [],
        metadata: null,
      });
      expect(data.snapshot.queue).not.toHaveProperty("pausedReason");
      expect(data.snapshot.queue).toMatchObject({
        status: "paused",
        items: [],
      });
    });

    it(`1.${minor}: range row loses receipt`, () => {
      const data = parseAtOlderLine(
        contract.serverFrameSchema,
        rangeFrame(routedRow),
      );
      if (data.kind !== "range") throw new Error("expected range");
      const parsedNotice = noticeOf(data.range.messages[0]);
      expect(parsedNotice).not.toHaveProperty("receipt");
      expect(parsedNotice).toMatchObject({
        title: "Settled",
        noticeKind: "fallback_settled",
      });
    });

    it(`1.${minor}: queueChanged loses pausedReason`, () => {
      const data = parseAtOlderLine(
        contract.serverFrameSchema,
        queueChangedFrame(pausedQueue),
      );
      if (data.kind !== "queueChanged") {
        throw new Error("expected queueChanged");
      }
      expect(data.queue).not.toHaveProperty("pausedReason");
      expect(data.queue).toMatchObject({ status: "paused", items: [] });
    });
  }
});

describe("notice receipt schemas", () => {
  const base = notice({ present: false, value: undefined });

  it("providerNoticeMetadataSchemaPreReceipt strips receipt", () => {
    const parsed = providerNoticeMetadataSchemaPreReceipt.safeParse({
      ...base,
      receipt: RECEIPT,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty("receipt");
  });

  it("the live notice schema keeps the receipt", () => {
    const parsed = providerNoticeMetadataSchema.safeParse({
      ...base,
      receipt: RECEIPT,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.receipt).toEqual(RECEIPT);
  });

  it("degrades a receipt step kind a newer writer added to 'unknown', keeping every other field", () => {
    const step = RECEIPT.steps[0];
    const parsed = providerNoticeReceiptStepSchema.parse({
      ...step,
      kind: "future",
    });
    expect(parsed).toEqual({ ...step, kind: "unknown" });
  });

  it("keeps a known receipt step kind as written", () => {
    for (const step of RECEIPT.steps) {
      expect(providerNoticeReceiptStepSchema.parse(step).kind).toBe(step.kind);
    }
  });
});

describe("chat.subscribe@1.18: a receipt step kind from a newer writer does not fail the frame", () => {
  const futureReceipt = {
    ...RECEIPT,
    steps: [RECEIPT.steps[0], { ...RECEIPT.steps[1], kind: "future" }],
  };
  const expectedReceipt = {
    ...RECEIPT,
    steps: [RECEIPT.steps[0], { ...RECEIPT.steps[1], kind: "unknown" }],
  };

  it("snapshot tail: the row parses and the step reads 'unknown'", () => {
    const { message } = snapshotParts(
      parseAtHead(
        snapshotFrame(
          assistantRow(notice({ present: true, value: futureReceipt })),
          queue({ present: false, value: undefined }),
        ),
      ),
    );
    expect(noticeOf(message).receipt).toEqual(expectedReceipt);
  });

  it("range frame: the row parses and the step reads 'unknown'", () => {
    const parsedNotice = noticeOf(
      rangeMessage(
        parseAtHead(
          rangeFrame(
            assistantRow(notice({ present: true, value: futureReceipt })),
          ),
        ),
      ),
    );
    expect(parsedNotice.receipt).toEqual(expectedReceipt);
  });
});
