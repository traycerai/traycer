import { describe, expect, it } from "vitest";
import {
  interviewBlockSchema,
  interviewDeliveryProjectionSchema,
  type InterviewAnswer,
  type InterviewDeliveryProjection,
  type InterviewSettlementDiagnostic,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  applyInterviewSettlement,
  clearInterviewSettlement,
  isInterviewBlockSettled,
  overlayInterviewSettlementPatch,
  ownedPatch,
  reconcileInterviewDelivery,
  settledInterviewBlockIds,
  type InterviewSettlement,
  type InterviewSettlementPatch,
  type ReducibleInterviewBlock,
} from "../interview-settlement";

function makeAnswer(values: ReadonlyArray<string>): InterviewAnswer {
  return {
    questionId: "q1",
    question: "Which library?",
    values: [...values],
    notes: null,
    selection: {
      questionIndex: 0,
      optionIndices: [0],
      optionLabels: [...values],
      customText: null,
    },
  };
}

function makeDraft(values: ReadonlyArray<string>): InterviewAnswer {
  return {
    questionId: "q1",
    question: "Which library?",
    values: [...values],
    notes: "saved, not sent",
    selection: {
      questionIndex: 0,
      optionIndices: [1],
      optionLabels: [...values],
      customText: null,
    },
  };
}

function makeDelivery(
  status: InterviewDeliveryProjection["status"],
): InterviewDeliveryProjection {
  return {
    deliveryId: "delivery-1",
    status,
    retryable: status === "failed",
    generation: 0,
  };
}

function makeDeliveryProjection(
  deliveryId: string,
  status: InterviewDeliveryProjection["status"],
  retryable: boolean,
  generation: number,
): InterviewDeliveryProjection {
  return { deliveryId, status, retryable, generation };
}

const DELIVERY_IDS: ReadonlyArray<string> = ["delivery-a", "delivery-b"];
const DELIVERY_STATUSES: ReadonlyArray<InterviewDeliveryProjection["status"]> =
  ["pending", "delivering", "failed", "delivered"];
const RETRYABLE_VALUES: ReadonlyArray<boolean> = [true, false];
const GENERATION_VALUES: ReadonlyArray<number> = [0, 1];

function deliveryUniverse(): ReadonlyArray<InterviewDeliveryProjection | null> {
  const variants: Array<InterviewDeliveryProjection | null> = [null];
  for (const deliveryId of DELIVERY_IDS) {
    for (const status of DELIVERY_STATUSES) {
      for (const retryable of RETRYABLE_VALUES) {
        for (const generation of GENERATION_VALUES) {
          variants.push({ deliveryId, status, retryable, generation });
        }
      }
    }
  }
  return variants;
}

