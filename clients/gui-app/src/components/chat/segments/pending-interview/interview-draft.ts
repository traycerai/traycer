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

export function draftToAnswerValues(draft: DraftAnswer): ReadonlyArray<string> {
  const otherText = draft.otherText.trim();
  return draft.otherSelected && otherText.length > 0
    ? [...draft.selected, otherText]
    : [...draft.selected];
}
