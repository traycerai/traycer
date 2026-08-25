import { describe, expect, it } from "vitest";
import type {
  InterviewAnswer,
  InterviewQuestion,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  type InterviewReviewInput,
  deriveInterviewReviewModel,
  displayInterviewFraming,
} from "@/components/chat/segments/interview-review-model";

function question(
  questionId: string | null,
  questionText: string,
  options: ReadonlyArray<string> | undefined,
  header: string | null | undefined,
): InterviewQuestion {
  const optionLabels = options ?? ["Alpha", "Beta"];
  return {
    questionId,
    question: questionText,
    header: header ?? null,
    options: optionLabels.map((label) => ({
      label,
      description: null,
      preview: null,
    })),
    multiSelect: false,
  };
}

function answer(
  values: ReadonlyArray<string>,
  overrides: Partial<InterviewAnswer> | undefined,
): InterviewAnswer {
  return {
    questionId: null,
    question: null,
    values: [...values],
    notes: null,
    selection: null,
    ...(overrides ?? {}),
  };
}

function reviewInput(
  overrides: Partial<InterviewReviewInput> | undefined,
): InterviewReviewInput {
  return {
    blockId: "interview-test-block",
    status: "completed",
    toolName: "AskUserQuestion",
    title: null,
    description: null,
    questions: [],
    answers: [],
    draftAnswers: [],
    outcome: "answered",
    settlement: null,
    error: null,
    delivery: null,
    forkedWithoutAnswer: false,
    ...(overrides ?? {}),
  };
}

