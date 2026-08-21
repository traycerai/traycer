type DraftLocalEditListener = (draftId: string) => void;
type DraftLocalDeleteListener = (draftId: string) => void;
type DraftLocalFlushListener = (draftId: string) => void;

let editListener: DraftLocalEditListener | null = null;
let deleteListener: DraftLocalDeleteListener | null = null;
let flushListener: DraftLocalFlushListener | null = null;

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

export function setDraftLocalFlushListener(
  next: DraftLocalFlushListener | null,
): void {
  flushListener = next;
}

export function notifyDraftLocalEdit(draftId: string): void {
  editListener?.(draftId);
}

export function notifyDraftLocalDelete(draftId: string): void {
  deleteListener?.(draftId);
}

/** Decision #10: flush the pending upsert on draft close / reopen. */
export function notifyDraftLocalFlush(draftId: string): void {
  flushListener?.(draftId);
}
