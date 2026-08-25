import type {
  InterviewAnswer,
  InterviewDeliveryProjection,
  InterviewOutcome,
  InterviewQuestion,
  InterviewSettlementAuthority,
} from "@traycer/protocol/persistence/epic/schemas";

export type InterviewReviewFidelity =
  "exact" | "inferred" | "neutral" | "no-answer" | "draft";

export interface InterviewDisplayFraming {
  readonly title: string | null;
  readonly description: string | null;
}

export interface InterviewReviewInput {
  /** Stable persisted interview block identity; never user-facing text. */
  readonly blockId: string;
  readonly status: "streaming" | "completed" | "errored";
  readonly toolName: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly questions: ReadonlyArray<InterviewQuestion>;
  readonly answers: ReadonlyArray<InterviewAnswer>;
  readonly draftAnswers: ReadonlyArray<InterviewAnswer>;
  readonly outcome: InterviewOutcome | null;
  readonly settlement: InterviewSettlementAuthority | null;
  readonly error: string | null;
  readonly delivery: InterviewDeliveryProjection | null;
  readonly forkedWithoutAnswer: boolean;
}

export interface InterviewReviewPage {
  readonly question: InterviewQuestion;
  readonly fidelity: InterviewReviewFidelity;
  readonly selectedOptionIndices: ReadonlyArray<number>;
  readonly customText: string | null;
  readonly values: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}

export interface InterviewReviewFallbackAnswer {
  readonly question: string | null;
  readonly values: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly draft: boolean;
}

export interface InterviewReviewDelivery {
  readonly state: "pending" | "failed";
  readonly deliveryId: string;
  readonly generation: number;
  readonly retryable: boolean;
  readonly settlementId: string | null;
}

/**
 * A field rendered by the read-only interview card and indexed by chat find.
 * Positional identity keeps find ids stable without embedding question or
 * answer text in an attribute.
 */
export type InterviewReviewFieldKind =
  | "summary"
  | "title"
  | "description"
  | "question-header"
  | "question-text"
  | "option-label"
  | "option-description"
  | "option-preview"
  | "answer"
  | "custom"
  | "draft"
  | "note"
  | "reason"
  | "fallback-question"
  | "fallback-answer";

export interface InterviewReviewFindTarget {
  readonly fieldKind: InterviewReviewFieldKind;
  readonly questionIndex: number | null;
  readonly optionIndex: number | null;
  /** Independent positional coordinate for unassociated answer records. */
  readonly fallbackIndex: number | null;
  readonly valueIndex: number | null;
}

export interface InterviewReviewSearchField {
  readonly unitId: string;
  readonly text: string;
  readonly target: InterviewReviewFindTarget;
}

export interface InterviewReviewModel {
  readonly framing: InterviewDisplayFraming;
  readonly outcome: "answered" | "skipped" | "failed" | "unknown" | "carried";
  readonly summary: string;
  /** Outcome-aware expanded-card progress; rendering must not recalculate it. */
  readonly progress: string;
  readonly answeredCount: number;
  readonly reason: string | null;
  readonly pages: ReadonlyArray<InterviewReviewPage>;
  readonly fallbackAnswers: ReadonlyArray<InterviewReviewFallbackAnswer>;
  readonly savedDraftCount: number;
  readonly delivery: InterviewReviewDelivery | null;
  /** The single source for find indexing and read-only DOM target ids. */
  readonly searchableFields: ReadonlyArray<InterviewReviewSearchField>;
}

interface AssociatedAnswer {
  readonly answer: InterviewAnswer;
  readonly association: "selection" | "id" | "text" | "collision";
}

interface AnswerAssociationResult {
  readonly pages: ReadonlyArray<ReadonlyArray<AssociatedAnswer>>;
  readonly unassociated: ReadonlyArray<InterviewAnswer>;
}

// A title is useful only when it identifies the interview as a whole. These
// are provider/tool labels that historically leaked into the card unchanged.
// Keep the compatibility table beside the model so live and historical cards
// use the same suppression decision rather than each growing JSX exceptions.
const GENERIC_INTERVIEW_FRAMING = new Set([
  "askuserquestion",
  "requestuserinput",
  "question",
  "input needed",
  "need input",
  "needs your input",
  "codex needs your input",
  "assistant needs your input",
]);

