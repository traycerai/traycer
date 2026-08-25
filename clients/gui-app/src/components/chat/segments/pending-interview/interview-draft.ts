import type { InterviewQuestion } from "@traycer/protocol/persistence/epic/schemas";
import type { StoredInterviewDraftAnswer } from "@/stores/composer/interview-draft-store";

export interface DraftAnswer {
  // Interaction-time option indices, not labels. Labels can repeat.
  selected: ReadonlySet<number>;
  // Old persisted drafts only carried labels. They may restore a visible
  // choice, but are never promoted into exact selection evidence.
  selectionEvidenceExact: boolean;
  // Free-text body when "Other" is selected.
  otherText: string;
  // True when "Other" is checked.
  otherSelected: boolean;
}

export function emptyDraft(): DraftAnswer {
  return {
    selected: new Set(),
    selectionEvidenceExact: true,
    otherText: "",
    otherSelected: false,
  };
}

export function replaceDraftAt(
  drafts: ReadonlyArray<DraftAnswer>,
  index: number,
  next: DraftAnswer,
): ReadonlyArray<DraftAnswer> {
  return drafts.map((draft, draftIndex) =>
    draftIndex === index ? next : draft,
  );
}

export function draftHasContent(draft: DraftAnswer): boolean {
  if (draft.selected.size > 0) return true;
  return draft.otherSelected && draft.otherText.trim().length > 0;
}

export function draftHasState(draft: DraftAnswer): boolean {
  return (
    draft.selected.size > 0 || draft.otherSelected || draft.otherText.length > 0
  );
}

export function questionIdentity(question: InterviewQuestion): string {
  return JSON.stringify([
    "question",
    question.questionId,
    question.question,
    question.header,
    question.multiSelect,
    question.options.map((option) => [
      option.label,
      option.description,
      option.preview,
    ]),
  ]);
}

function questionAssociationIdentity(question: InterviewQuestion): string {
  return question.questionId !== null && question.questionId.length > 0
    ? JSON.stringify(["question-id", question.questionId])
    : questionIdentity(question);
}

function storedQuestionAssociationIdentity(identity: string): string {
  try {
    const decoded: unknown = JSON.parse(identity);
    if (
      Array.isArray(decoded) &&
      decoded[0] === "question" &&
      typeof decoded[1] === "string" &&
      decoded[1].length > 0
    ) {
      return JSON.stringify(["question-id", decoded[1]]);
    }
  } catch {
    // A future or corrupt identity cannot prove more than exact string
    // equality, so retain it as its own association key.
  }
  return identity;
}

export function draftsFromStoredAnswers(
  storedAnswers: ReadonlyArray<StoredInterviewDraftAnswer> | undefined,
  questions: ReadonlyArray<InterviewQuestion>,
): ReadonlyArray<DraftAnswer> {
  const identities = questions.map(questionAssociationIdentity);
  const currentIdentityCounts = new Map<string, number>();
  for (const identity of identities) {
    currentIdentityCounts.set(
      identity,
      (currentIdentityCounts.get(identity) ?? 0) + 1,
    );
  }
  const storedByIdentity = new Map<
    string,
    ReadonlyArray<StoredInterviewDraftAnswer>
  >();
  for (const answer of storedAnswers ?? []) {
    const identity =
      answer.questionIdentity === undefined
        ? undefined
        : storedQuestionAssociationIdentity(answer.questionIdentity);
    if (identity === undefined) continue;
    storedByIdentity.set(identity, [
      ...(storedByIdentity.get(identity) ?? []),
      answer,
    ]);
  }

  return questions.map((question, index) => {
    if (storedAnswers === undefined) return emptyDraft();
    const identity = identities.at(index);
    if (identity === undefined) return emptyDraft();
    const matches = storedByIdentity.get(identity) ?? [];
    if (currentIdentityCounts.get(identity) === 1 && matches.length === 1) {
      return draftFromStoredAnswer(matches[0], question);
    }
    const positional = storedAnswers.at(index);
    return positional?.questionIdentity === undefined
      ? draftFromStoredAnswer(positional, question)
      : emptyDraft();
  });
}

export function draftFromStoredAnswer(
  stored: StoredInterviewDraftAnswer | undefined,
  question: InterviewQuestion,
): DraftAnswer {
  if (stored === undefined) return emptyDraft();
  const storedIndices = stored.selectedOptionIndices;
  const exactIndices =
    storedIndices === undefined ||
    stored.questionIdentity !== questionIdentity(question)
      ? null
      : (() => {
          const indices = [...new Set(storedIndices)].filter(
            (index) => index >= 0 && index < question.options.length,
          );
          const labelsStillMatch =
            indices.length === stored.selected.length &&
            indices.every((index) => {
              const option = question.options.at(index);
              return (
                option !== undefined && stored.selected.includes(option.label)
              );
            });
          return labelsStillMatch ? indices : null;
        })();
  const legacyIndices = stored.selected.flatMap((label) => {
    const matching = question.options.flatMap((option, index) =>
      option.label === label ? [index] : [],
    );
    // An old label-only row cannot prove which duplicate was selected. Keep
    // the first visible choice for editing, while keeping evidence neutral.
    return matching.length === 0 ? [] : [matching[0]];
  });
  const selected = exactIndices ?? [...new Set(legacyIndices)];
  // Enforce single-select mutual exclusivity on restore: a stored answer can
  // carry both `selected` and `otherSelected: true` (e.g. hand-edited
  // localStorage, or an older draft written before this invariant existed),
  // and restoring both would violate single-select semantics.
  const normalizedSelected =
    !question.multiSelect && stored.otherSelected ? [] : selected;
  return {
    selected: new Set(
      question.multiSelect
        ? normalizedSelected
        : normalizedSelected.slice(0, 1),
    ),
    selectionEvidenceExact: exactIndices !== null,
    otherText: stored.otherText,
    otherSelected: stored.otherSelected,
  };
}

export function draftToStoredAnswer(
  draft: DraftAnswer,
  question: InterviewQuestion,
): StoredInterviewDraftAnswer {
  return {
    questionIdentity: questionIdentity(question),
    selected: [...draft.selected].flatMap((index) => {
      const option = question.options.at(index);
      return option === undefined ? [] : [option.label];
    }),
    ...(draft.selectionEvidenceExact
      ? { selectedOptionIndices: [...draft.selected] }
      : {}),
    otherText: draft.otherText,
    otherSelected: draft.otherSelected,
  };
}

export function draftToAnswerValues(
  draft: DraftAnswer,
  question: InterviewQuestion,
): ReadonlyArray<string> {
  const otherText = draft.otherText.trim();
  const selected = [...draft.selected].flatMap((index) => {
    const option = question.options.at(index);
    return option === undefined ? [] : [option.label];
  });
  return draft.otherSelected && otherText.length > 0
    ? [...selected, otherText]
    : selected;
}
