type DraftLocalEditListener = (draftId: string) => void;
type DraftLocalDeleteListener = (draftId: string) => void;
type DraftLocalFlushListener = (draftId: string) => void;

type LandingPlacementHostReader = () => string | null;

let editListener: DraftLocalEditListener | null = null;
let placementHostReader: LandingPlacementHostReader | null = null;
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

/**
 * The coordinator's landing placement host, readable by the landing store
 * so a row can be judged against the host that would write it: an own row
 * adopted on a host the placement has auto-followed away from is handled
 * like a replica - its first edit forks it onto the placement host.
 */
export function setLandingPlacementHostReader(
  next: LandingPlacementHostReader | null,
): void {
  placementHostReader = next;
}

export function landingPlacementHostId(): string | null {
  return placementHostReader?.() ?? null;
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