function meaningfulText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizedFraming(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isGenericInterviewFraming(
  value: string,
  toolName: string | null,
): boolean {
  const normalized = normalizedFraming(value);
  if (GENERIC_INTERVIEW_FRAMING.has(normalized)) return true;
  return toolName !== null && normalized === normalizedFraming(toolName);
}

/**
 * Produces only human-facing interview framing. Tool names and known provider
 * boilerplate are treated as absent, leaving question headers as page-level
 * orientation instead of manufacturing a generic card title.
 */
export function displayInterviewFraming(input: {
  readonly toolName: string | null;
  readonly title: string | null;
  readonly description: string | null;
}): InterviewDisplayFraming {
  const title = meaningfulText(input.title);
  const description = meaningfulText(input.description);
  return {
    title:
      title === null || isGenericInterviewFraming(title, input.toolName)
        ? null
        : title,
    description:
      description === null ||
      isGenericInterviewFraming(description, input.toolName)
        ? null
        : description,
  };
}

function countBy<T>(
  values: ReadonlyArray<T>,
  key: (value: T) => string | null,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const valueKey = key(value);
    if (valueKey === null) continue;
    counts.set(valueKey, (counts.get(valueKey) ?? 0) + 1);
  }
  return counts;
}

function uniqueIndicesBy<T>(
  values: ReadonlyArray<T>,
  key: (value: T) => string | null,
  counts: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const indices = new Map<string, number>();
  values.forEach((value, index) => {
    const valueKey = key(value);
    if (valueKey !== null && counts.get(valueKey) === 1) {
      indices.set(valueKey, index);
    }
  });
  return indices;
}

function selectionCanTargetQuestion(
  answer: InterviewAnswer,
  question: InterviewQuestion,
  questionIndex: number,
): boolean {
  const selection = answer.selection;
  if (selection === null || selection.questionIndex !== questionIndex) {
    return false;
  }
  return (
    answer.questionId === null || answer.questionId === question.questionId
  );
}

function associateAnswers(
  questions: ReadonlyArray<InterviewQuestion>,
  answers: ReadonlyArray<InterviewAnswer>,
): AnswerAssociationResult {
  const byPage: AssociatedAnswer[][] = questions.map(() => []);
  const questionIdCounts = countBy(
    questions,
    (question) => question.questionId,
  );
  const questionTextCounts = countBy(
    questions,
    (question) => question.question,
  );
  const questionIdIndices = uniqueIndicesBy(
    questions,
    (question) => question.questionId,
    questionIdCounts,
  );
  const questionTextIndices = uniqueIndicesBy(
    questions,
    (question) => question.question,
    questionTextCounts,
  );
  const unassociated: InterviewAnswer[] = [];

  for (const answer of answers) {
    const selectedIndex = questions.findIndex((question, index) =>
      selectionCanTargetQuestion(answer, question, index),
    );
    if (selectedIndex >= 0) {
      byPage[selectedIndex]?.push({ answer, association: "selection" });
      continue;
    }

    const idIndex =
      answer.questionId === null
        ? undefined
        : questionIdIndices.get(answer.questionId);
    if (idIndex !== undefined) {
      byPage[idIndex]?.push({ answer, association: "id" });
      continue;
    }

    const textIndex =
      answer.question === null
        ? undefined
        : questionTextIndices.get(answer.question);
    if (textIndex !== undefined) {
      byPage[textIndex]?.push({ answer, association: "text" });
      continue;
    }

    // A duplicated question label establishes the collision group, but not a
    // particular page. Surface the value neutrally on every member rather than
    // selecting a control or silently dropping useful history.
    if (
      answer.question !== null &&
      (questionTextCounts.get(answer.question) ?? 0) > 1
    ) {
      questions.forEach((question, index) => {
        if (question.question === answer.question) {
          byPage[index]?.push({ answer, association: "collision" });
        }
      });
      continue;
    }

    unassociated.push(answer);
  }
  return { pages: byPage, unassociated };
}

