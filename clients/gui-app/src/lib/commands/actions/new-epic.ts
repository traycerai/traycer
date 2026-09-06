/**
 * Docs: see ./README.md
 *
 * Canonical "new epic" flow. Builds a controller-owned creation request for
 * UI callers with `useNavigate`, while keybinding dispatch and the palette use
 * the full `openNewEpic` convenience action.
 *
 * The controller creates the draft only after it captures the current selection,
 * keeping navigation cancellation able to restore the tab the user started on.
 */
import { newDraftTabIntent } from "@/lib/tab-navigation/intents";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

export function openNewEpicIntent() {
  // Resolve default settings together with the workspace when the draft is
  // created, so both use the composer's current placement host.
  return newDraftTabIntent(null);
}

export function openNewEpic(router: KeybindingRouter): void {
  router.navigateToTabIntent(openNewEpicIntent());
}
