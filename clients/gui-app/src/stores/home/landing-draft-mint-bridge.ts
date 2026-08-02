// Dependency-free leaf (mirrors `landing-draft-content` / the
// draftRuntimeRegistry wiring): the landing-draft store and the
// worktree-intent staging store live on cycle-sensitive import islands, so
// draft mint hands the blank landing's staged picks over through this bridge
// instead of importing the staging store directly (a static import re-enters
// the store graph mid-eval and leaves `landing-image-gc` with a partially
// initialized module).

type LandingDraftMintObserver = (draftId: string) => void;

let observer: LandingDraftMintObserver | null = null;

/** Registered once by the worktree-intent staging store after construction. */
export function setLandingDraftMintObserver(
  next: LandingDraftMintObserver,
): void {
  observer = next;
}

/** Called by `createDraftWithId` for every freshly minted landing draft. */
export function notifyLandingDraftMinted(draftId: string): void {
  observer?.(draftId);
}