function valuesEqual(
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function exactSelectionFor(
  answer: InterviewAnswer,
  question: InterviewQuestion,
  questionIndex: number,
): {
  readonly optionIndices: ReadonlyArray<number>;
  readonly customText: string | null;
} | null {
  if (!selectionCanTargetQuestion(answer, question, questionIndex)) return null;
  const selection = answer.selection;
  if (selection === null) return null;
  if (selection.optionIndices.length !== selection.optionLabels.length)
    return null;
  const distinctOptionIndices = new Set(selection.optionIndices);
  if (distinctOptionIndices.size !== selection.optionIndices.length)
    return null;
  const selectedLabels: string[] = [];
  for (let index = 0; index < selection.optionIndices.length; index += 1) {
    const optionIndex = selection.optionIndices.at(index);
    const option =
      optionIndex === undefined ? undefined : question.options.at(optionIndex);
    const label = selection.optionLabels.at(index);
    if (option === undefined || label === undefined || option.label !== label) {
      return null;
    }
    selectedLabels.push(label);
  }
  const expectedValues =
    selection.customText === null
      ? selectedLabels
      : [...selectedLabels, selection.customText];
  if (!valuesEqual(answer.values, expectedValues)) return null;
  return {
    optionIndices: selection.optionIndices,
    customText: selection.customText,
  };
}

function inferredOptionIndices(
  values: ReadonlyArray<string>,
  question: InterviewQuestion,
): ReadonlyArray<number> | null {
  if (values.length === 0 || question.options.length === 0) return null;
  const indices: number[] = [];
  const selected = new Set<number>();
  for (const value of values) {
    const matches = question.options.flatMap((option, index) =>
      option.label === value ? [index] : [],
    );
    const index = matches.at(0);
    if (matches.length !== 1 || index === undefined || selected.has(index)) {
      return null;
    }
    indices.push(index);
    selected.add(index);
  }
  if (!question.multiSelect && indices.length > 1) return null;
  return indices;
}

function notesFromAnswers(
  answers: ReadonlyArray<AssociatedAnswer>,
): ReadonlyArray<string> {
  return answers.flatMap(({ answer }) => {
    const note = meaningfulText(answer.notes);
    return note === null ? [] : [note];
  });
}

function pageFromAnswers(
  question: InterviewQuestion,
  questionIndex: number,
  associated: ReadonlyArray<AssociatedAnswer>,
  draft: boolean,
): InterviewReviewPage {
  const values = associated.flatMap(({ answer }) => answer.values);
  const notes = notesFromAnswers(associated);
  if (associated.length === 0 || values.length === 0) {
    return {
      question,
      fidelity: "no-answer",
      selectedOptionIndices: [],
      customText: null,
      values: [],
      notes,
    };
  }
  if (draft) {
    return {
      question,
      fidelity: "draft",
      selectedOptionIndices: [],
      customText: null,
      values,
      notes,
    };
  }

  const exact =
    associated.length === 1
      ? exactSelectionFor(associated[0].answer, question, questionIndex)
      : null;
  if (exact !== null) {
    return {
      question,
      fidelity: "exact",
      selectedOptionIndices: exact.optionIndices,
      customText: exact.customText,
      values,
      notes,
    };
  }

  const hasSelectionEvidence = associated.some(
    ({ answer }) => answer.selection !== null,
  );
  const hasCollision = associated.some(
    ({ association }) => association === "collision",
  );
  const inferred =
    !hasSelectionEvidence && !hasCollision
      ? inferredOptionIndices(values, question)
      : null;
  if (inferred !== null) {
    return {
      question,
      fidelity: "inferred",
      selectedOptionIndices: inferred,
      customText: null,
      values,
      notes,
    };
  }
  return {
    question,
    fidelity: "neutral",
    selectedOptionIndices: [],
    customText: null,
    values,
    notes,
  };
}

function fallbackAnswers(
  answers: ReadonlyArray<InterviewAnswer>,
  draft: boolean,
): ReadonlyArray<InterviewReviewFallbackAnswer> {
  return answers.flatMap((answer) => {
    if (answer.values.length === 0) return [];
    const note = meaningfulText(answer.notes);
    return [
      {
        question: meaningfulText(answer.question),
        values: answer.values,
        notes: note === null ? [] : [note],
        draft,
      },
    ];
  });
}

function outcomeFor(
  input: InterviewReviewInput,
): InterviewReviewModel["outcome"] {
  if (input.outcome !== null) return input.outcome;
  if (input.forkedWithoutAnswer) return "carried";
  if (
    input.status === "completed" &&
    input.answers.some((answer) => answer.values.length > 0)
  ) {
    return "answered";
  }
  return "unknown";
}

function savedDraftCount(drafts: ReadonlyArray<InterviewAnswer>): number {
  return drafts.filter((answer) => answer.values.length > 0).length;
}

function answeredCount(pages: ReadonlyArray<InterviewReviewPage>): number {
  return pages.filter(
    (page) => page.values.length > 0 && page.fidelity !== "draft",
  ).length;
}

function answeredSummary(answered: number, total: number): string {
  if (answered === total) {
    return `Answered ${answered} ${answered === 1 ? "question" : "questions"}`;
  }
  return `Answered ${answered} of ${total} questions`;
}

function answeredProgress(answered: number, total: number): string {
  return `Answered ${answered} of ${total}`;
}

function deliveryFor(
  delivery: InterviewDeliveryProjection | null,
  settlement: InterviewSettlementAuthority | null,
  forkedWithoutAnswer: boolean,
): InterviewReviewDelivery | null {
  if (
    forkedWithoutAnswer ||
    delivery === null ||
    delivery.status === "delivered"
  ) {
    return null;
  }
  return {
    state: delivery.status === "failed" ? "failed" : "pending",
    deliveryId: delivery.deliveryId,
    generation: delivery.generation,
    retryable: delivery.retryable,
    settlementId: settlement?.settlementId ?? null,
  };
}

function findUnitId(
  blockId: string,
  target: InterviewReviewFindTarget,
): string {
  const question =
    target.questionIndex === null
      ? "block"
      : `question:${target.questionIndex}`;
  const option =
    target.optionIndex === null ? "" : `:option:${target.optionIndex}`;
  const fallback =
    target.fallbackIndex === null ? "" : `:fallback:${target.fallbackIndex}`;
  const value = target.valueIndex === null ? "" : `:value:${target.valueIndex}`;
  return `interview:${blockId}:${question}:${target.fieldKind}${option}${fallback}${value}`;
}

function reviewSearchFields(input: {
  readonly blockId: string;
  readonly framing: InterviewDisplayFraming;
  readonly summary: string;
  readonly pages: ReadonlyArray<InterviewReviewPage>;
  readonly fallbackAnswers: ReadonlyArray<InterviewReviewFallbackAnswer>;
  readonly reason: string | null;
}): ReadonlyArray<InterviewReviewSearchField> {
  const fields: InterviewReviewSearchField[] = [];
  const add = (
    text: string | null,
    target: Omit<InterviewReviewFindTarget, "fallbackIndex">,
  ): void => {
    const visibleText = meaningfulText(text);
    if (visibleText === null) return;
    fields.push({
      unitId: findUnitId(input.blockId, { ...target, fallbackIndex: null }),
      text: visibleText,
      target: { ...target, fallbackIndex: null },
    });
  };
  const addFallback = (
    text: string | null,
    target: Omit<InterviewReviewFindTarget, "fallbackIndex">,
    fallbackIndex: number,
  ): void => {
    const visibleText = meaningfulText(text);
    if (visibleText === null) return;
    const fullTarget = { ...target, fallbackIndex };
    fields.push({
      unitId: findUnitId(input.blockId, fullTarget),
      text: visibleText,
      target: fullTarget,
    });
  };

  add(input.summary, {
    fieldKind: "summary",
    questionIndex: null,
    optionIndex: null,
    valueIndex: null,
  });
  add(input.framing.title, {
    fieldKind: "title",
    questionIndex: null,
    optionIndex: null,
    valueIndex: null,
  });
  add(input.framing.description, {
    fieldKind: "description",
    questionIndex: null,
    optionIndex: null,
    valueIndex: null,
  });

  input.pages.forEach((page, questionIndex) => {
    add(page.question.header, {
      fieldKind: "question-header",
      questionIndex,
      optionIndex: null,
      valueIndex: null,
    });
    add(page.question.question, {
      fieldKind: "question-text",
      questionIndex,
      optionIndex: null,
      valueIndex: null,
    });
    page.question.options.forEach((option, optionIndex) => {
      add(option.label, {
        fieldKind: "option-label",
        questionIndex,
        optionIndex,
        valueIndex: null,
      });
      add(option.description, {
        fieldKind: "option-description",
        questionIndex,
        optionIndex,
        valueIndex: null,
      });
      add(option.preview, {
        fieldKind: "option-preview",
        questionIndex,
        optionIndex,
        valueIndex: null,
      });
    });

    const valuesRenderAsEvidence =
      page.fidelity === "draft" ||
      page.fidelity === "neutral" ||
      ((page.fidelity === "exact" || page.fidelity === "inferred") &&
        page.question.options.length === 0);
    if (valuesRenderAsEvidence) {
      page.values.forEach((value, valueIndex) => {
        add(value, {
          fieldKind: page.fidelity === "draft" ? "draft" : "answer",
          questionIndex,
          optionIndex: null,
          valueIndex,
        });
      });
    }
    if (page.customText !== null && page.question.options.length > 0) {
      add(page.customText, {
        fieldKind: "custom",
        questionIndex,
        optionIndex: null,
        valueIndex: null,
      });
    }
    page.notes.forEach((note, valueIndex) => {
      add(note, {
        fieldKind: "note",
        questionIndex,
        optionIndex: null,
        valueIndex,
      });
    });
  });

  input.fallbackAnswers.forEach((answer, fallbackIndex) => {
    addFallback(
      answer.question,
      {
        fieldKind: "fallback-question",
        questionIndex: null,
        optionIndex: null,
        valueIndex: null,
      },
      fallbackIndex,
    );
    answer.values.forEach((value, valueIndex) => {
      addFallback(
        value,
        {
          fieldKind: "fallback-answer",
          questionIndex: null,
          optionIndex: null,
          valueIndex,
        },
        fallbackIndex,
      );
    });
    answer.notes.forEach((note, noteIndex) => {
      addFallback(
        note,
        {
          fieldKind: "note",
          questionIndex: null,
          optionIndex: null,
          valueIndex: noteIndex,
        },
        fallbackIndex,
      );
    });
  });
  add(input.reason, {
    fieldKind: "reason",
    questionIndex: null,
    optionIndex: null,
    valueIndex: null,
  });
  return fields;
}

function summaryFor(input: {
  readonly outcome: InterviewReviewModel["outcome"];
  readonly answered: number;
  readonly total: number;
  readonly drafts: number;
  readonly delivery: InterviewReviewDelivery | null;
}): string {
  const base = (() => {
    switch (input.outcome) {
      case "answered":
        return answeredSummary(input.answered, input.total);
      case "skipped":
        return input.drafts === 0
          ? "Interview skipped"
          : `Interview skipped · ${input.drafts} ${input.drafts === 1 ? "draft" : "drafts"} saved`;
      case "failed":
        return "Interview failed";
      case "carried":
        return "Question carried from the original agent — not answered here";
      case "unknown":
        return "Not answered";
    }
  })();
  if (input.delivery === null) return base;
  if (input.delivery.state === "pending" && input.outcome === "answered") {
    return "Answer saved · Delivery pending";
  }
  return `${base} · Delivery ${input.delivery.state}`;
}

function progressFor(input: {
  readonly outcome: InterviewReviewModel["outcome"];
  readonly answered: number;
  readonly total: number;
  readonly drafts: number;
}): string {
  switch (input.outcome) {
    case "answered":
      return answeredProgress(input.answered, input.total);
    case "skipped":
      return input.drafts === 0
        ? "Not answered"
        : `${input.drafts} ${input.drafts === 1 ? "draft" : "drafts"} saved`;
    case "failed":
      return "Interview failed";
    case "carried":
      return "Not answered here";
    case "unknown":
      return "Not answered";
  }
}

/**
 * Pure, evidence-first review projection. Rendering reads only this model so
 * historical cards cannot accidentally turn ambiguous flattened values into
 * editable or selected controls.
 */
export function deriveInterviewReviewModel(
  input: InterviewReviewInput,
): InterviewReviewModel {
  const submitted = associateAnswers(input.questions, input.answers);
  const drafts = associateAnswers(input.questions, input.draftAnswers);
  const pages = input.questions.map((question, index) => {
    const draftForPage = drafts.pages[index] ?? [];
    const submittedForPage = submitted.pages[index] ?? [];
    return draftForPage.some(({ answer }) => answer.values.length > 0)
      ? pageFromAnswers(question, index, draftForPage, true)
      : pageFromAnswers(question, index, submittedForPage, false);
  });
  const fallback = [
    ...fallbackAnswers(submitted.unassociated, false),
    ...fallbackAnswers(drafts.unassociated, true),
  ];
  const outcome = outcomeFor(input);
  const draftCount = savedDraftCount(input.draftAnswers);
  const fallbackAnsweredCount = fallback.filter(
    (answer) => !answer.draft && answer.values.length > 0,
  ).length;
  const total =
    input.questions.length > 0 ? input.questions.length : fallbackAnsweredCount;
  const associatedAnsweredCount = answeredCount(pages);
  const currentAnsweredCount =
    input.questions.length > 0
      ? associatedAnsweredCount
      : fallbackAnsweredCount;
  const delivery = deliveryFor(
    input.delivery,
    input.settlement,
    input.forkedWithoutAnswer,
  );
  const framing = displayInterviewFraming(input);
  const summary = summaryFor({
    outcome,
    answered: currentAnsweredCount,
    total,
    drafts: draftCount,
    delivery,
  });
  const reason = meaningfulText(input.error);
  return {
    framing,
    outcome,
    summary,
    progress: progressFor({
      outcome,
      answered: currentAnsweredCount,
      total,
      drafts: draftCount,
    }),
    answeredCount: currentAnsweredCount,
    reason,
    pages,
    fallbackAnswers: fallback,
    savedDraftCount: draftCount,
    delivery,
    searchableFields: reviewSearchFields({
      blockId: input.blockId,
      framing,
      summary,
      pages,
      fallbackAnswers: fallback,
      reason,
    }),
  };
}
