import type { UseNavigateResult } from "@tanstack/react-router";
import { activateTabIntent, draftTabIntent } from "@/lib/tab-navigation";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

type NavigateFn = UseNavigateResult<string>;

/**
 * Restore a retained start-task draft from history: reopen the row (T10's
 * `openDraft` — closed:false, active, dirty+flush) then activate through the
 * tab controller so the strip item is a real activation, not a source-ref
 * that never originated there.
 */
export function openLandingDraftFromHistory(
  navigate: NavigateFn,
  draftId: string,
): void {
  useLandingDraftStore.getState().openDraft(draftId);
  activateTabIntent(navigate, draftTabIntent(draftId), undefined);
}
