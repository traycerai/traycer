import { describe, expect, it } from "vitest";
import {
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
  chatSubscribeV17,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  interviewAnswerSchema,
  interviewBlockSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * Two separate reasons every new interview field carries `.catch()` on top
 * of `.default()`, and the tests below pin both:
 *
 * 1. Failure isolation — malformed enhanced data must downgrade to neutral
 *    and never invalidate the legacy `status`/`answers`/`error` projection
 *    an old renderer still reads. One corrupt `selection` must not take
 *    down the surrounding answer, block, message, or snapshot.
 * 2. Forward compatibility — these are closed enums on a record that is
 *    both persisted and published. A newer writer adding an outcome /
 *    settlement source / delivery status must not make every older reader
 *    reject the block outright.
 */

const SELECTION = {
  questionIndex: 0,
  optionIndices: [0],
  optionLabels: ["date-fns"],
  customText: null,
} as const;

const ENHANCED_ANSWER = {
  questionId: "q1",
  question: "Which library?",
  values: ["date-fns"],
  notes: null,
  selection: SELECTION,
};

const DRAFT_ANSWER = {
  questionId: "q1",
  question: "Which library?",
  values: ["lodash"],
  notes: "saved, not sent",
  selection: {
    questionIndex: 0,
    optionIndices: [1],
    optionLabels: ["lodash"],
    customText: null,
  },
};

const QUESTION = {
  questionId: "q1",
  question: "Which library?",
  header: "Library",
  options: [{ label: "date-fns", description: null, preview: null }],
  multiSelect: false,
};

function populatedInterviewBlock(): Record<string, unknown> {
  return {
    blockId: "iv-1",
    status: "completed",
    timestamp: 20,
    parentBlockId: null,
    type: "interview",
    toolName: "AskUserQuestion",
    title: "Library",
    description: "Pick one",
    questions: [QUESTION],
    answers: [ENHANCED_ANSWER],
    error: null,
    metadata: null,
    outcome: "answered",
    // Deliberately EMPTY. Saved drafts exist only for an explicit Skip, so an
    // answered block carrying them is an invalid combination this fixture must
    // not bless - `applyInterviewSettlement` clears them on any winning
    // non-skip outcome, and `interviewErrored` rejects them on the wire.
    draftAnswers: [],
    settlement: { settlementId: "gui-1", source: "gui" },
    diagnostics: [
      {
        diagnosticId: "diag-1",
        code: "runtime.interview_errored",
        source: "runtime",
      },
      {
        diagnosticId: "diag-2",
        code: "delivery.retry",
        source: "delivery",
      },
    ],
    delivery: {
      deliveryId: "del-1",
      status: "delivered",
      retryable: false,
    },
  };
}

function legacyInterviewBlock(): Record<string, unknown> {
  return {
    blockId: "iv-legacy",
    status: "completed",
    timestamp: 20,
    parentBlockId: null,
    type: "interview",
    toolName: "AskUserQuestion",
    title: "Library",
    description: "Pick one",
    questions: [QUESTION],
    answers: [
      {
        questionId: "q1",
        question: "Which library?",
        values: ["date-fns"],
        notes: null,
      },
    ],
    error: null,
    metadata: null,
  };
}

function agentSender(): Record<string, unknown> {
  return {
    type: "agent",
    harnessId: "codex",
    agentId: "agent-1",
    displayName: "Coder",
    reply: { expectsReply: false },
    inReplyTo: null,
  };
}

function assistantWithInterview(
  interview: Record<string, unknown>,
): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: agentSender(),
    blocks: [interview],
    startedAt: 10,
    timestamp: 20,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

function snapshotWithInterview(
  interview: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat: {
        id: "chat-1",
        parentId: null,
        userId: "owner-1",
        hostId: "test-host",
        title: "Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        messages: [assistantWithInterview(interview)],
        events: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      backgroundItems: [],
      managedCommands: [],
      heldUpdates: [],
    },
  };
}

function interviewAnsweredFrame(): Record<string, unknown> {
  return {
    kind: "interviewAnswered",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    blockId: "iv-1",
    answers: [ENHANCED_ANSWER],
    resolvedAt: 20,
    settlementId: "gui-1",
    settlementSource: "gui",
    delivery: {
      deliveryId: "del-1",
      status: "delivered",
      retryable: false,
    },
  };
}

