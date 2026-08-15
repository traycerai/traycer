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
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { newDraftTabIntent } from "@/lib/tab-navigation/intents";
import { activeHostIdOrNull } from "@/lib/host/runtime";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

export function openNewEpicIntent() {
  // The new draft lands on the landing surface, which follows the app-wide
  // active host - seed it from that host's last-run bucket.
  return newDraftTabIntent(
    useComposerRunSettingsStore
      .getState()
      .getGlobalRunSettings(activeHostIdOrNull()),
  );
}

export function openNewEpic(router: KeybindingRouter): void {
  router.navigateToTabIntent(openNewEpicIntent());
}
