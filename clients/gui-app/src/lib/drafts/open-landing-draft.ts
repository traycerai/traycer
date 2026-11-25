import type { UseNavigateResult } from "@tanstack/react-router";
import { captureDesktopLandingDraftPress } from "@/lib/drafts/attach-desktop-landing-draft";
import { activateTabIntent, draftTabIntent } from "@/lib/tab-navigation";
import {
  captureCanonicalLandingDraft,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";

type NavigateFn = UseNavigateResult<string>;
let currentDesktopOpen: object | null = null;

/** Explicitly reopen a retained row or attach its exact desktop occurrence. */
export function openLandingDraft(navigate: NavigateFn, draftId: string): void {
  openRetainedLandingDraft({
    draftId,
    activate: () => { activateTabIntent(navigate, draftTabIntent(draftId), undefined); },
  });
}

export function openRetainedLandingDraft(input: {
  readonly draftId: string;
  readonly activate: () => void;
  readonly isCurrent?: () => boolean;
}): void {
  currentDesktopOpen = null;
  const { draftId, activate } = input;
  const { admission, isCurrent: sessionIsCurrent } = captureDesktopLandingDraftPress();
  if (input.isCurrent?.() === false) return;
  if (admission.kind === "legacy") {
    useLandingDraftStore.getState().openDraft(draftId);
    activate();
    return;
  }
  if (admission.kind !== "ready") return;
  const reference = captureCanonicalLandingDraft(draftId);
  if (reference === null) return;

  const press = {};
  currentDesktopOpen = press;
  const pathname = window.location.pathname;
  const isCurrent = (): boolean =>
    currentDesktopOpen === press && sessionIsCurrent() &&
    window.location.pathname === pathname && input.isCurrent?.() !== false;
  void admission.attach({
    references: [reference],
    activateDraftId: draftId,
    isCurrent,
  }).then((result) => {
    if (result.kind === "attached" && isCurrent()) activate();
  }).catch(() => undefined).finally(() => {
    if (currentDesktopOpen === press) currentDesktopOpen = null;
  });
}
