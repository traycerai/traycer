type DraftLocalEditListener = (draftId: string) => void;
type DraftLocalDeleteListener = (draftId: string) => void;

let editListener: DraftLocalEditListener | null = null;
let deleteListener: DraftLocalDeleteListener | null = null;

export function setDraftLocalEditListener(
  next: DraftLocalEditListener | null,
): void {
  editListener = next;
}

export function setDraftLocalDeleteListener(
  next: DraftLocalDeleteListener | null,
): void {
  deleteListener = next;
}

export function notifyDraftLocalEdit(draftId: string): void {
  editListener?.(draftId);
}

export function notifyDraftLocalDelete(draftId: string): void {
  deleteListener?.(draftId);
}
