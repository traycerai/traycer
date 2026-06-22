import type { UseNavigateResult } from "@tanstack/react-router";
import { openNewEpicDraft } from "@/lib/commands/actions/new-epic";
import { draftTabIntent, navigateToTabIntent } from "@/lib/tab-navigation";

type NavigateFn = UseNavigateResult<string>;

export function createDraftAndReplaceRoute(navigate: NavigateFn): void {
  const draftId = openNewEpicDraft();
  navigateToTabIntent(navigate, draftTabIntent(draftId), { replace: true });
}
