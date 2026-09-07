/** Docs: see ./README.md */
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
