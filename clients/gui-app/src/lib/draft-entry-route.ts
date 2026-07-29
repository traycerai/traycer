import type { UseNavigateResult } from "@tanstack/react-router";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { navigateToTabIntent } from "@/lib/tab-navigation";

type NavigateFn = UseNavigateResult<string>;

export function createDraftAndReplaceRoute(navigate: NavigateFn): void {
  navigateToTabIntent(navigate, openNewEpicIntent(), { replace: true });
}
