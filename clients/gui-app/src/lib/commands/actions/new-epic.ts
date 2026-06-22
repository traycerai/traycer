/**
 * Docs: see ./README.md
 *
 * Canonical "new epic" flow. Splits into a store-only step
 * (`openNewEpicDraft`) and a full step that also navigates
 * (`openNewEpic`). The store-only form is what the `+` button in
 * `epic-tab-strip.tsx` uses because it already has its own
 * TanStack `useNavigate`; the full form is what keybinding
 * dispatch / the palette use because they hold a
 * `KeybindingRouter`.
 *
 * Both callers end up creating a draft tab through
 * the same `useLandingDraftStore.getState().createDraft()` call, so the
 * tab strip's chrome stays consistent regardless of entry point.
 */
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { draftTabIntent } from "@/lib/tab-navigation/intents";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

/** Mints a new draft and returns its id. The caller is responsible for
 *  navigating to the draft's per-id route. */
export function openNewEpicDraft(): string {
  return useLandingDraftStore
    .getState()
    .createDraft(useComposerRunSettingsStore.getState().globalLastRunSettings);
}

export function openNewEpic(router: KeybindingRouter): void {
  const draftId = openNewEpicDraft();
  router.navigateToTabIntent(draftTabIntent(draftId));
}