describe("deriveInterviewReviewModel", () => {
  it("indexes fields with positional ids that never embed rendered text", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        title: "Deployment plan",
        description: "Pick a safe rollout.",
        questions: [
          {
            questionId: "q1",
            question: "Where should this deploy?",
            header: "Environment",
            options: [
              {
                label: "Staging",
                description: "A shared test environment",
                preview: "No production traffic",
              },
            ],
            multiSelect: false,
          },
        ],
        answers: [
          answer(["Custom region"], {
            questionId: "q1",
            question: "Where should this deploy?",
            notes: "Only after approval",
            selection: {
              questionIndex: 0,
              optionIndices: [],
              optionLabels: [],
              customText: "Custom region",
            },
          }),
        ],
      }),
    );

    expect(model.searchableFields.map((field) => field.target)).toEqual([
      {
        fieldKind: "summary",
        questionIndex: null,
        optionIndex: null,
        fallbackIndex: null,
        valueIndex: null,
      },
      {
        fieldKind: "title",
        questionIndex: null,
        optionIndex: null,
        fallbackIndex: null,
        valueIndex: null,
      },
      {
        fieldKind: "description",
        questionIndex: null,
        optionIndex: null,
        fallbackIndex: null,
        valueIndex: null,
      },
      {
        fieldKind: "question-header",
        questionIndex: 0,
        optionIndex: null,
        fallbackIndex: null,
        valueIndex: null,
      },
      {
        fieldKind: "question-text",
        questionIndex: 0,
        optionIndex: null,
        fallbackIndex: null,
        valueIndex: null,
      },
      {
        fieldKind: "option-label",
        questionIndex: 0,
        optionIndex: 0,
        fallbackIndex: null,
        valueIndex: null,
      },
      {
        fieldKind: "option-description",
        questionIndex: 0,
        optionIndex: 0,
        fallbackIndex: null,
        valueIndex: null,
      },
      {
        fieldKind: "option-preview",
        questionIndex: 0,
        optionIndex: 0,
        fallbackIndex: null,
        valueIndex: null,
      },
      {
        fieldKind: "custom",
        questionIndex: 0,
        optionIndex: null,
        fallbackIndex: null,
        valueIndex: null,
      },
      {
        fieldKind: "note",
        questionIndex: 0,
        optionIndex: null,
        fallbackIndex: null,
        valueIndex: 0,
      },
    ]);
    expect(
      model.searchableFields.every((field) =>
        field.unitId.startsWith("interview:interview-test-block:"),
      ),
    ).toBe(true);
    expect(
      model.searchableFields.every(
        (field) =>
          !field.unitId.includes("Where should this deploy?") &&
          !field.unitId.includes("Custom region") &&
          !field.unitId.includes("Staging"),
      ),
    ).toBe(true);
    expect(model.searchableFields.map((field) => field.text)).toEqual([
      "Answered 1 question",
      "Deployment plan",
      "Pick a safe rollout.",
      "Environment",
      "Where should this deploy?",
      "Staging",
      "A shared test environment",
      "No production traffic",
      "Custom region",
      "Only after approval",
    ]);
  });

  it("reconstructs exact option and custom selections from durable evidence", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [
          {
            ...question("q1", "Which mode?", ["Alpha", "Beta"], undefined),
            multiSelect: true,
          },
        ],
        answers: [
          answer(["Beta", "Custom mode"], {
            questionId: "q1",
            question: "Which mode?",
            selection: {
              questionIndex: 0,
              optionIndices: [1],
              optionLabels: ["Beta"],
              customText: "Custom mode",
            },
          }),
        ],
      }),
    );

    expect(model.pages).toMatchObject([
      {
        fidelity: "exact",
        selectedOptionIndices: [1],
        customText: "Custom mode",
        values: ["Beta", "Custom mode"],
      },
    ]);
  });

  it("uses inferred selection only for unique text and unambiguous labels", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [question("q1", "Which mode?", undefined, undefined)],
        answers: [answer(["Beta"], { question: "Which mode?" })],
      }),
    );

    expect(model.pages[0]).toMatchObject({
      fidelity: "inferred",
      selectedOptionIndices: [1],
      customText: null,
    });
  });

  it("keeps flattened multi-option values neutral for a single-select question", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [
          question("q1", "Which mode?", ["Alpha", "Beta"], undefined),
        ],
        answers: [answer(["Alpha", "Beta"], { question: "Which mode?" })],
      }),
    );

    expect(model.pages[0]).toMatchObject({
      fidelity: "neutral",
      selectedOptionIndices: [],
      values: ["Alpha", "Beta"],
    });
  });

  it("rejects exact evidence with multiple single-select channels", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [question("q1", "Which mode?", undefined, undefined)],
        answers: [
          answer(["Alpha", "Beta"], {
            questionId: "q1",
            question: "Which mode?",
            selection: {
              questionIndex: 0,
              optionIndices: [0, 1],
              optionLabels: ["Alpha", "Beta"],
              customText: null,
            },
          }),
        ],
      }),
    );

    expect(model.pages[0]).toMatchObject({
      fidelity: "neutral",
      selectedOptionIndices: [],
      values: ["Alpha", "Beta"],
    });
  });

  it("keeps one duplicate-label answer once in the neutral fallback", () => {
    const duplicateQuestions = deriveInterviewReviewModel(
      reviewInput({
        questions: [
          question("q1", "Choose a target", ["Alpha"], undefined),
          question("q2", "Choose a target", ["Beta"], undefined),
        ],
        answers: [answer(["Beta"], { question: "Choose a target" })],
      }),
    );

    expect(duplicateQuestions.pages).toMatchObject([
      { fidelity: "no-answer", selectedOptionIndices: [] },
      { fidelity: "no-answer", selectedOptionIndices: [] },
    ]);
    expect(duplicateQuestions.answeredCount).toBe(0);
    expect(duplicateQuestions.fallbackAnswers).toHaveLength(1);

    const duplicateOptions = deriveInterviewReviewModel(
      reviewInput({
        questions: [question("q1", "Choose", ["Same", "Same"], undefined)],
        answers: [answer(["Same"], { question: "Choose" })],
      }),
    );

    expect(duplicateOptions.pages[0]).toMatchObject({
      fidelity: "neutral",
      selectedOptionIndices: [],
    });
  });

  it("rejects positional exact evidence when the saved question text changed", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [question(null, "New question", ["Alpha"], undefined)],
        answers: [
          answer(["Alpha"], {
            question: "Old question",
            selection: {
              questionIndex: 0,
              optionIndices: [0],
              optionLabels: ["Alpha"],
              customText: null,
            },
          }),
        ],
      }),
    );

    expect(model.pages[0]?.fidelity).toBe("no-answer");
    expect(model.fallbackAnswers).toHaveLength(1);
  });

  it("treats a blank question id as absent positional evidence", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [question("", "New question", ["Alpha"], undefined)],
        answers: [
          answer(["Alpha"], {
            questionId: "",
            question: "Old question",
            selection: {
              questionIndex: 0,
              optionIndices: [0],
              optionLabels: ["Alpha"],
              customText: null,
            },
          }),
        ],
      }),
    );

    expect(model.pages[0]?.fidelity).toBe("no-answer");
    expect(model.fallbackAnswers).toHaveLength(1);
  });

  it("keeps unmatched answers in a neutral block-level fallback", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [question("q1", "Known question", undefined, undefined)],
        answers: [
          answer(["Unmatched value"], { question: "Unknown question" }),
        ],
      }),
    );

    expect(model.pages[0]?.fidelity).toBe("no-answer");
    expect(model.answeredCount).toBe(0);
    expect(model.summary).toBe("Answered 0 of 1 questions");
    expect(model.fallbackAnswers).toEqual([
      {
        question: "Unknown question",
        values: ["Unmatched value"],
        notes: [],
        draft: false,
      },
    ]);
  });

  it("keeps note-only unassociated evidence visible and searchable", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [question("q1", "Known question", undefined, undefined)],
        answers: [
          answer([], {
            question: "Unknown question",
            notes: "This constraint still matters",
          }),
        ],
      }),
    );

    expect(model.fallbackAnswers).toEqual([
      {
        question: "Unknown question",
        values: [],
        notes: ["This constraint still matters"],
        draft: false,
      },
    ]);
    expect(model.searchableFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "This constraint still matters" }),
      ]),
    );
  });

  it("indexes a labelled questionless fallback question as visible searchable text", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [question("q1", "Known question", undefined, undefined)],
        answers: [
          answer(["Unmatched value"], { question: "Which mode should run?" }),
        ],
      }),
    );

    expect(model.searchableFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Which mode should run?",
          target: {
            fieldKind: "fallback-question",
            questionIndex: null,
            optionIndex: null,
            fallbackIndex: 0,
            valueIndex: null,
          },
        }),
      ]),
    );
  });

  it("keeps fallback and value coordinates explicit and collision-safe", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [question("q1", "Known question", undefined, undefined)],
        answers: [
          answer(["first fallback value", "second value"], {
            question: "First unknown question",
          }),
          answer(["second fallback value"], {
            question: "Second unknown question",
          }),
        ],
      }),
    );

    const valueFields = model.searchableFields.filter(
      (field) => field.target.fieldKind === "fallback-answer",
    );
    expect(valueFields.map((field) => field.target)).toEqual([
      expect.objectContaining({ fallbackIndex: 0, valueIndex: 0 }),
      expect.objectContaining({ fallbackIndex: 0, valueIndex: 1 }),
      expect.objectContaining({ fallbackIndex: 1, valueIndex: 0 }),
    ]);
    expect(new Set(valueFields.map((field) => field.unitId)).size).toBe(
      valueFields.length,
    );
    expect(valueFields.map((field) => field.unitId)).toEqual([
      "interview:interview-test-block:block:fallback-answer:fallback:0:value:0",
      "interview:interview-test-block:block:fallback-answer:fallback:0:value:1",
      "interview:interview-test-block:block:fallback-answer:fallback:1:value:0",
    ]);
  });

  it("marks skipped saved drafts as unsent and never as submitted selections", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        outcome: "skipped",
        questions: [question("q1", "Which mode?", undefined, undefined)],
        draftAnswers: [
          answer(["Beta"], {
            questionId: "q1",
            question: "Which mode?",
            selection: {
              questionIndex: 0,
              optionIndices: [1],
              optionLabels: ["Beta"],
              customText: null,
            },
          }),
        ],
      }),
    );

    expect(model.summary).toBe("Interview skipped · 1 draft saved");
    expect(model.savedDraftCount).toBe(1);
    expect(model.pages[0]).toMatchObject({
      fidelity: "draft",
      selectedOptionIndices: [],
      customText: null,
      values: ["Beta"],
    });
  });

  it("keeps an associated note-only skipped draft visible and searchable", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        outcome: "skipped",
        questions: [question("q1", "Which mode?", undefined, undefined)],
        draftAnswers: [
          answer([], {
            questionId: "q1",
            question: "Which mode?",
            notes: "Decide after the rollout review",
          }),
        ],
      }),
    );

    expect(model.pages[0]).toMatchObject({
      fidelity: "draft",
      notes: ["Decide after the rollout review"],
    });
    expect(model.searchableFields.map((field) => field.text)).toContain(
      "Decide after the rollout review",
    );
    expect(model.savedDraftCount).toBe(1);
    expect(model.summary).toBe("Interview skipped · 1 draft saved");
  });

  it("ignores a blank draft note instead of hiding submitted evidence", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        outcome: "skipped",
        questions: [question("q1", "Which mode?", undefined, undefined)],
        answers: [
          answer(["Alpha"], {
            questionId: "q1",
            question: "Which mode?",
          }),
        ],
        draftAnswers: [
          answer([], {
            questionId: "q1",
            question: "Which mode?",
            notes: "   ",
          }),
        ],
      }),
    );

    expect(model.pages[0]).toMatchObject({
      fidelity: "inferred",
      values: ["Alpha"],
    });
    expect(model.savedDraftCount).toBe(0);
    expect(model.summary).toBe("Interview skipped");
  });

  it("does not let stale drafts hide submitted evidence for answered history", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        outcome: "answered",
        questions: [question("q1", "Which mode?", undefined, undefined)],
        answers: [answer(["Alpha"], { questionId: "q1" })],
        draftAnswers: [answer(["Beta"], { questionId: "q1" })],
      }),
    );

    expect(model.pages[0]).toMatchObject({
      fidelity: "inferred",
      values: ["Alpha"],
    });
    expect(model.fallbackAnswers).toEqual([]);
  });

  it("summarizes a canonical skip with no saved answers as skipped", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        outcome: "skipped",
        questions: [question("q1", "Which mode?", undefined, undefined)],
        answers: [],
        draftAnswers: [],
      }),
    );

    expect(model).toMatchObject({
      outcome: "skipped",
      summary: "Interview skipped",
      progress: "Not answered",
      savedDraftCount: 0,
    });
  });

  it("keeps unassociated saved drafts in the fallback with faithful count", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        outcome: "skipped",
        questions: [question("q1", "Known question", undefined, undefined)],
        draftAnswers: [
          answer(["Draft value"], {
            question: "Question from an older host",
          }),
          answer([], { question: "Empty draft" }),
        ],
      }),
    );

    expect(model.summary).toBe("Interview skipped · 1 draft saved");
    expect(model.progress).toBe("1 draft saved");
    expect(model.savedDraftCount).toBe(1);
    expect(model.fallbackAnswers).toEqual([
      {
        question: "Question from an older host",
        values: ["Draft value"],
        notes: [],
        draft: true,
      },
      {
        question: "Empty draft",
        values: [],
        notes: [],
        draft: true,
      },
    ]);
  });

  it("derives failed, ambiguous, and carried summaries without guessing", () => {
    expect(
      deriveInterviewReviewModel(
        reviewInput({ outcome: "failed", error: "Provider stopped" }),
      ),
    ).toMatchObject({
      summary: "Interview failed",
      reason: "Provider stopped",
    });

    expect(
      deriveInterviewReviewModel(
        reviewInput({
          status: "errored",
          outcome: null,
          error: "Older host returned an ambiguous error",
        }),
      ),
    ).toMatchObject({
      outcome: "unknown",
      summary: "Not answered",
      reason: "Older host returned an ambiguous error",
    });

    expect(
      deriveInterviewReviewModel(
        reviewInput({ forkedWithoutAnswer: true, outcome: null }),
      ),
    ).toMatchObject({
      outcome: "carried",
      summary: "Question carried from the original agent — not answered here",
    });

    expect(
      deriveInterviewReviewModel(
        reviewInput({ forkedWithoutAnswer: true, outcome: "failed" }),
      ),
    ).toMatchObject({
      outcome: "failed",
      summary: "Interview failed",
    });
  });

  it("suppresses contradictory legacy errors for canonical answered history", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({ outcome: "answered", error: "Stale provider error" }),
    );

    expect(model.reason).toBeNull();
    expect(model.searchableFields.map((field) => field.text)).not.toContain(
      "Stale provider error",
    );
  });

  it.each(["pending", "delivering"] as const)(
    "qualifies an answered result while delivery is %s",
    (status) => {
      const model = deriveInterviewReviewModel(
        reviewInput({
          answers: [answer(["Alpha"], undefined)],
          delivery: {
            deliveryId: "delivery-1",
            status,
            retryable: true,
            generation: 0,
          },
        }),
      );

      expect(model.summary).toBe("Answer saved · Delivery pending");
      expect(model.delivery).toEqual({
        state: "pending",
        deliveryId: "delivery-1",
        generation: 0,
        retryable: true,
        settlementId: null,
      });
    },
  );

  it("keeps failed delivery distinct from an interview failure", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        answers: [answer(["Alpha"], undefined)],
        delivery: {
          deliveryId: "delivery-2",
          status: "failed",
          retryable: true,
          generation: 1,
        },
      }),
    );

    expect(model.summary).toBe("Answered 1 question · Delivery failed");
    expect(model.outcome).toBe("answered");
    expect(model.delivery).toEqual({
      state: "failed",
      deliveryId: "delivery-2",
      generation: 1,
      retryable: true,
      settlementId: null,
    });
  });

  it("suppresses carried failed delivery while retaining settled answer history", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        forkedWithoutAnswer: true,
        questions: [question("q1", "Which mode?", ["Alpha", "Beta"], null)],
        answers: [
          answer(["Beta"], {
            questionId: "q1",
            question: "Which mode?",
          }),
        ],
        outcome: "answered",
        settlement: { settlementId: "settlement-original", source: "gui" },
        delivery: {
          deliveryId: "delivery-original",
          status: "failed",
          retryable: true,
          generation: 2,
        },
      }),
    );

    expect(model.delivery).toBeNull();
    expect(model.outcome).toBe("answered");
    expect(model.pages[0]).toMatchObject({
      values: ["Beta"],
      selectedOptionIndices: [1],
    });
    expect(model.searchableFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Which mode?" }),
        expect.objectContaining({ text: "Beta" }),
      ]),
    );
  });

  it("keeps a delivery-cleared copied history non-retryable", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        questions: [question("q1", "Which mode?", ["Alpha", "Beta"], null)],
        answers: [
          answer(["Beta"], {
            questionId: "q1",
            question: "Which mode?",
          }),
        ],
        draftAnswers: [
          answer(["Alpha"], {
            questionId: "q1",
            question: "Which mode?",
          }),
        ],
        outcome: "skipped",
        settlement: { settlementId: "settlement-original", source: "gui" },
        // Fork seeding removed source-owned provider work but deliberately
        // retained the settlement and answer history above.
        delivery: null,
        forkedWithoutAnswer: false,
      }),
    );

    expect(model.delivery).toBeNull();
    expect(model.outcome).toBe("skipped");
    expect(model.savedDraftCount).toBe(1);
    expect(model.pages[0]).toMatchObject({ values: ["Alpha"] });
  });

  it("uses labelled and unlabelled fallbacks when questions are unavailable", () => {
    const model = deriveInterviewReviewModel(
      reviewInput({
        answers: [
          answer(["Alpha"], { question: "Which mode?" }),
          answer(["Free-form response"], undefined),
        ],
      }),
    );

    expect(model.pages).toHaveLength(0);
    expect(model.summary).toBe("Answered 2 questions");
    expect(model.fallbackAnswers).toEqual([
      {
        question: "Which mode?",
        values: ["Alpha"],
        notes: [],
        draft: false,
      },
      {
        question: null,
        values: ["Free-form response"],
        notes: [],
        draft: false,
      },
    ]);
  });
});

describe("displayInterviewFraming", () => {
  it("suppresses tool and provider boilerplate while retaining question framing", () => {
    expect(
      displayInterviewFraming({
        toolName: "AskUserQuestion",
        title: "AskUserQuestion",
        description: "Codex needs your input",
      }),
    ).toEqual({ title: null, description: null });

    expect(
      displayInterviewFraming({
        toolName: "AskUserQuestion",
        title: "Deployment strategy",
        description: "Choose how the rollout should proceed.",
      }),
    ).toEqual({
      title: "Deployment strategy",
      description: "Choose how the rollout should proceed.",
    });
  });

  it("preserves distinct non-ASCII framing", () => {
    expect(
      displayInterviewFraming({
        toolName: "質問ツール",
        title: "展開戦略",
        description: "段階的な公開方法を選択してください。",
      }),
    ).toEqual({
      title: "展開戦略",
      description: "段階的な公開方法を選択してください。",
    });
  });

  it("does not equate framing that normalizes to an empty string", () => {
    expect(
      displayInterviewFraming({
        toolName: "🛠️",
        title: "🚀",
        description: null,
      }),
    ).toEqual({ title: "🚀", description: null });
  });
});
