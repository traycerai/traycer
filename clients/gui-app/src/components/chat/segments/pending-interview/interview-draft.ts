import type { InterviewQuestion } from "@traycer/protocol/persistence/epic/schemas";
import type { StoredInterviewDraftAnswer } from "@/stores/composer/interview-draft-store";

export interface DraftAnswer {
  // The set of selected option labels.
  selected: ReadonlySet<string>;
  // Free-text body when "Other" is selected.
  otherText: string;
  // True when "Other" is checked.
  otherSelected: boolean;
}

export function emptyDraft(): DraftAnswer {
  return { selected: new Set(), otherText: "", otherSelected: false };
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

export function draftFromStoredAnswer(
  stored: StoredInterviewDraftAnswer | undefined,
  question: InterviewQuestion,
): DraftAnswer {
  if (stored === undefined) return emptyDraft();
  const optionLabels = new Set(question.options.map((option) => option.label));
  const selected = stored.selected.filter((label) => optionLabels.has(label));
  return {
    selected: new Set(question.multiSelect ? selected : selected.slice(0, 1)),
    otherText: stored.otherText,
    otherSelected: stored.otherSelected,
  };
}

export function draftToStoredAnswer(
  draft: DraftAnswer,
): StoredInterviewDraftAnswer {
  return {
    selected: [...draft.selected],
    otherText: draft.otherText,
    otherSelected: draft.otherSelected,
  };
}

export function draftToAnswerValues(draft: DraftAnswer): ReadonlyArray<string> {
  const otherText = draft.otherText.trim();
  return draft.otherSelected && otherText.length > 0
    ? [...draft.selected, otherText]
    : [...draft.selected];
}