function interviewErroredFrame(): Record<string, unknown> {
  return {
    kind: "interviewErrored",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    blockId: "iv-1",
    reason: "Not now",
    resolvedAt: 20,
    settlementId: "gui-1",
    settlementSource: "gui",
    outcome: "skipped",
    draftAnswers: [DRAFT_ANSWER],
    delivery: {
      deliveryId: "del-1",
      status: "pending",
      retryable: false,
    },
  };
}

function interviewResolvedDelta(): Record<string, unknown> {
  return {
    kind: "blockDelta",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    event: {
      type: "interview.resolved",
      blockId: "iv-1",
      timestamp: 20,
      answers: [ENHANCED_ANSWER],
    },
  };
}

function interviewAnswerClientFrame(): Record<string, unknown> {
  return {
    kind: "interviewAnswer",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    clientActionId: "action-1",
    blockId: "iv-1",
    answers: [ENHANCED_ANSWER],
  };
}

function interviewErrorClientFrame(): Record<string, unknown> {
  return {
    kind: "interviewError",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    clientActionId: "action-1",
    blockId: "iv-1",
    reason: "Not now",
    settlement: {
      outcome: "skipped",
      draftAnswers: [DRAFT_ANSWER],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected object for ${label}`);
  }
  return value;
}

function interviewFromSnapshot(parsed: unknown): Record<string, unknown> {
  const frame = asRecord(parsed, "frame");
  if (frame.kind !== "snapshot") {
    throw new Error("expected snapshot");
  }
  const snapshot = asRecord(frame.snapshot, "snapshot");
  const chat = asRecord(snapshot.chat, "chat");
  if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
    throw new Error("expected messages");
  }
  const message = asRecord(chat.messages[0], "message");
  if (!Array.isArray(message.blocks) || message.blocks.length === 0) {
    throw new Error("expected blocks");
  }
  return asRecord(message.blocks[0], "interview");
}

function firstAnswer(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("expected answers");
  }
  return asRecord(value[0], "answer");
}

const FROZEN_LINES = [
  { name: "1.4", contract: chatSubscribeV14 },
  { name: "1.5", contract: chatSubscribeV15 },
  { name: "1.6", contract: chatSubscribeV16 },
] as const;

const SEVENTEEN_BLOCK_KEYS = [
  "outcome",
  "draftAnswers",
  "settlement",
  "diagnostics",
  "delivery",
] as const;

describe("frozen chat.subscribe 1.4–1.6 drop every 1.7 interview field", () => {
  for (const line of FROZEN_LINES) {
    describe(line.name, () => {
      it("strips settlement fields from a snapshot interview block that carries them", () => {
        const parsed = line.contract.serverFrameSchema.parse(
          snapshotWithInterview(populatedInterviewBlock()),
        );
        const interview = interviewFromSnapshot(parsed);
        for (const key of SEVENTEEN_BLOCK_KEYS) {
          expect(Object.hasOwn(interview, key)).toBe(false);
        }
        const answer = firstAnswer(interview.answers);
        expect(Object.hasOwn(answer, "selection")).toBe(false);
        // Legacy meaning is what a 1.4–1.6 peer actually renders.
        expect(interview.status).toBe("completed");
        expect(answer.values).toEqual(["date-fns"]);
        expect(interview.error).toBeNull();
      });

      it("strips selection and delivery from interviewAnswered", () => {
        const parsed = line.contract.serverFrameSchema.parse(
          interviewAnsweredFrame(),
        );
        const frame = asRecord(parsed, "interviewAnswered");
        expect(frame.kind).toBe("interviewAnswered");
        expect(Object.hasOwn(frame, "delivery")).toBe(false);
        expect(Object.hasOwn(firstAnswer(frame.answers), "selection")).toBe(
          false,
        );
        expect(firstAnswer(frame.answers).values).toEqual(["date-fns"]);
      });

      it("strips outcome, draftAnswers, and delivery from interviewErrored", () => {
        const parsed = line.contract.serverFrameSchema.parse(
          interviewErroredFrame(),
        );
        const frame = asRecord(parsed, "interviewErrored");
        expect(frame.kind).toBe("interviewErrored");
        expect(Object.hasOwn(frame, "outcome")).toBe(false);
        expect(Object.hasOwn(frame, "draftAnswers")).toBe(false);
        expect(Object.hasOwn(frame, "delivery")).toBe(false);
        expect(frame.reason).toBe("Not now");
      });

      it("strips selection from blockDelta(interview.resolved)", () => {
        const parsed = line.contract.serverFrameSchema.parse(
          interviewResolvedDelta(),
        );
        const frame = asRecord(parsed, "blockDelta");
        expect(frame.kind).toBe("blockDelta");
        const event = asRecord(frame.event, "event");
        expect(event.type).toBe("interview.resolved");
        expect(Object.hasOwn(firstAnswer(event.answers), "selection")).toBe(
          false,
        );
        expect(firstAnswer(event.answers).values).toEqual(["date-fns"]);
      });

      it("strips selection from an interviewAnswer client frame", () => {
        const parsed = line.contract.clientFrameSchema.parse(
          interviewAnswerClientFrame(),
        );
        const frame = asRecord(parsed, "interviewAnswer");
        expect(frame.kind).toBe("interviewAnswer");
        expect(Object.hasOwn(firstAnswer(frame.answers), "selection")).toBe(
          false,
        );
        expect(firstAnswer(frame.answers).values).toEqual(["date-fns"]);
      });

      it("strips settlement from an interviewError client frame", () => {
        const parsed = line.contract.clientFrameSchema.parse(
          interviewErrorClientFrame(),
        );
        const frame = asRecord(parsed, "interviewError");
        expect(frame.kind).toBe("interviewError");
        expect(Object.hasOwn(frame, "settlement")).toBe(false);
        expect(frame.reason).toBe("Not now");
      });
    });
  }
});

describe("chat.subscribe@1.7 interview round-trip", () => {
  it("round-trips a fully populated interview block", () => {
    const payload = snapshotWithInterview(populatedInterviewBlock());
    const parsed = chatSubscribeV17.serverFrameSchema.parse(payload);
    const interview = interviewFromSnapshot(parsed);
    expect(interview.outcome).toBe("answered");
    expect(interview.draftAnswers).toEqual([]);
    expect(interview.settlement).toEqual({
      settlementId: "gui-1",
      source: "gui",
    });
    expect(interview.diagnostics).toEqual([
      {
        diagnosticId: "diag-1",
        code: "runtime.interview_errored",
        source: "runtime",
      },
      {
        diagnosticId: "diag-2",
        code: "delivery.retry",
        source: "delivery",
      },
    ]);
    expect(interview.delivery).toEqual({
      deliveryId: "del-1",
      status: "delivered",
      retryable: false,
      generation: 0,
    });
    expect(firstAnswer(interview.answers)).toEqual(ENHANCED_ANSWER);
  });

  it("round-trips interviewAnswered / interviewErrored 1.7 fields", () => {
    const answered = asRecord(
      chatSubscribeV17.serverFrameSchema.parse(interviewAnsweredFrame()),
      "answered",
    );
    expect(answered.delivery).toEqual({
      deliveryId: "del-1",
      status: "delivered",
      retryable: false,
      generation: 0,
    });
    expect(firstAnswer(answered.answers).selection).toEqual(SELECTION);

    const errored = asRecord(
      chatSubscribeV17.serverFrameSchema.parse(interviewErroredFrame()),
      "errored",
    );
    expect(errored.outcome).toBe("skipped");
    expect(errored.draftAnswers).toEqual([DRAFT_ANSWER]);
    expect(errored.delivery).toEqual({
      deliveryId: "del-1",
      status: "pending",
      retryable: false,
      generation: 0,
    });
  });

  it("keeps legacy meaning when the same 1.7 payload is parsed on 1.6", () => {
    const payload = snapshotWithInterview(populatedInterviewBlock());
    const v17 = interviewFromSnapshot(
      chatSubscribeV17.serverFrameSchema.parse(payload),
    );
    const v16 = interviewFromSnapshot(
      chatSubscribeV16.serverFrameSchema.parse(payload),
    );
    expect(v17.status).toBe("completed");
    expect(v16.status).toBe(v17.status);
    expect(firstAnswer(v16.answers).values).toEqual(
      firstAnswer(v17.answers).values,
    );
    expect(v16.error).toBe(v17.error);
    for (const key of SEVENTEEN_BLOCK_KEYS) {
      expect(Object.hasOwn(v16, key)).toBe(false);
    }
    expect(Object.hasOwn(firstAnswer(v16.answers), "selection")).toBe(false);
  });
});

describe("interviewBlockSchema defaults and malformed enhanced fields", () => {
  it("parses an old persisted interview block with every new field at its neutral default", () => {
    const parsed = interviewBlockSchema.parse(legacyInterviewBlock());
    expect(parsed.outcome).toBeNull();
    expect(parsed.draftAnswers).toEqual([]);
    expect(parsed.settlement).toBeNull();
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.delivery).toBeNull();
    expect(parsed.answers[0].selection).toBeNull();
    expect(parsed.answers[0].values).toEqual(["date-fns"]);
    expect(parsed.status).toBe("completed");
    expect(parsed.error).toBeNull();
  });

  it("downgrades malformed selection to null and keeps the flattened values", () => {
    const parsed = interviewAnswerSchema.parse({
      questionId: "q1",
      question: "Which library?",
      values: ["date-fns"],
      notes: null,
      selection: {
        questionIndex: 0,
        optionIndices: ["a"],
        optionLabels: ["date-fns"],
        customText: null,
      },
    });
    expect(parsed.values).toEqual(["date-fns"]);
    expect(parsed.selection).toBeNull();

    const block = interviewBlockSchema.parse({
      ...legacyInterviewBlock(),
      answers: [
        {
          questionId: "q1",
          question: "Which library?",
          values: ["date-fns"],
          notes: null,
          selection: {
            questionIndex: 0,
            optionIndices: ["a"],
            optionLabels: ["date-fns"],
            customText: null,
          },
        },
      ],
    });
    expect(block.status).toBe("completed");
    expect(block.answers[0].values).toEqual(["date-fns"]);
    expect(block.answers[0].selection).toBeNull();
  });

  it("degrades a future outcome enum value to null rather than rejecting the block", () => {
    const parsed = interviewBlockSchema.parse({
      ...legacyInterviewBlock(),
      outcome: "cancelled",
    });
    expect(parsed.outcome).toBeNull();
    expect(parsed.status).toBe("completed");
    expect(parsed.answers[0].values).toEqual(["date-fns"]);
  });

  it("degrades a future delivery.status to a null delivery projection", () => {
    const parsed = interviewBlockSchema.parse({
      ...legacyInterviewBlock(),
      delivery: {
        deliveryId: "del-1",
        status: "queued",
        retryable: false,
      },
    });
    expect(parsed.delivery).toBeNull();
    expect(parsed.status).toBe("completed");
  });

  it("defaults delivery.generation to 0 when absent and catches a malformed generation to 0", () => {
    const current = interviewBlockSchema.parse({
      ...legacyInterviewBlock(),
      delivery: {
        deliveryId: "del-1",
        status: "pending",
        retryable: false,
        generation: 4,
      },
    });
    expect(current.delivery?.generation).toBe(4);

    const absent = interviewBlockSchema.parse({
      ...legacyInterviewBlock(),
      delivery: {
        deliveryId: "del-1",
        status: "pending",
        retryable: false,
      },
    });
    expect(absent.delivery?.generation).toBe(0);

    const negative = interviewBlockSchema.parse({
      ...legacyInterviewBlock(),
      delivery: {
        deliveryId: "del-1",
        status: "pending",
        retryable: false,
        generation: -1,
      },
    });
    expect(negative.delivery?.generation).toBe(0);

    const malformedGeneration: Record<string, unknown> = {
      deliveryId: "del-1",
      status: "pending",
      retryable: false,
      generation: "next",
    };
    const malformed = interviewBlockSchema.parse({
      ...legacyInterviewBlock(),
      delivery: malformedGeneration,
    });
    expect(malformed.delivery?.generation).toBe(0);
  });

  it("degrades a future settlement.source to null authority", () => {
    const parsed = interviewBlockSchema.parse({
      ...legacyInterviewBlock(),
      settlement: { settlementId: "s1", source: "reconcile" },
    });
    expect(parsed.settlement).toBeNull();
    expect(parsed.status).toBe("completed");
  });

  it("falls a corrupt draftAnswers or diagnostics entry back to an empty array", () => {
    // Array-level catch: one unparseable entry discards the whole set, not
    // just itself. Drafts are unsents; losing them is cheaper than losing
    // the settled outcome around them.
    const drafts = interviewBlockSchema.parse({
      ...legacyInterviewBlock(),
      outcome: "skipped",
      draftAnswers: [{ not: "an answer" }],
    });
    expect(drafts.draftAnswers).toEqual([]);
    expect(drafts.outcome).toBe("skipped");
    expect(drafts.status).toBe("completed");

    const diagnostics = interviewBlockSchema.parse({
      ...legacyInterviewBlock(),
      diagnostics: [{ diagnosticId: "d1", code: "x", source: "not-a-source" }],
    });
    expect(diagnostics.diagnostics).toEqual([]);
    expect(diagnostics.status).toBe("completed");
  });

  it("round-trips a well-formed enhanced block unchanged", () => {
    const input = populatedInterviewBlock();
    const parsed = interviewBlockSchema.parse(input);
    expect(parsed.outcome).toBe("answered");
    expect(parsed.draftAnswers).toEqual([]);
    expect(parsed.settlement).toEqual({
      settlementId: "gui-1",
      source: "gui",
    });
    expect(parsed.diagnostics).toHaveLength(2);
    expect(parsed.delivery).toEqual({
      deliveryId: "del-1",
      status: "delivered",
      retryable: false,
      generation: 0,
    });
    expect(parsed.answers[0].selection).toEqual(SELECTION);
    expect(parsed.answers[0].values).toEqual(["date-fns"]);
  });

  it("accepts a historical answered or failed row that still carries drafts", () => {
    // History must always load. The reducer repairs this combination on
    // write; parse-time rejection would drop the settled outcome itself.
    const answered = interviewBlockSchema.parse({
      ...populatedInterviewBlock(),
      draftAnswers: [DRAFT_ANSWER],
    });
    expect(answered.outcome).toBe("answered");
    expect(answered.draftAnswers).toEqual([DRAFT_ANSWER]);
    expect(answered.status).toBe("completed");

    const failed = interviewBlockSchema.parse({
      ...populatedInterviewBlock(),
      status: "errored",
      error: "adapter cleanup",
      outcome: "failed",
      draftAnswers: [DRAFT_ANSWER],
    });
    expect(failed.outcome).toBe("failed");
    expect(failed.draftAnswers).toEqual([DRAFT_ANSWER]);
    expect(failed.status).toBe("errored");
  });
});

function interviewErroredPayload(
  extras: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "interviewErrored",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    blockId: "iv-1",
    reason: "Not now",
    resolvedAt: 20,
    ...extras,
  };
}

function draftAnswersIssuePath(
  issues: ReadonlyArray<{ path: PropertyKey[] }>,
): boolean {
  return issues.some((issue) => issue.path.includes("draftAnswers"));
}

describe("interviewErrored lifecycle invariants", () => {
  it("rejects outcome answered", () => {
    // An answered interview settles through interviewAnswered. The same
    // block arriving as "errored but answered" is a contradiction the
    // frame must not let into history.
    const result = chatSubscribeV17.serverFrameSchema.safeParse(
      interviewErroredPayload({ outcome: "answered" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects non-empty draftAnswers unless outcome is skipped", () => {
    const failed = chatSubscribeV17.serverFrameSchema.safeParse(
      interviewErroredPayload({
        outcome: "failed",
        draftAnswers: [DRAFT_ANSWER],
      }),
    );
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(draftAnswersIssuePath(failed.error.issues)).toBe(true);
    }

    const unknown = chatSubscribeV17.serverFrameSchema.safeParse(
      interviewErroredPayload({
        outcome: null,
        draftAnswers: [DRAFT_ANSWER],
      }),
    );
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(draftAnswersIssuePath(unknown.error.issues)).toBe(true);
    }
  });

  it("parses non-empty draftAnswers when outcome is skipped", () => {
    const parsed = asRecord(
      chatSubscribeV17.serverFrameSchema.parse(
        interviewErroredPayload({
          outcome: "skipped",
          draftAnswers: [DRAFT_ANSWER],
        }),
      ),
      "skipped",
    );
    expect(parsed.outcome).toBe("skipped");
    expect(parsed.draftAnswers).toEqual([DRAFT_ANSWER]);
  });

  it("parses empty draftAnswers with every allowed outcome", () => {
    for (const outcome of ["skipped", "failed", null] as const) {
      const parsed = asRecord(
        chatSubscribeV17.serverFrameSchema.parse(
          interviewErroredPayload({
            outcome,
            draftAnswers: [],
          }),
        ),
        "empty-drafts",
      );
      expect(parsed.outcome).toBe(outcome);
      expect(parsed.draftAnswers).toEqual([]);
    }
  });

  it("defaults absent outcome, draftAnswers, and delivery", () => {
    const parsed = asRecord(
      chatSubscribeV17.serverFrameSchema.parse(interviewErroredPayload({})),
      "defaults",
    );
    expect(parsed.outcome).toBeNull();
    expect(parsed.draftAnswers).toEqual([]);
    expect(parsed.delivery).toBeNull();
  });
});