function deliveryLabel(delivery: InterviewDeliveryProjection | null): string {
  if (delivery === null) return "null";
  return `${delivery.deliveryId}:${delivery.status}:retryable=${String(delivery.retryable)}:g${String(delivery.generation)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/**
 * An in-process answer as host adapters actually build them: the `selection`
 * key is absent, not `null`. The predicate is the lie the type makes - the
 * schema says the key is present, but the reducer is the one that has to
 * survive objects built without it.
 */
function isProductionShapedAnswer(value: unknown): value is InterviewAnswer {
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, "selection")) return false;
  return (
    (typeof value.questionId === "string" || value.questionId === null) &&
    (typeof value.question === "string" || value.question === null) &&
    isStringArray(value.values) &&
    (typeof value.notes === "string" || value.notes === null)
  );
}

function productionShapedAnswer(
  values: ReadonlyArray<string>,
): InterviewAnswer {
  const raw: Record<string, unknown> = {
    questionId: "q1",
    question: "Which library?",
    values: [...values],
    notes: null,
  };
  if (!isProductionShapedAnswer(raw)) {
    throw new Error("expected production-shaped answer");
  }
  return raw;
}

function makeDiagnostic(diagnosticId: string): InterviewSettlementDiagnostic {
  return {
    diagnosticId,
    code: "runtime.interview_errored",
    source: "runtime",
  };
}

function guiAuthoritativeBlock(
  delivery: InterviewDeliveryProjection | null,
): ReducibleInterviewBlock {
  return {
    status: "completed",
    answers: [makeAnswer(["date-fns"])],
    error: null,
    outcome: "answered",
    draftAnswers: [],
    settlement: { settlementId: "gui-answered", source: "gui" },
    diagnostics: [makeDiagnostic("diag-existing")],
    delivery,
    settlementExtensions: { escalation: { level: 2 } },
    timestamp: 50,
  };
}

/**
 * Runtime holds the canonical slot. A later GUI settlement wins it, which
 * is the path that must ADOPT delivery rather than merge it.
 */
function runtimeAuthoritativeBlock(
  delivery: InterviewDeliveryProjection | null,
): ReducibleInterviewBlock {
  return {
    status: "completed",
    answers: [makeAnswer(["inferred"])],
    error: null,
    outcome: "answered",
    draftAnswers: [],
    settlement: { settlementId: "runtime-answered", source: "runtime" },
    diagnostics: [],
    delivery,
    settlementExtensions: {},
    timestamp: 10,
  };
}

/**
 * A settlement that cannot take the canonical slot but IS the block's own
 * settlement being re-applied - the shape an outbox delivery update actually
 * arrives in.
 *
 * The `settlementId` matches the block's authority deliberately. Delivery is
 * correlated to settlement authority, so a settlement with a DIFFERENT id
 * never merges delivery at all; using one here would make every cell of the
 * cross-product report `changed: false` and stop exercising the delivery
 * algebra entirely. The vacuity guard below catches exactly that, and did.
 *
 * Its payload still contradicts the block (a `failed` outcome, other answers,
 * drafts) so the matrix also proves a replay cannot rewrite canonical content
 * while its delivery is merged.
 */
function losingRuntimeSettlement(
  delivery: InterviewDeliveryProjection | null,
): InterviewSettlement {
  return {
    settlementId: "gui-answered",
    outcome: "failed",
    answers: [makeAnswer(["lodash"])],
    draftAnswers: [makeDraft(["underscore"])],
    reason: "adapter cleanup",
    source: "runtime",
    diagnostic: makeDiagnostic("diag-existing"),
    delivery,
    timestamp: 99,
  };
}

function historicalInterviewRow(input: {
  readonly outcome: "answered" | "failed";
  readonly draftAnswers: InterviewAnswer[];
}): Record<string, unknown> {
  const answered = input.outcome === "answered";
  return {
    blockId: "iv-historical",
    status: answered ? "completed" : "errored",
    timestamp: 20,
    parentBlockId: null,
    type: "interview",
    toolName: "AskUserQuestion",
    title: "Library",
    description: "Pick one",
    questions: [
      {
        questionId: "q1",
        question: "Which library?",
        header: "Library",
        options: [{ label: "date-fns", description: null, preview: null }],
        multiSelect: false,
      },
    ],
    answers: answered ? [makeAnswer(["date-fns"])] : [],
    error: answered ? null : "adapter cleanup",
    metadata: null,
    outcome: input.outcome,
    draftAnswers: input.draftAnswers,
    settlement: answered
      ? { settlementId: "gui-answered", source: "gui" }
      : { settlementId: "runtime-failed", source: "runtime" },
    diagnostics: [],
    delivery: null,
  };
}

function streamingBlock(): ReducibleInterviewBlock {
  return {
    status: "streaming",
    answers: [],
    error: null,
    outcome: null,
    draftAnswers: [],
    settlement: null,
    diagnostics: [],
    delivery: null,
    settlementExtensions: {},
    timestamp: 1,
  };
}

function guiAnswered(timestamp: number): InterviewSettlement {
  return {
    settlementId: "gui-answered",
    outcome: "answered",
    answers: [makeAnswer(["date-fns"])],
    draftAnswers: [],
    reason: null,
    source: "gui",
    diagnostic: null,
    delivery: makeDelivery("pending"),
    timestamp,
  };
}

function guiSkipped(timestamp: number): InterviewSettlement {
  return {
    settlementId: "gui-skipped",
    outcome: "skipped",
    answers: [],
    draftAnswers: [makeDraft(["lodash"])],
    reason: "Not now",
    source: "gui",
    diagnostic: null,
    delivery: null,
    timestamp,
  };
}

function runtimeAnswered(
  settlementId: string,
  answers: InterviewAnswer[],
  timestamp: number,
): InterviewSettlement {
  return {
    settlementId,
    outcome: "answered",
    answers,
    draftAnswers: [],
    reason: null,
    source: "runtime",
    diagnostic: null,
    delivery: null,
    timestamp,
  };
}

function runtimeFailed(
  settlementId: string,
  diagnostic: InterviewSettlementDiagnostic | null,
  timestamp: number,
): InterviewSettlement {
  return {
    settlementId,
    outcome: "failed",
    answers: [],
    draftAnswers: [],
    reason: "adapter cleanup",
    source: "runtime",
    diagnostic,
    delivery: null,
    timestamp,
  };
}

/**
 * A settlement that cannot take the canonical slot AND is not the block's
 * own settlement. Delivery is correlated to settlement authority, so this
 * shape must leave `block.delivery` exactly as found - including adopting
 * nothing onto a null slot. Contrast `losingRuntimeSettlement`, which is a
 * same-id replay and therefore may merge delivery.
 *
 * Diagnostic is null on purpose: the correlation cases assert `changed ===
 * false`, so the settlement must not contribute a diagnostic (or anything
 * else) that would independently report a write.
 */
function distinctLosingRuntimeSettlement(
  delivery: InterviewDeliveryProjection,
): InterviewSettlement {
  return {
    ...runtimeFailed("runtime-other", null, 99),
    delivery,
  };
}

function runtimeSkipped(
  settlementId: string,
  drafts: InterviewAnswer[],
  timestamp: number,
): InterviewSettlement {
  return {
    settlementId,
    outcome: "skipped",
    answers: [],
    draftAnswers: drafts,
    reason: "abandoned",
    source: "runtime",
    diagnostic: null,
    delivery: null,
    timestamp,
  };
}

function reduce(
  block: ReducibleInterviewBlock,
  settlement: InterviewSettlement,
): { readonly block: ReducibleInterviewBlock; readonly changed: boolean } {
  const { changed, patch } = applyInterviewSettlement(block, settlement);
  return { changed, block: { ...block, ...patch } };
}

function reduceAll(
  block: ReducibleInterviewBlock,
  settlements: ReadonlyArray<InterviewSettlement>,
): ReducibleInterviewBlock {
  let current = block;
  for (const settlement of settlements) {
    current = reduce(current, settlement).block;
  }
  return current;
}

function expectLegacy(
  block: ReducibleInterviewBlock,
  expected: {
    readonly status: ReducibleInterviewBlock["status"];
    readonly answers: InterviewAnswer[];
    readonly error: string | null;
  },
): void {
  expect(block.status).toBe(expected.status);
  expect(block.answers).toEqual(expected.answers);
  expect(block.error).toBe(expected.error);
}

describe("applyInterviewSettlement", () => {
  it("keeps GUI answers when a later runtime resolution arrives empty", () => {
    // OpenCode's converter emits a second interview.resolved whose answers
    // are empty. Empty must not regress a GUI-accepted submission to
    // "No answer".
    const gui = guiAnswered(10);
    const first = reduce(streamingBlock(), gui);
    expect(first.changed).toBe(true);
    expectLegacy(first.block, {
      status: "completed",
      answers: gui.answers,
      error: null,
    });
    expect(first.block.outcome).toBe("answered");
    expect(first.block.settlement).toEqual({
      settlementId: "gui-answered",
      source: "gui",
    });

    const second = reduce(
      first.block,
      runtimeAnswered("runtime-empty", [], 20),
    );
    expect(second.block.answers).toEqual(gui.answers);
    expect(second.block.outcome).toBe("answered");
    expectLegacy(second.block, {
      status: "completed",
      answers: gui.answers,
      error: null,
    });
  });

  it("keeps skipped after a later runtime error and records the diagnostic separately", () => {
    // Adapter cleanup used to overwrite the Skip reason into legacy `error`.
    // Diagnostics exist so that write has somewhere else to go.
    const skipped = reduce(streamingBlock(), guiSkipped(10));
    expectLegacy(skipped.block, {
      status: "errored",
      answers: [],
      error: "Not now",
    });
    expect(skipped.block.outcome).toBe("skipped");
    expect(skipped.block.draftAnswers).toEqual(guiSkipped(10).draftAnswers);

    const afterError = reduce(
      skipped.block,
      runtimeFailed("runtime-failed", makeDiagnostic("diag-1"), 20),
    );
    expect(afterError.changed).toBe(true);
    expect(afterError.block.outcome).toBe("skipped");
    expectLegacy(afterError.block, {
      status: "errored",
      answers: [],
      error: "Not now",
    });
    expect(afterError.block.diagnostics).toEqual([makeDiagnostic("diag-1")]);
  });

  it("takes a runtime answer as canonical when no GUI settlement exists", () => {
    const answers = [makeAnswer(["date-fns"])];
    const result = reduce(
      streamingBlock(),
      runtimeAnswered("runtime-answered", answers, 10),
    );
    expect(result.changed).toBe(true);
    expect(result.block.outcome).toBe("answered");
    expect(result.block.settlement).toEqual({
      settlementId: "runtime-answered",
      source: "runtime",
    });
    expectLegacy(result.block, {
      status: "completed",
      answers,
      error: null,
    });
  });

  it("takes a runtime error as failed when no GUI settlement exists", () => {
    const result = reduce(
      streamingBlock(),
      runtimeFailed("runtime-failed", makeDiagnostic("diag-1"), 10),
    );
    expect(result.changed).toBe(true);
    expect(result.block.outcome).toBe("failed");
    expectLegacy(result.block, {
      status: "errored",
      answers: [],
      error: "adapter cleanup",
    });
    expect(result.block.diagnostics).toEqual([makeDiagnostic("diag-1")]);
  });

  it("is a no-op when the same settlementId is applied twice", () => {
    const settlement = guiAnswered(10);
    const first = reduce(streamingBlock(), settlement);
    const second = applyInterviewSettlement(first.block, {
      ...settlement,
      timestamp: 99,
    });
    expect(second.changed).toBe(false);
    expect(second.patch.timestamp).toBe(first.block.timestamp);
    expect(second.patch).toEqual({
      status: first.block.status,
      answers: first.block.answers,
      error: first.block.error,
      outcome: first.block.outcome,
      draftAnswers: first.block.draftAnswers,
      settlement: first.block.settlement,
      diagnostics: first.block.diagnostics,
      delivery: first.block.delivery,
      settlementExtensions: first.block.settlementExtensions,
      timestamp: first.block.timestamp,
    } satisfies InterviewSettlementPatch);
  });

  it("does not grow diagnostics when the incoming diagnosticId already exists", () => {
    const diagnostic = makeDiagnostic("diag-1");
    const first = reduce(
      streamingBlock(),
      runtimeFailed("runtime-failed-1", diagnostic, 10),
    );
    const second = reduce(
      first.block,
      runtimeFailed("runtime-failed-2", diagnostic, 20),
    );
    expect(second.block.diagnostics).toHaveLength(1);
    expect(second.block.diagnostics).toEqual([diagnostic]);
    // Duplicate diagnostic + losing `failed` contributes nothing new.
    expect(second.changed).toBe(false);
    expect(second.block.timestamp).toBe(10);
  });

  it("does not let failed overwrite an established non-null outcome", () => {
    const answered = reduce(streamingBlock(), guiAnswered(10));
    const afterFailed = reduce(
      answered.block,
      runtimeFailed("runtime-failed", makeDiagnostic("diag-1"), 20),
    );
    expect(afterFailed.block.outcome).toBe("answered");
    expectLegacy(afterFailed.block, {
      status: "completed",
      answers: guiAnswered(10).answers,
      error: null,
    });
    expect(afterFailed.block.diagnostics).toEqual([makeDiagnostic("diag-1")]);
  });

  it("lets a GUI settlement displace existing runtime authority", () => {
    const runtime = reduce(
      streamingBlock(),
      runtimeAnswered("runtime-answered", [makeAnswer(["inferred"])], 10),
    );
    const gui = reduce(runtime.block, guiAnswered(20));
    expect(gui.changed).toBe(true);
    expect(gui.block.settlement).toEqual({
      settlementId: "gui-answered",
      source: "gui",
    });
    expect(gui.block.answers).toEqual(guiAnswered(20).answers);
    expectLegacy(gui.block, {
      status: "completed",
      answers: guiAnswered(20).answers,
      error: null,
    });
  });

  it("rejects a runtime settlement over existing GUI authority", () => {
    const gui = reduce(streamingBlock(), guiAnswered(10));
    const runtime = reduce(
      gui.block,
      runtimeAnswered("runtime-answered", [], 20),
    );
    expect(runtime.block.settlement).toEqual({
      settlementId: "gui-answered",
      source: "gui",
    });
    expect(runtime.block.outcome).toBe("answered");
    expectLegacy(runtime.block, {
      status: "completed",
      answers: guiAnswered(10).answers,
      error: null,
    });
  });

  it("advances delivery pending → delivering → delivered without a new settlement identity", () => {
    const pending = guiAnswered(10);
    const first = reduce(streamingBlock(), pending);
    expect(first.block.delivery).toEqual(makeDelivery("pending"));

    const delivering = reduce(first.block, {
      ...pending,
      delivery: makeDelivery("delivering"),
      timestamp: 20,
    });
    expect(delivering.changed).toBe(true);
    expect(delivering.block.delivery).toEqual(makeDelivery("delivering"));
    expect(delivering.block.settlement?.settlementId).toBe("gui-answered");
    expect(delivering.block.outcome).toBe("answered");
    expect(delivering.block.timestamp).toBe(20);

    const delivered = reduce(delivering.block, {
      ...pending,
      delivery: makeDelivery("delivered"),
      timestamp: 30,
    });
    expect(delivered.changed).toBe(true);
    expect(delivered.block.delivery).toEqual(makeDelivery("delivered"));
    expectLegacy(delivered.block, {
      status: "completed",
      answers: pending.answers,
      error: null,
    });
  });

  it("never lets a null delivery clear an existing projection", () => {
    // Silence is not a retraction: the outbox is authoritative, and a
    // settlement that does not report delivery must leave the projection
    // already on the block alone.
    const pending = reduce(streamingBlock(), guiAnswered(10));
    const silent = reduce(pending.block, {
      ...guiAnswered(10),
      delivery: null,
      timestamp: 20,
    });
    expect(silent.block.delivery).toEqual(makeDelivery("pending"));
  });

  it("is idempotent: applying a permutation twice equals applying it once", () => {
    const sequence: InterviewSettlement[] = [
      runtimeAnswered("runtime-answered", [makeAnswer(["inferred"])], 5),
      guiAnswered(10),
      runtimeAnswered("runtime-empty", [], 15),
      runtimeFailed("runtime-failed", makeDiagnostic("diag-1"), 20),
      {
        ...guiAnswered(10),
        delivery: makeDelivery("delivering"),
        timestamp: 25,
      },
      {
        ...guiAnswered(10),
        delivery: makeDelivery("delivered"),
        timestamp: 30,
      },
    ];
    const once = reduceAll(streamingBlock(), sequence);
    const twice = reduceAll(once, sequence);
    expect(twice).toEqual(once);
  });
});

describe("clearInterviewSettlement", () => {
  it("clears exactly the settlement fields and leaves framing content on the raw overlay", () => {
    const settled = reduce(streamingBlock(), guiSkipped(10)).block;
    const { changed, patch } = clearInterviewSettlement(settled, 40);
    expect(changed).toBe(true);
    expect(patch).toEqual({
      status: "streaming",
      answers: [],
      error: null,
      outcome: null,
      draftAnswers: [],
      settlement: null,
      diagnostics: [],
      delivery: null,
      settlementExtensions: {},
      timestamp: 40,
    } satisfies InterviewSettlementPatch);
    expect(
      isInterviewBlockSettled({
        status: patch.status,
        outcome: patch.outcome,
        settlement: patch.settlement,
      }),
    ).toBe(false);

    const raw: Record<string, unknown> = {
      type: "interview",
      blockId: "iv-1",
      questions: [
        {
          questionId: "q1",
          question: "Which library?",
          header: "Library",
          options: [{ label: "date-fns", description: null, preview: null }],
          multiSelect: false,
        },
      ],
      title: "Choose a library",
      description: "Need a date helper",
      toolName: "AskUserQuestion",
      metadata: { native: true },
      status: settled.status,
      answers: settled.answers,
      error: settled.error,
      outcome: settled.outcome,
      draftAnswers: settled.draftAnswers,
      settlement: settled.settlement,
      diagnostics: settled.diagnostics,
      delivery: settled.delivery,
      timestamp: settled.timestamp,
    };
    const overlaid = overlayInterviewSettlementPatch(raw, patch);
    expect(overlaid.questions).toEqual(raw.questions);
    expect(overlaid.title).toBe("Choose a library");
    expect(overlaid.description).toBe("Need a date helper");
    expect(overlaid.toolName).toBe("AskUserQuestion");
    expect(overlaid.metadata).toEqual({ native: true });
    expect(overlaid.status).toBe("streaming");
    expect(overlaid.outcome).toBeNull();
    expect(overlaid.settlement).toBeNull();
  });
});

describe("settledInterviewBlockIds", () => {
  it("unions event ids with block authority, and each source alone is sufficient", () => {
    const eventOnly = settledInterviewBlockIds({
      blocks: [
        {
          blockId: "event-only",
          status: "streaming",
          outcome: null,
          settlement: null,
        },
      ],
      settlementEventBlockIds: ["event-only"],
    });
    expect([...eventOnly]).toEqual(["event-only"]);

    const authorityOnly = settledInterviewBlockIds({
      blocks: [
        {
          blockId: "authority-only",
          status: "streaming",
          outcome: null,
          settlement: { settlementId: "s1", source: "gui" },
        },
      ],
      settlementEventBlockIds: [],
    });
    expect([...authorityOnly]).toEqual(["authority-only"]);

    const outcomeOnly = settledInterviewBlockIds({
      blocks: [
        {
          blockId: "outcome-only",
          status: "streaming",
          outcome: "answered",
          settlement: null,
        },
      ],
      settlementEventBlockIds: [],
    });
    expect([...outcomeOnly]).toEqual(["outcome-only"]);

    const both = settledInterviewBlockIds({
      blocks: [
        {
          blockId: "from-block",
          status: "completed",
          outcome: "answered",
          settlement: { settlementId: "s1", source: "gui" },
        },
        {
          blockId: "open",
          status: "streaming",
          outcome: null,
          settlement: null,
        },
      ],
      settlementEventBlockIds: ["from-event"],
    });
    expect(both.has("from-block")).toBe(true);
    expect(both.has("from-event")).toBe(true);
    expect(both.has("open")).toBe(false);
  });

  it("counts a legacy terminal block with no canonical facts as settled", () => {
    // Weak authority: status !== streaming blocks reopen but cannot
    // manufacture an outcome. Hydration and notifications must still agree
    // that the interview is not pending.
    const settled = settledInterviewBlockIds({
      blocks: [
        {
          blockId: "legacy",
          status: "errored",
          outcome: null,
          settlement: null,
        },
      ],
      settlementEventBlockIds: [],
    });
    expect([...settled]).toEqual(["legacy"]);
    expect(
      isInterviewBlockSettled({
        status: "errored",
        outcome: null,
        settlement: null,
      }),
    ).toBe(true);
  });
});

describe("overlayInterviewSettlementPatch", () => {
  it("preserves unknown raw keys while writing the known-field patch", () => {
    // Fork transforms must not round-trip a parsed ContentBlock: parsing
    // drops keys the current schema does not know.
    const patch = applyInterviewSettlement(
      streamingBlock(),
      guiAnswered(10),
    ).patch;
    const overlaid = overlayInterviewSettlementPatch(
      {
        type: "interview",
        futureField: "keep-me",
        nested: { also: true },
      },
      patch,
    );
    expect(overlaid.futureField).toBe("keep-me");
    expect(overlaid.nested).toEqual({ also: true });
    expect(overlaid.outcome).toBe("answered");
    expect(overlaid.status).toBe("completed");
  });
});

describe("payload ownership", () => {
  it("keeps GUI answers when a later runtime resolution carries different non-empty answers", () => {
    // The original data-loss bug: any non-empty incoming payload won, so a
    // runtime resolution with different answers silently replaced the GUI
    // submission the user actually accepted.
    const gui = reduce(streamingBlock(), guiAnswered(10));
    const runtime = reduce(
      gui.block,
      runtimeAnswered("runtime-other", [makeAnswer(["lodash"])], 20),
    );
    expect(runtime.block.answers).toEqual(guiAnswered(10).answers);
    expect(runtime.block.settlement).toEqual({
      settlementId: "gui-answered",
      source: "gui",
    });
    expect(runtime.block.outcome).toBe("answered");
  });

  it("is a strict no-op when the same settlementId is replayed with an altered payload", () => {
    const first = reduce(streamingBlock(), guiAnswered(10));
    const replay = applyInterviewSettlement(first.block, {
      ...guiAnswered(10),
      answers: [makeAnswer(["lodash"])],
      draftAnswers: [makeDraft(["underscore"])],
      reason: "altered",
      timestamp: 99,
    });
    expect(replay.changed).toBe(false);
    expect(replay.patch.answers).toEqual(guiAnswered(10).answers);
    expect(replay.patch.draftAnswers).toEqual([]);
    expect(replay.patch.error).toBeNull();
    expect(replay.patch.timestamp).toBe(first.block.timestamp);
  });

  it("does not let a winning empty payload erase answers already on the block", () => {
    const recorded = [makeAnswer(["date-fns"])];
    const block: ReducibleInterviewBlock = {
      ...streamingBlock(),
      answers: recorded,
    };
    const result = reduce(block, runtimeAnswered("runtime-empty", [], 10));
    expect(result.block.answers).toEqual(recorded);
    expect(result.block.outcome).toBe("answered");
    expect(result.block.settlement).toEqual({
      settlementId: "runtime-empty",
      source: "runtime",
    });
  });

  it("fills empty answers on an unowned block and does not replace answers the block already has when the incoming settlement is empty", () => {
    // Unowned + empty: the incoming settlement wins the vacant slot and
    // supplies the missing answers. Unowned + already filled + empty
    // incoming: the winner's empty-vs-non-empty protection keeps what is
    // recorded. A non-empty settlement against an unowned block WINS and
    // replaces - there is no losing-and-unowned path to exercise, because
    // `settlementWins` returns true whenever authority and outcome are both
    // absent.
    const filled = reduce(
      streamingBlock(),
      runtimeAnswered("runtime-fill", [makeAnswer(["inferred"])], 10),
    );
    expect(filled.block.answers).toEqual([makeAnswer(["inferred"])]);

    const alreadyFilled: ReducibleInterviewBlock = {
      ...streamingBlock(),
      answers: [makeAnswer(["date-fns"])],
    };
    const kept = reduce(
      alreadyFilled,
      runtimeAnswered("runtime-empty", [], 10),
    );
    expect(kept.block.answers).toEqual([makeAnswer(["date-fns"])]);
  });

  it("does not fill answers across stronger GUI skip authority", () => {
    // A skipped card's answers are canonically []. A later runtime
    // `answered` with real values must not sneak them in: fill is for
    // unowned blocks, not for overwriting a stronger authority.
    const skipped = reduce(streamingBlock(), guiSkipped(10));
    expect(skipped.block.answers).toEqual([]);
    const drafts = skipped.block.draftAnswers;
    const outcome = skipped.block.outcome;

    const runtime = reduce(
      skipped.block,
      runtimeAnswered("runtime-answered", [makeAnswer(["lodash"])], 20),
    );
    expect(runtime.block.answers).toEqual([]);
    expect(runtime.block.draftAnswers).toEqual(drafts);
    expect(runtime.block.outcome).toBe(outcome);
    expect(runtime.block.settlement).toEqual({
      settlementId: "gui-skipped",
      source: "gui",
    });
  });
});

describe("selection normalization", () => {
  it("writes explicit null for production-shaped answers that omit selection, and re-applying is a no-op", () => {
    const incoming = productionShapedAnswer(["date-fns"]);
    expect(Object.hasOwn(incoming, "selection")).toBe(false);

    const first = reduce(
      streamingBlock(),
      runtimeAnswered("runtime-shaped", [incoming], 10),
    );
    expect(first.changed).toBe(true);
    expect(first.block.answers).toHaveLength(1);
    expect(Object.hasOwn(first.block.answers[0], "selection")).toBe(true);
    expect(first.block.answers[0].selection).toBeNull();

    const second = applyInterviewSettlement(
      first.block,
      runtimeAnswered(
        "runtime-shaped",
        [productionShapedAnswer(["date-fns"])],
        99,
      ),
    );
    expect(second.changed).toBe(false);
    expect(second.patch.answers[0].selection).toBeNull();
    expect(second.patch.timestamp).toBe(first.block.timestamp);
  });

  it("treats a stored answer missing selection as equal to an incoming normalized null", () => {
    // Blocks written before this normalizer exist in-process without the
    // key. Comparing that absence to an explicit null must not look like a
    // payload change, or a genuine replay would persist and re-broadcast.
    const stored = productionShapedAnswer(["date-fns"]);
    const first = reduce(
      streamingBlock(),
      runtimeAnswered("runtime-shaped", [stored], 10),
    );
    const block: ReducibleInterviewBlock = {
      ...first.block,
      answers: [stored],
    };
    expect(Object.hasOwn(block.answers[0], "selection")).toBe(false);

    const replay = applyInterviewSettlement(
      block,
      runtimeAnswered(
        "runtime-shaped",
        [{ ...makeAnswer(["date-fns"]), selection: null }],
        99,
      ),
    );
    expect(replay.changed).toBe(false);
    expect(Object.hasOwn(replay.patch.answers[0], "selection")).toBe(false);
    expect(replay.patch.timestamp).toBe(10);
  });
});

describe("delivery monotonicity", () => {
  const BASE_ID = "delivery-1";

  function settlementWith(
    delivery: InterviewDeliveryProjection,
    timestamp: number,
  ): InterviewSettlement {
    return {
      ...guiAnswered(timestamp),
      delivery,
    };
  }

  it("records each intermediate of pending → delivering → delivered", () => {
    const pending = reduce(
      streamingBlock(),
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 0), 10),
    );
    expect(pending.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "pending", false, 0),
    );

    const delivering = reduce(
      pending.block,
      settlementWith(
        makeDeliveryProjection(BASE_ID, "delivering", false, 0),
        20,
      ),
    );
    expect(delivering.changed).toBe(true);
    expect(delivering.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "delivering", false, 0),
    );
    expect(delivering.block.outcome).toBe("answered");

    const delivered = reduce(
      delivering.block,
      settlementWith(
        makeDeliveryProjection(BASE_ID, "delivered", false, 0),
        30,
      ),
    );
    expect(delivered.changed).toBe(true);
    expect(delivered.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "delivered", false, 0),
    );
  });

  it("keeps delivered when a later pending arrives", () => {
    const delivered = reduce(
      streamingBlock(),
      settlementWith(
        makeDeliveryProjection(BASE_ID, "delivered", false, 0),
        10,
      ),
    );
    const afterPending = reduce(
      delivered.block,
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 0), 20),
    );
    expect(afterPending.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "delivered", false, 0),
    );
  });

  it("keeps delivering when a later pending arrives", () => {
    const delivering = reduce(
      streamingBlock(),
      settlementWith(
        makeDeliveryProjection(BASE_ID, "delivering", false, 0),
        10,
      ),
    );
    const afterPending = reduce(
      delivering.block,
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 0), 20),
    );
    expect(afterPending.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "delivering", false, 0),
    );
  });

  it("lets a retryable failure requeue to pending at a strictly newer generation", () => {
    // A retry is the one legitimate backwards move by status rank, and the
    // generation is what makes it distinguishable from a STALE pending being
    // replayed after the failure. The outbox increments the generation when it
    // requeues; a replay does not.
    const failed = reduce(
      streamingBlock(),
      settlementWith(makeDeliveryProjection(BASE_ID, "failed", true, 0), 10),
    );
    expect(failed.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "failed", true, 0),
    );
    const requeued = reduce(
      failed.block,
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 1), 20),
    );
    expect(requeued.changed).toBe(true);
    expect(requeued.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "pending", false, 1),
    );
  });

  it("refuses a same-generation pending after a retryable failure", () => {
    // The stale-replay counterexample: identical to the requeue above except
    // the generation did not move, which is exactly what a redelivered old
    // update looks like. Accepting it would tell the user their answer was
    // queued when the attempt had already failed.
    const failed = reduce(
      streamingBlock(),
      settlementWith(makeDeliveryProjection(BASE_ID, "failed", true, 0), 10),
    );
    const stale = reduce(
      failed.block,
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 0), 20),
    );
    expect(stale.changed).toBe(false);
    expect(stale.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "failed", true, 0),
    );
  });

  it("does not let a non-retryable failure move back to pending", () => {
    const failed = reduce(
      streamingBlock(),
      settlementWith(makeDeliveryProjection(BASE_ID, "failed", false, 0), 10),
    );
    const afterPending = reduce(
      failed.block,
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 0), 20),
    );
    expect(afterPending.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "failed", false, 0),
    );
  });

  it("preserves the existing projection when a different deliveryId arrives at any point", () => {
    const steps: InterviewDeliveryProjection[] = [
      makeDeliveryProjection(BASE_ID, "pending", false, 0),
      makeDeliveryProjection(BASE_ID, "delivering", false, 0),
      makeDeliveryProjection(BASE_ID, "delivered", false, 0),
    ];
    let current = streamingBlock();
    for (const [index, step] of steps.entries()) {
      current = reduce(current, settlementWith(step, (index + 1) * 10)).block;
      const other = reduce(
        current,
        settlementWith(
          makeDeliveryProjection("delivery-other", "pending", false, 0),
          (index + 1) * 10 + 1,
        ),
      );
      expect(other.block.delivery).toEqual(step);
    }
  });

  it("reports a generation-only bump as changed, so a stale replay cannot outrank it", () => {
    // `changed` is what tells a caller whether to persist, so a field omitted
    // from `sameDelivery` is a field that can be silently dropped. `generation`
    // was omitted once: `mergeDelivery` returned the newer generation, `changed`
    // said false, a caller honouring it skipped the write, and the block kept
    // the OLD generation - after which a stale update at the new generation
    // outranked it.
    //
    // Pinned on `pending` rather than `delivered`, because `delivered` is now
    // absorbing across generations (see the test below) and so can no longer
    // exhibit this even if the equality regressed. `pending` is where a
    // generation bump still has to be persisted to mean anything.
    const first = reduce(
      streamingBlock(),
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 0), 10),
    );
    const bumped = reduce(
      first.block,
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 1), 20),
    );
    expect(bumped.changed).toBe(true);
    expect(bumped.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "pending", false, 1),
    );

    // With the bump persisted, the older generation is refused.
    const stale = reduce(
      bumped.block,
      settlementWith(makeDeliveryProjection(BASE_ID, "failed", true, 0), 30),
    );
    expect(stale.changed).toBe(false);
    expect(stale.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "pending", false, 1),
    );
  });

  it("keeps delivered absorbing in both directions, across generations", () => {
    // Existing delivered survives anything; an incoming delivered beats any
    // stored non-delivered state whatever its generation. Delivery is
    // terminal - the provider already has the answer.
    const delivered = reduce(
      streamingBlock(),
      settlementWith(
        makeDeliveryProjection(BASE_ID, "delivered", false, 0),
        10,
      ),
    );
    for (const incoming of [
      makeDeliveryProjection(BASE_ID, "pending", false, 5),
      makeDeliveryProjection(BASE_ID, "delivering", false, 5),
      makeDeliveryProjection(BASE_ID, "failed", true, 5),
    ]) {
      const next = reduce(delivered.block, settlementWith(incoming, 20));
      expect(next.changed).toBe(false);
      expect(next.block.delivery).toEqual(
        makeDeliveryProjection(BASE_ID, "delivered", false, 0),
      );
    }

    // And the mirror: an incoming delivered at an OLDER generation still wins
    // over a stored non-delivered state.
    const failedNewer = reduce(
      streamingBlock(),
      settlementWith(makeDeliveryProjection(BASE_ID, "failed", true, 5), 10),
    );
    const deliveredOlder = reduce(
      failedNewer.block,
      settlementWith(
        makeDeliveryProjection(BASE_ID, "delivered", false, 0),
        20,
      ),
    );
    expect(deliveredOlder.changed).toBe(true);
    expect(deliveredOlder.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "delivered", false, 0),
    );
  });

  it("never decreases timestamp when delivered absorbs, in either arrival order", () => {
    // Both permutations, crossed timestamps: reconnect/replay can deliver
    // the older event after the newer one has landed. `delivered` stays
    // terminal and the block's rendered position never walks backwards.
    const pending = makeDeliveryProjection(BASE_ID, "pending", false, 0);
    const delivered = makeDeliveryProjection(BASE_ID, "delivered", false, 0);
    const orders: ReadonlyArray<{
      readonly first: InterviewDeliveryProjection;
      readonly firstAt: number;
      readonly second: InterviewDeliveryProjection;
      readonly secondAt: number;
      readonly expectChanged: boolean;
    }> = [
      {
        first: delivered,
        firstAt: 30,
        second: pending,
        secondAt: 10,
        expectChanged: false,
      },
      {
        first: pending,
        firstAt: 30,
        second: delivered,
        secondAt: 10,
        expectChanged: true,
      },
      {
        first: delivered,
        firstAt: 10,
        second: pending,
        secondAt: 30,
        expectChanged: false,
      },
      {
        first: pending,
        firstAt: 10,
        second: delivered,
        secondAt: 30,
        expectChanged: true,
      },
    ];
    for (const order of orders) {
      const cell = `${deliveryLabel(order.first)}@${String(order.firstAt)} then ${deliveryLabel(order.second)}@${String(order.secondAt)}`;
      const first = reduce(
        streamingBlock(),
        settlementWith(order.first, order.firstAt),
      );
      const second = applyInterviewSettlement(
        first.block,
        settlementWith(order.second, order.secondAt),
      );
      expect(second.changed, cell).toBe(order.expectChanged);
      expect(second.patch.delivery, cell).toEqual(delivered);
      expect(second.patch.timestamp, cell).toBeGreaterThanOrEqual(
        first.block.timestamp,
      );
      const expectedTimestamp = second.changed
        ? Math.max(order.secondAt, first.block.timestamp)
        : first.block.timestamp;
      expect(second.patch.timestamp, cell).toBe(expectedTimestamp);
    }
  });

  it("reports changed === false when the same projection is replayed under the same deliveryId", () => {
    const pending = makeDeliveryProjection(BASE_ID, "pending", false, 0);
    const first = reduce(streamingBlock(), settlementWith(pending, 10));
    const replay = applyInterviewSettlement(
      first.block,
      settlementWith(pending, 99),
    );
    expect(replay.changed).toBe(false);
    expect(replay.patch.delivery).toEqual(pending);
    expect(replay.patch.timestamp).toBe(10);
  });

  it("is order-independent for the absorbing delivered rank, and for delivering vs pending", () => {
    const pending = makeDeliveryProjection(BASE_ID, "pending", false, 0);
    const delivering = makeDeliveryProjection(BASE_ID, "delivering", false, 0);
    const delivered = makeDeliveryProjection(BASE_ID, "delivered", false, 0);

    const pendingThenDelivered = reduceAll(streamingBlock(), [
      settlementWith(pending, 10),
      settlementWith(delivered, 20),
    ]);
    const deliveredThenPending = reduceAll(streamingBlock(), [
      settlementWith(delivered, 10),
      settlementWith(pending, 20),
    ]);
    expect(pendingThenDelivered.delivery).toEqual(delivered);
    expect(deliveredThenPending.delivery).toEqual(delivered);

    const pendingThenDelivering = reduceAll(streamingBlock(), [
      settlementWith(pending, 10),
      settlementWith(delivering, 20),
    ]);
    const deliveringThenPending = reduceAll(streamingBlock(), [
      settlementWith(delivering, 10),
      settlementWith(pending, 20),
    ]);
    expect(pendingThenDelivering.delivery).toEqual(delivering);
    expect(deliveringThenPending.delivery).toEqual(delivering);
  });

  it("resolves an equal generation and rank on the conservative retryability", () => {
    const firstFailed = reduce(
      streamingBlock(),
      settlementWith(makeDeliveryProjection(BASE_ID, "failed", true, 0), 10),
    );
    const equalRank = reduce(
      firstFailed.block,
      settlementWith(makeDeliveryProjection(BASE_ID, "failed", false, 0), 20),
    );
    expect(equalRank.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "failed", false, 0),
    );
  });

  it("lets a strictly newer generation win even when that is backwards by status rank", () => {
    // Already covered as failed(g0) → pending(g1). Pin the intermediate
    // states around it: delivering(g0) → pending(g1) is the same backwards
    // move from a higher rank, and delivered(g0) → pending(g1) is the
    // retry after a completed attempt of an earlier generation.
    const fromDelivering = reduce(
      reduce(
        streamingBlock(),
        settlementWith(
          makeDeliveryProjection(BASE_ID, "delivering", false, 0),
          10,
        ),
      ).block,
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 1), 20),
    );
    expect(fromDelivering.changed).toBe(true);
    expect(fromDelivering.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "pending", false, 1),
    );

    // `delivered` is the exception, and it is absorbing ACROSS generations:
    // once the provider has the answer, no later attempt bookkeeping - however
    // new - can make that untrue. This is the un-delivery hazard, and it is
    // refused structurally rather than by a rank comparison.
    const fromDelivered = reduce(
      reduce(
        streamingBlock(),
        settlementWith(
          makeDeliveryProjection(BASE_ID, "delivered", false, 0),
          10,
        ),
      ).block,
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 1), 20),
    );
    expect(fromDelivered.changed).toBe(false);
    expect(fromDelivered.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "delivered", false, 0),
    );
  });

  it("refuses a stale pending from an older generation after a newer attempt has moved on", () => {
    // The counterexample generation exists to catch: a redelivered g0
    // pending must not resurrect after g1 has already delivered or even
    // just started delivering. Same-generation pending-after-delivered
    // is covered above; this is the cross-generation form.
    const deliveredG1 = reduce(
      streamingBlock(),
      settlementWith(
        makeDeliveryProjection(BASE_ID, "delivered", false, 1),
        10,
      ),
    );
    const staleAfterDelivered = reduce(
      deliveredG1.block,
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 0), 20),
    );
    expect(staleAfterDelivered.changed).toBe(false);
    expect(staleAfterDelivered.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "delivered", false, 1),
    );

    const deliveringG1 = reduce(
      streamingBlock(),
      settlementWith(
        makeDeliveryProjection(BASE_ID, "delivering", false, 1),
        10,
      ),
    );
    const staleAfterDelivering = reduce(
      deliveringG1.block,
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 0), 20),
    );
    expect(staleAfterDelivering.changed).toBe(false);
    expect(staleAfterDelivering.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "delivering", false, 1),
    );
  });

  it("advances on a strictly higher rank at the same generation and preserves a lower one", () => {
    const ranks: ReadonlyArray<{
      readonly from: InterviewDeliveryProjection["status"];
      readonly to: InterviewDeliveryProjection["status"];
      readonly expected: InterviewDeliveryProjection["status"];
    }> = [
      { from: "pending", to: "delivering", expected: "delivering" },
      { from: "pending", to: "failed", expected: "failed" },
      { from: "pending", to: "delivered", expected: "delivered" },
      { from: "delivering", to: "failed", expected: "failed" },
      { from: "delivering", to: "delivered", expected: "delivered" },
      { from: "failed", to: "delivered", expected: "delivered" },
      { from: "delivering", to: "pending", expected: "delivering" },
      { from: "failed", to: "pending", expected: "failed" },
      { from: "failed", to: "delivering", expected: "failed" },
      { from: "delivered", to: "pending", expected: "delivered" },
      { from: "delivered", to: "delivering", expected: "delivered" },
      { from: "delivered", to: "failed", expected: "delivered" },
    ];
    for (const row of ranks) {
      const first = reduce(
        streamingBlock(),
        settlementWith(makeDeliveryProjection(BASE_ID, row.from, false, 0), 10),
      );
      const second = reduce(
        first.block,
        settlementWith(makeDeliveryProjection(BASE_ID, row.to, false, 0), 20),
      );
      expect(second.block.delivery).toEqual(
        makeDeliveryProjection(BASE_ID, row.expected, false, 0),
      );
    }
  });

  it("converges equal-rank conflicting retryability on the conservative fact, in both orders", () => {
    // `retryable: false` is the more terminal claim - it says no automatic
    // retry is coming - so it wins whichever side it arrived on. Preferring
    // "whatever landed first" would let two peers converge on DIFFERENT states
    // from the same pair of updates, and would sometimes promise a retry the
    // outbox had already ruled out.
    const trueFirst = reduce(
      reduce(
        streamingBlock(),
        settlementWith(makeDeliveryProjection(BASE_ID, "failed", true, 1), 10),
      ).block,
      settlementWith(makeDeliveryProjection(BASE_ID, "failed", false, 1), 20),
    );
    expect(trueFirst.changed).toBe(true);
    expect(trueFirst.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "failed", false, 1),
    );

    const falseFirst = reduce(
      reduce(
        streamingBlock(),
        settlementWith(makeDeliveryProjection(BASE_ID, "failed", false, 1), 10),
      ).block,
      settlementWith(makeDeliveryProjection(BASE_ID, "failed", true, 1), 20),
    );
    expect(falseFirst.changed).toBe(false);
    expect(falseFirst.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "failed", false, 1),
    );

    // Commutative: both orders land on the same projection.
    expect(trueFirst.block.delivery).toStrictEqual(falseFirst.block.delivery);
  });

  it("never swaps a different deliveryId even when the incoming generation is newer", () => {
    // Identity beats generation. Two outbox items carry no relative order;
    // guessing would flap on reconnect. The authoritative outbox repairs
    // it on the next subscribe.
    const recorded = reduce(
      streamingBlock(),
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 0), 10),
    );
    const otherNewer = reduce(
      recorded.block,
      settlementWith(
        makeDeliveryProjection("delivery-other", "delivered", false, 9),
        20,
      ),
    );
    expect(otherNewer.changed).toBe(false);
    expect(otherNewer.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "pending", false, 0),
    );
  });

  it("converges to the same projection across permutations of one deliveryId", () => {
    const pendingG0 = makeDeliveryProjection(BASE_ID, "pending", false, 0);
    const failedG0 = makeDeliveryProjection(BASE_ID, "failed", true, 0);
    const pendingG1 = makeDeliveryProjection(BASE_ID, "pending", false, 1);
    const deliveredG1 = makeDeliveryProjection(BASE_ID, "delivered", false, 1);
    const updates: ReadonlyArray<InterviewDeliveryProjection> = [
      pendingG0,
      failedG0,
      pendingG1,
      deliveredG1,
    ];
    // Explicit permutations, not a shuffle: a random order would make a
    // broken merge flake rather than fail.
    const permutations: ReadonlyArray<
      ReadonlyArray<InterviewDeliveryProjection>
    > = [
      [pendingG0, failedG0, pendingG1, deliveredG1],
      [deliveredG1, pendingG1, failedG0, pendingG0],
      [failedG0, deliveredG1, pendingG0, pendingG1],
      [pendingG1, pendingG0, deliveredG1, failedG0],
      [deliveredG1, pendingG0, failedG0, pendingG1],
      [failedG0, pendingG1, deliveredG1, pendingG0],
    ];
    expect(permutations[0]).toEqual(updates);

    const finals = permutations.map(
      (order) =>
        reduceAll(
          streamingBlock(),
          order.map((delivery) => settlementWith(delivery, 10)),
        ).delivery,
    );
    for (const final of finals) {
      expect(final).toEqual(deliveredG1);
    }
  });

  it("does not move patch.timestamp backwards when a contributing settlement is older", () => {
    // Replay, reconnect, and reconciliation can all deliver an older
    // event after a newer one has already landed. A contributor may add
    // a delivery generation without dragging the block's rendered
    // position backwards.
    const first = reduce(
      streamingBlock(),
      settlementWith(makeDeliveryProjection(BASE_ID, "pending", false, 0), 20),
    );
    expect(first.block.timestamp).toBe(20);

    const olderAdvance = applyInterviewSettlement(
      first.block,
      settlementWith(
        makeDeliveryProjection(BASE_ID, "delivering", false, 0),
        5,
      ),
    );
    expect(olderAdvance.changed).toBe(true);
    expect(olderAdvance.patch.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "delivering", false, 0),
    );
    expect(olderAdvance.patch.timestamp).toBe(20);

    const withDiagnostic = reduce(
      first.block,
      runtimeFailed("runtime-failed", makeDiagnostic("diag-1"), 3),
    );
    expect(withDiagnostic.changed).toBe(true);
    expect(withDiagnostic.block.diagnostics).toEqual([
      makeDiagnostic("diag-1"),
    ]);
    expect(withDiagnostic.block.timestamp).toBe(20);
    expect(withDiagnostic.block.delivery).toEqual(
      makeDeliveryProjection(BASE_ID, "pending", false, 0),
    );
  });

  it("defaults generation to 0 when absent and catches a malformed generation to 0", () => {
    const absent = interviewDeliveryProjectionSchema.parse({
      deliveryId: BASE_ID,
      status: "pending",
      retryable: false,
    });
    expect(absent.generation).toBe(0);

    const negative = interviewDeliveryProjectionSchema.parse({
      deliveryId: BASE_ID,
      status: "pending",
      retryable: false,
      generation: -1,
    });
    expect(negative.generation).toBe(0);

    const malformed: Record<string, unknown> = {
      deliveryId: BASE_ID,
      status: "pending",
      retryable: false,
      generation: "next",
    };
    const notANumber = interviewDeliveryProjectionSchema.parse(malformed);
    expect(notANumber.generation).toBe(0);
  });

  it("does not let a distinct losing settlement adopt a pending delivery onto a null slot", () => {
    // mergeDelivery's first rule is "nothing recorded yet ⇒ take the incoming
    // projection". Without correlating delivery to settlement authority, a
    // GUI-answered block with `delivery: null` meeting an unrelated losing
    // runtime settlement that carried a `pending` projection would ADOPT it -
    // attaching an outbox identity that belongs to a different settlement,
    // which then becomes the id every later update is ordered against.
    const block = guiAuthoritativeBlock(null);
    const foreign = makeDeliveryProjection(
      "delivery-foreign",
      "pending",
      false,
      0,
    );
    const result = applyInterviewSettlement(
      block,
      distinctLosingRuntimeSettlement(foreign),
    );
    expect(result.changed).toBe(false);
    expect(result.patch.delivery).toBeNull();
    expect(result.patch).toStrictEqual(ownedPatch(block));
  });

  it("does not let a distinct losing settlement replace a stored projection, even at a newer generation and higher status", () => {
    // The stored-projection half of the same rule: a distinct loser carrying a
    // different id at a newer generation and a higher status still cannot
    // speak for the slot. Leave the recorded projection exactly as found -
    // not merely "some field differs from the incoming one".
    const stored = makeDeliveryProjection("delivery-1", "pending", false, 0);
    const block = guiAuthoritativeBlock(stored);
    const result = applyInterviewSettlement(
      block,
      distinctLosingRuntimeSettlement(
        makeDeliveryProjection("delivery-foreign", "delivered", false, 9),
      ),
    );
    expect(result.changed).toBe(false);
    expect(result.patch.delivery).toEqual(stored);
    expect(result.patch).toStrictEqual(ownedPatch(block));
  });

  it("still merges delivery for a same-settlementId replay and a winning first settlement", () => {
    // Correlation is about WHO may merge, not a blanket "losing settlements
    // never write delivery". A replay of the settlement already holding the
    // slot still monotone-merges its own projection, and a winner still
    // claims an unowned slot.
    const delivering = guiAuthoritativeBlock(
      makeDeliveryProjection("delivery-1", "delivering", false, 0),
    );
    const replay = applyInterviewSettlement(delivering, {
      ...guiAnswered(99),
      delivery: makeDeliveryProjection("delivery-1", "delivered", false, 0),
    });
    expect(replay.changed).toBe(true);
    expect(replay.patch.delivery).toEqual(
      makeDeliveryProjection("delivery-1", "delivered", false, 0),
    );
    expect(replay.patch.settlement).toEqual({
      settlementId: "gui-answered",
      source: "gui",
    });

    const ownDelivery = makeDeliveryProjection(
      "delivery-new",
      "pending",
      false,
      0,
    );
    const winning = applyInterviewSettlement(streamingBlock(), {
      ...runtimeAnswered("runtime-answered", [makeAnswer(["date-fns"])], 10),
      delivery: ownDelivery,
    });
    expect(winning.changed).toBe(true);
    expect(winning.patch.delivery).toEqual(ownDelivery);
    expect(winning.patch.settlement).toEqual({
      settlementId: "runtime-answered",
      source: "runtime",
    });
  });

  it("adopts a winning settlement's delivery wholesale, including a different deliveryId", () => {
    // A winner REPLACES the canonical settlement, so it brings a different
    // outbox item. Merging there is the bug this pins: stored {d1, delivered}
    // plus winning {d2, pending} keeps d1 under mergeDelivery (mismatched
    // ids), and the block goes on claiming DELIVERED for an answer the new
    // settlement has not sent.
    const stored = makeDeliveryProjection("delivery-1", "delivered", false, 0);
    const incoming = makeDeliveryProjection("delivery-2", "pending", false, 0);
    const result = applyInterviewSettlement(runtimeAuthoritativeBlock(stored), {
      ...guiAnswered(20),
      delivery: incoming,
    });
    expect(result.changed).toBe(true);
    expect(result.patch.delivery?.deliveryId).toBe("delivery-2");
    expect(result.patch.delivery).toEqual(incoming);
    expect(result.patch.settlement).toEqual({
      settlementId: "gui-answered",
      source: "gui",
    });
  });

  it("clears delivery when a winning settlement carries null", () => {
    // Same adopt-on-win rule, null included. The new settlement has no
    // outbox item; inheriting the old projection would attribute a stale
    // delivery to a fresh answer. Contrast "never lets a null delivery
    // clear an existing projection" above, which is a same-id replay
    // (MERGE, silence is not a retraction).
    const stored = makeDeliveryProjection("delivery-1", "delivered", false, 0);
    const result = applyInterviewSettlement(runtimeAuthoritativeBlock(stored), {
      ...guiAnswered(20),
      delivery: null,
    });
    expect(result.changed).toBe(true);
    expect(result.patch.delivery).toBeNull();
  });

  it("still merges rather than adopting when the same settlementId is replayed", () => {
    // Replay is the same outbox item reporting progress, so ordering
    // rules apply. Absorption (stored delivered survives an incoming
    // pending) is what an always-adopt implementation would get wrong.
    // Distinct-loser preservation is already pinned by the two tests
    // above ("does not let a distinct losing settlement adopt a pending
    // delivery onto a null slot" / "...replace a stored projection").
    const stored = makeDeliveryProjection("delivery-9", "delivered", false, 0);
    const block = guiAuthoritativeBlock(stored);
    const replay = applyInterviewSettlement(block, {
      ...guiAnswered(99),
      delivery: makeDeliveryProjection("delivery-9", "pending", false, 0),
    });
    expect(replay.patch.delivery?.deliveryId).toBe("delivery-9");
    expect(replay.patch.delivery).toEqual(stored);
    expect(replay.changed).toBe(false);
    expect(replay.patch).toStrictEqual(ownedPatch(block));
  });
});

describe("draft/outcome relation", () => {
  it("drops drafts at the boundary of a winning answered or failed settlement", () => {
    // Saved drafts exist only for an explicit Skip. A settlement that
    // resolves or fails has no such thing; carrying them would render
    // "saved" work the user never saved.
    const answered = applyInterviewSettlement(streamingBlock(), {
      ...guiAnswered(10),
      draftAnswers: [makeDraft(["lodash"])],
    });
    expect(answered.changed).toBe(true);
    expect(answered.patch.outcome).toBe("answered");
    expect(answered.patch.draftAnswers).toEqual([]);

    const failed = applyInterviewSettlement(streamingBlock(), {
      ...runtimeFailed("runtime-failed", makeDiagnostic("diag-1"), 10),
      draftAnswers: [makeDraft(["lodash"])],
    });
    expect(failed.patch.outcome).toBe("failed");
    expect(failed.patch.draftAnswers).toEqual([]);
  });

  it("clears drafts when a skipped block is later re-settled as answered by a winning GUI settlement", () => {
    // A runtime-authored Skip can yield to GUI acceptance. Without the
    // clear, the card would claim saved work alongside a submitted answer.
    const skipped = reduce(
      streamingBlock(),
      runtimeSkipped("runtime-skipped", [makeDraft(["lodash"])], 10),
    );
    expect(skipped.block.outcome).toBe("skipped");
    expect(skipped.block.draftAnswers).toEqual([makeDraft(["lodash"])]);

    const answered = applyInterviewSettlement(skipped.block, guiAnswered(20));
    expect(answered.changed).toBe(true);
    expect(answered.patch.outcome).toBe("answered");
    expect(answered.patch.answers).toEqual(guiAnswered(20).answers);
    expect(answered.patch.draftAnswers).toEqual([]);
    expect(answered.patch.settlement).toEqual({
      settlementId: "gui-answered",
      source: "gui",
    });
  });

  it("keeps drafts on a winning skipped settlement", () => {
    const skipped = applyInterviewSettlement(streamingBlock(), guiSkipped(10));
    expect(skipped.patch.outcome).toBe("skipped");
    expect(skipped.patch.draftAnswers).toEqual(guiSkipped(10).draftAnswers);
  });

  it("clears historical drafts on a losing write that still reports changed", () => {
    // Historical row: answered/failed WITH non-empty drafts. A losing
    // settlement that still reports `changed` (new diagnostic, or a delivery
    // projection) must repair drafts on that write - gating the clear on
    // `wins` left the contradiction in place indefinitely.
    const drafts = [makeDraft(["lodash"])];
    const answeredHistorical: ReducibleInterviewBlock = {
      ...streamingBlock(),
      status: "completed",
      answers: [makeAnswer(["date-fns"])],
      outcome: "answered",
      draftAnswers: drafts,
      settlement: { settlementId: "gui-answered", source: "gui" },
      timestamp: 10,
    };
    const answeredParsed = interviewBlockSchema.parse(
      historicalInterviewRow({ outcome: "answered", draftAnswers: drafts }),
    );
    expect(answeredParsed.outcome).toBe("answered");
    expect(answeredParsed.draftAnswers).toEqual(drafts);

    const answeredLosing = applyInterviewSettlement(
      answeredHistorical,
      runtimeFailed("runtime-failed", makeDiagnostic("diag-1"), 20),
    );
    expect(answeredLosing.changed).toBe(true);
    expect(answeredLosing.patch.outcome).toBe("answered");
    expect(answeredLosing.patch.draftAnswers).toEqual([]);
    expect(answeredLosing.patch.settlement).toEqual({
      settlementId: "gui-answered",
      source: "gui",
    });

    const failedHistorical: ReducibleInterviewBlock = {
      ...streamingBlock(),
      status: "errored",
      error: "adapter cleanup",
      outcome: "failed",
      draftAnswers: drafts,
      settlement: { settlementId: "runtime-failed", source: "runtime" },
      timestamp: 10,
    };
    const failedParsed = interviewBlockSchema.parse(
      historicalInterviewRow({ outcome: "failed", draftAnswers: drafts }),
    );
    expect(failedParsed.outcome).toBe("failed");
    expect(failedParsed.draftAnswers).toEqual(drafts);

    const failedLosing = applyInterviewSettlement(failedHistorical, {
      ...runtimeAnswered("runtime-other", [makeAnswer(["lodash"])], 20),
      delivery: makeDeliveryProjection("delivery-1", "pending", false, 1),
    });
    expect(failedLosing.changed).toBe(true);
    expect(failedLosing.patch.outcome).toBe("failed");
    expect(failedLosing.patch.draftAnswers).toEqual([]);
    expect(failedLosing.patch.settlement).toEqual({
      settlementId: "runtime-failed",
      source: "runtime",
    });
  });

  it("keeps drafts on a skipped block when a losing settlement reports changed", () => {
    // Contrast: drafts exist solely for an explicit Skip, so a later
    // cleanup that contributes a diagnostic must not wipe them.
    const skipped = reduce(streamingBlock(), guiSkipped(10));
    const afterError = applyInterviewSettlement(
      skipped.block,
      runtimeFailed("runtime-failed", makeDiagnostic("diag-1"), 20),
    );
    expect(afterError.changed).toBe(true);
    expect(afterError.patch.outcome).toBe("skipped");
    expect(afterError.patch.draftAnswers).toEqual(guiSkipped(10).draftAnswers);
  });
});

describe("terminal authority degradation", () => {
  it("treats a canonical outcome with null settlement as payload authority a runtime event cannot replace", () => {
    // settlement.source is a closed enum with .catch(null). A newer writer
    // adding a source value degrades provenance to null while leaving
    // outcome intact. Treating that as unowned would let any runtime
    // settlement destroy the skip.
    const drafts = [makeDraft(["lodash"])];
    const degradedSkip: ReducibleInterviewBlock = {
      ...streamingBlock(),
      status: "errored",
      error: "Not now",
      outcome: "skipped",
      draftAnswers: drafts,
      settlement: null,
      timestamp: 10,
    };
    const afterError = reduce(
      degradedSkip,
      runtimeFailed("runtime-failed", makeDiagnostic("diag-1"), 20),
    );
    expect(afterError.block.outcome).toBe("skipped");
    expect(afterError.block.answers).toEqual([]);
    expect(afterError.block.draftAnswers).toEqual(drafts);
    expect(afterError.block.error).toBe("Not now");
    expect(afterError.block.settlement).toBeNull();
    expect(afterError.block.diagnostics).toEqual([makeDiagnostic("diag-1")]);

    const afterResolved = reduce(
      afterError.block,
      runtimeAnswered("runtime-answered", [makeAnswer(["date-fns"])], 30),
    );
    expect(afterResolved.block.outcome).toBe("skipped");
    expect(afterResolved.block.answers).toEqual([]);
    expect(afterResolved.block.draftAnswers).toEqual(drafts);
    expect(afterResolved.block.settlement).toBeNull();

    const degradedAnswered: ReducibleInterviewBlock = {
      ...streamingBlock(),
      status: "completed",
      answers: [makeAnswer(["date-fns"])],
      outcome: "answered",
      settlement: null,
      timestamp: 10,
    };
    const answeredAfterRuntime = reduce(
      degradedAnswered,
      runtimeAnswered("runtime-other", [makeAnswer(["lodash"])], 20),
    );
    expect(answeredAfterRuntime.block.outcome).toBe("answered");
    expect(answeredAfterRuntime.block.answers).toEqual([
      makeAnswer(["date-fns"]),
    ]);
    expect(answeredAfterRuntime.block.settlement).toBeNull();
  });

  it("lets a runtime settlement repair a genuinely ambiguous legacy terminal block", () => {
    const ambiguous: ReducibleInterviewBlock = {
      ...streamingBlock(),
      status: "errored",
      error: "legacy error",
      outcome: null,
      settlement: null,
      timestamp: 10,
    };
    const repaired = reduce(
      ambiguous,
      runtimeAnswered("runtime-answered", [makeAnswer(["date-fns"])], 20),
    );
    expect(repaired.changed).toBe(true);
    expect(repaired.block.outcome).toBe("answered");
    expect(repaired.block.answers).toEqual([makeAnswer(["date-fns"])]);
    expect(repaired.block.settlement).toEqual({
      settlementId: "runtime-answered",
      source: "runtime",
    });
    expect(repaired.block.status).toBe("completed");
    expect(repaired.block.error).toBeNull();
  });
});

const SETTLEMENT_OWNED_BLOCK_KEYS = [
  "status",
  "answers",
  "error",
  "outcome",
  "draftAnswers",
  "settlement",
  "diagnostics",
  "delivery",
  "settlementExtensions",
] as const;

const FRAMING_BLOCK_KEYS = [
  "blockId",
  "timestamp",
  "parentBlockId",
  "type",
  "toolName",
  "title",
  "description",
  "questions",
  "metadata",
] as const;

describe("settlementExtensions clearing boundary", () => {
  it("clears a future nested settlement fact on pending fork and reports the block as open", () => {
    const settled = reduce(streamingBlock(), guiAnswered(10)).block;
    const withFuture: ReducibleInterviewBlock = {
      ...settled,
      settlementExtensions: { escalation: { level: 2 } },
    };
    const { changed, patch } = clearInterviewSettlement(withFuture, 40);
    expect(changed).toBe(true);
    expect(patch.settlementExtensions).toEqual({});
    expect(
      isInterviewBlockSettled({
        status: patch.status,
        outcome: patch.outcome,
        settlement: patch.settlement,
      }),
    ).toBe(false);
  });

  it("preserves unrelated raw keys outside the envelope after a clear overlay", () => {
    const settled = reduce(streamingBlock(), guiSkipped(10)).block;
    const withFuture: ReducibleInterviewBlock = {
      ...settled,
      settlementExtensions: { escalation: { level: 2 } },
    };
    const { patch } = clearInterviewSettlement(withFuture, 40);
    const overlaid = overlayInterviewSettlementPatch(
      {
        type: "interview",
        framing: { title: "Choose a library" },
        providerData: { native: true },
        unknownTopLevel: "keep-me",
        settlementExtensions: { escalation: { level: 2 } },
        status: withFuture.status,
        answers: withFuture.answers,
        error: withFuture.error,
        outcome: withFuture.outcome,
        draftAnswers: withFuture.draftAnswers,
        settlement: withFuture.settlement,
        diagnostics: withFuture.diagnostics,
        delivery: withFuture.delivery,
        timestamp: withFuture.timestamp,
      },
      patch,
    );
    expect(overlaid.framing).toEqual({ title: "Choose a library" });
    expect(overlaid.providerData).toEqual({ native: true });
    expect(overlaid.unknownTopLevel).toBe("keep-me");
    expect(overlaid.settlementExtensions).toEqual({});
    expect(overlaid.status).toBe("streaming");
    expect(overlaid.outcome).toBeNull();
  });

  it("carries settlementExtensions through applyInterviewSettlement unchanged", () => {
    const extensions = { escalation: { level: 2 } };
    const block: ReducibleInterviewBlock = {
      ...streamingBlock(),
      settlementExtensions: extensions,
    };
    const result = applyInterviewSettlement(block, guiAnswered(10));
    expect(result.patch.settlementExtensions).toEqual(extensions);
    expect(result.patch.settlementExtensions).toBe(extensions);
    expect(result.changed).toBe(true);
  });

  it("keeps clearInterviewSettlement exhaustive against interviewBlockSchema settlement-owned keys", () => {
    // Adding a new top-level field on the schema without classifying it here
    // fails. Classifying it as settlement-owned without teaching the clearer
    // to write it also fails. That is the loud failure a future terminal
    // settlement key needs; putting the fact in `settlementExtensions`
    // instead is how it stays invisible to this list on purpose.
    const schemaKeys = Object.keys(interviewBlockSchema.shape).sort();
    const classified = [
      ...SETTLEMENT_OWNED_BLOCK_KEYS,
      ...FRAMING_BLOCK_KEYS,
    ].sort();
    expect(schemaKeys).toEqual(classified);

    const { patch } = clearInterviewSettlement(streamingBlock(), 1);
    for (const key of SETTLEMENT_OWNED_BLOCK_KEYS) {
      expect(Object.hasOwn(patch, key)).toBe(true);
    }
    expect(patch.settlementExtensions).toEqual({});
    expect(patch.outcome).toBeNull();
    expect(patch.settlement).toBeNull();
    expect(patch.diagnostics).toEqual([]);
    expect(patch.delivery).toBeNull();
    expect(patch.answers).toEqual([]);
    expect(patch.draftAnswers).toEqual([]);
    expect(patch.error).toBeNull();
    expect(patch.status).toBe("streaming");
  });
});

describe("changed === false patch exhaustiveness", () => {
  it("returns ownedPatch(block) field-for-field whenever apply or clear reports no change", () => {
    // `changed: false` is what suppresses persist and broadcast. A field
    // omitted from the no-op patch is a field that can be silently dropped
    // (the generation-omission hole in `sameDelivery` was this class of bug).
    // Cross-product existing × incoming delivery so the guard is the algebra,
    // not a handful of pinned cells. Readable generation regressions stay
    // above; this one is the invariant.
    const universe = deliveryUniverse();
    expect(universe).toHaveLength(
      1 +
        DELIVERY_IDS.length *
          DELIVERY_STATUSES.length *
          RETRYABLE_VALUES.length *
          GENERATION_VALUES.length,
    );

    let cells = 0;
    let unchangedCells = 0;
    for (const existing of universe) {
      const block = guiAuthoritativeBlock(existing);
      for (const incoming of universe) {
        cells += 1;
        const result = applyInterviewSettlement(
          block,
          losingRuntimeSettlement(incoming),
        );
        const cell = `existing=${deliveryLabel(existing)} incoming=${deliveryLabel(incoming)}`;
        if (result.changed === false) {
          unchangedCells += 1;
          expect(result.patch, cell).toStrictEqual(ownedPatch(block));
        }
      }
    }
    expect(cells).toBe(universe.length * universe.length);
    // Vacuous-success guard: a setup that always reports changed would never
    // exercise the ownedPatch equality.
    expect(unchangedCells).toBeGreaterThan(0);
    expect(unchangedCells).toBeLessThan(cells);

    const alreadyClear = streamingBlock();
    const cleared = clearInterviewSettlement(alreadyClear, 99);
    expect(cleared.changed).toBe(false);
    expect(cleared.patch).toStrictEqual(ownedPatch(alreadyClear));
  });
});

describe("reconcileInterviewDelivery", () => {
  it("repairs a conflicting deliveryId when settlementId matches", () => {
    // The ordinary reducer cannot swap identity; this is the only path
    // allowed to, because the outbox is stating what it actually holds.
    const block = reduce(streamingBlock(), guiAnswered(10)).block;
    const authoritativeDelivery = makeDeliveryProjection(
      "delivery-repaired",
      "delivered",
      false,
      2,
    );
    const result = reconcileInterviewDelivery(block, {
      settlementId: "gui-answered",
      delivery: authoritativeDelivery,
      timestamp: 40,
    });
    expect(result.changed).toBe(true);
    expect(result.patch).toStrictEqual({
      ...ownedPatch(block),
      delivery: authoritativeDelivery,
      timestamp: 40,
    } satisfies InterviewSettlementPatch);
  });

  it("monotone-merges when settlementId and deliveryId match, refusing a backwards status", () => {
    // Authoritative about WHICH item is current is not a license to move a
    // delivery backwards. Same identity still goes through mergeDelivery.
    const delivered = reduce(streamingBlock(), {
      ...guiAnswered(10),
      delivery: makeDeliveryProjection("delivery-1", "delivered", false, 0),
    }).block;
    const refused = reconcileInterviewDelivery(delivered, {
      settlementId: "gui-answered",
      delivery: makeDeliveryProjection("delivery-1", "pending", false, 0),
      timestamp: 40,
    });
    expect(refused.changed).toBe(false);
    expect(refused.patch).toStrictEqual(ownedPatch(delivered));
    expect(refused.patch.delivery).toEqual(
      makeDeliveryProjection("delivery-1", "delivered", false, 0),
    );

    const pending = reduce(streamingBlock(), guiAnswered(10)).block;
    const advanced = reconcileInterviewDelivery(pending, {
      settlementId: "gui-answered",
      delivery: makeDeliveryProjection("delivery-1", "delivering", false, 0),
      timestamp: 40,
    });
    expect(advanced.changed).toBe(true);
    expect(advanced.patch.delivery).toEqual(
      makeDeliveryProjection("delivery-1", "delivering", false, 0),
    );
  });

  it("is a no-op when settlementId does not match", () => {
    // Reconciliation runs against whatever the block happens to hold. A
    // block that has since been re-settled is not the one this outbox item
    // describes; repairing it would attach a delivery to the wrong answer.
    const block = reduce(streamingBlock(), guiAnswered(10)).block;
    const result = reconcileInterviewDelivery(block, {
      settlementId: "other-settlement",
      delivery: makeDeliveryProjection("delivery-other", "delivered", false, 9),
      timestamp: 40,
    });
    expect(result.changed).toBe(false);
    expect(result.patch).toStrictEqual(ownedPatch(block));
  });

  it("is a no-op when the block has no settlement", () => {
    const block = streamingBlock();
    const result = reconcileInterviewDelivery(block, {
      settlementId: "gui-answered",
      delivery: makeDeliveryProjection("delivery-1", "delivered", false, 0),
      timestamp: 40,
    });
    expect(result.changed).toBe(false);
    expect(result.patch).toStrictEqual(ownedPatch(block));
  });

  it("leaves a conflicting deliveryId in place on the ordinary reducer", () => {
    // Contrast that makes reconcileInterviewDelivery necessary: apply
    // never swaps identity, even for a newer-looking delivered projection.
    const recorded = reduce(streamingBlock(), guiAnswered(10)).block;
    const conflicting = applyInterviewSettlement(recorded, {
      ...guiAnswered(10),
      delivery: makeDeliveryProjection("delivery-other", "delivered", false, 9),
      timestamp: 40,
    });
    expect(conflicting.changed).toBe(false);
    expect(conflicting.patch).toStrictEqual(ownedPatch(recorded));
    expect(conflicting.patch.delivery).toEqual(makeDelivery("pending"));
  });

  it("clears historical answered and failed drafts on a matching settlement while still repairing delivery", () => {
    // This is a write through the same persistence boundary as the reducer, so
    // it owes the same invariant: drafts exist only for an explicit Skip. A
    // historical row carrying `answered`/`failed` alongside drafts is repaired
    // here too, otherwise a block could be reconciled repeatedly and keep its
    // contradiction forever purely because the repair happened to arrive on
    // this path rather than the reducer's.
    const drafts = [makeDraft(["lodash"])];
    const authoritative = makeDeliveryProjection(
      "delivery-repaired",
      "delivered",
      false,
      2,
    );

    const answered: ReducibleInterviewBlock = {
      ...guiAuthoritativeBlock(makeDelivery("pending")),
      draftAnswers: drafts,
    };
    const answeredResult = reconcileInterviewDelivery(answered, {
      settlementId: "gui-answered",
      delivery: authoritative,
      timestamp: 99,
    });
    expect(answeredResult.changed).toBe(true);
    expect(answeredResult.patch.draftAnswers).toEqual([]);
    expect(answeredResult.patch.delivery).toEqual(authoritative);

    const failed: ReducibleInterviewBlock = {
      ...streamingBlock(),
      status: "errored",
      error: "adapter cleanup",
      outcome: "failed",
      draftAnswers: drafts,
      settlement: { settlementId: "runtime-failed", source: "runtime" },
      delivery: makeDelivery("pending"),
      timestamp: 10,
    };
    const failedResult = reconcileInterviewDelivery(failed, {
      settlementId: "runtime-failed",
      delivery: authoritative,
      timestamp: 99,
    });
    expect(failedResult.changed).toBe(true);
    expect(failedResult.patch.draftAnswers).toEqual([]);
    expect(failedResult.patch.delivery).toEqual(authoritative);
  });

  it("keeps skipped drafts when a matching settlement repairs delivery", () => {
    // Contrast: drafts exist solely for an explicit Skip, so a matching
    // delivery repair must not wipe them.
    const skipped = reduce(streamingBlock(), guiSkipped(10)).block;
    expect(skipped.draftAnswers).toEqual(guiSkipped(10).draftAnswers);

    const result = reconcileInterviewDelivery(skipped, {
      settlementId: "gui-skipped",
      delivery: makeDeliveryProjection("delivery-1", "pending", false, 0),
      timestamp: 40,
    });
    expect(result.changed).toBe(true);
    expect(result.patch.draftAnswers).toEqual(guiSkipped(10).draftAnswers);
    expect(result.patch.delivery).toEqual(
      makeDeliveryProjection("delivery-1", "pending", false, 0),
    );
  });

  it("is a strict no-op on a contradictory block when settlementId does not match", () => {
    // The no-op must stay strict - the reconciler does not repair blocks it
    // does not own, including contradictory drafts. Repairing anyway would
    // attach a delivery to the wrong answer, which is worse than leaving a
    // stale projection that the next subscribe corrects.
    const drafts = [makeDraft(["lodash"])];
    const block: ReducibleInterviewBlock = {
      ...guiAuthoritativeBlock(makeDelivery("pending")),
      draftAnswers: drafts,
    };
    const result = reconcileInterviewDelivery(block, {
      settlementId: "other-settlement",
      delivery: makeDeliveryProjection("delivery-other", "delivered", false, 9),
      timestamp: 40,
    });
    expect(result.changed).toBe(false);
    expect(result.patch.draftAnswers).toEqual(drafts);
    expect(result.patch).toStrictEqual(ownedPatch(block));
  });
});
