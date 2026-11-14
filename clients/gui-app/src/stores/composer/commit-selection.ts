import type { ProviderId } from "@/components/home/data/landing-options";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";

/**
 * The single memory-aware commit funnel behind every `(harness, model)` change.
 * Reads the per-provider / per-(provider, model) memory, then drives the toolbar
 * store's combined `applyComposerSelection` so the switch restores what was last
 * used for that harness - model, thinking effort, and service tier - falling
 * back to the model's own defaults (the `""` no-carry lever) when there is no
 * history.
 *
 * - `modelSlug === null` is a provider SWITCH: resolve the provider's last
 *   model and that pair's effort/tier (`resolveHarnessSwitch`).
 * - a concrete `modelSlug` is an explicit model PICK: keep the slug, restore
 *   only that pair's effort/tier (`resolveModelSelection`).
 *
 * Shared by the picker (rail click / ⌘-digit / model row) and the registered
 * command-palette controls so every surface funnels through identical logic.
 * Reads the memory store imperatively (`getState()`); it is not a hook.
 */
export function commitSelection(
  store: ComposerToolbarStore,
  harnessId: ProviderId,
  modelSlug: string | null,
  profileId: string | null,
): void {
  // The composer's target host keys every memory read/write below - the
  // toolbar store carries it in its catalog scope, so the picker and the
  // palette funnel through the identical host without threading it.
  const state = store.getState();
  const hostId = state.catalog.hostId;
  // Committing the account already shown (a model pick, a re-click of the
  // provider) chooses no account: a default account stays a default, and the
  // pick keeps the Terminal login it stands in for.
  const accountChanged =
    harnessId !== state.selection.harnessId ||
    profileId !== state.selection.profileId;
  if (accountChanged) state.setAccountChosen(true);
  const committedProfileId =
    accountChanged || harnessId !== state.values.selection.harnessId
      ? profileId
      : state.values.selection.profileId;
  const memory = useComposerHarnessMemoryStore.getState();
  // Profile memory is independent of model memory. Record the explicit choice
  // immediately so header usage previews can follow it even while the target
  // harness's model catalog is still resolving (and before a settings emit).
  memory.recordProfileSelection(hostId, harnessId, committedProfileId);
  const resolved =
    modelSlug === null
      ? memory.resolveHarnessSwitch(hostId, harnessId)
      : {
          modelSlug,
          ...memory.resolveModelSelection(hostId, harnessId, modelSlug),
        };
  store.getState().applyComposerSelection({
    selection: {
      harnessId,
      profileId: committedProfileId,
      modelSlug: resolved.modelSlug,
    },
    reasoning: resolved.reasoningEffort ?? "",
    serviceTier: resolved.serviceTier ?? "",
  });
}

/**
 * Commits a profile-only change for the currently selected harness. Unlike
 * `commitSelection`, this path deliberately does not consult the destination
 * provider's model/effort memory: switching credentials must not discard
 * model, reasoning, or service-tier choices the user already configured.
 *
 * Shared by the model picker's profile dropdown and the chat rate-limit
 * banner, so both profile-switch surfaces preserve the same composer state.
 */
export function commitProfileSelection(
  store: ComposerToolbarStore,
  profileId: string | null,
): void {
  // An account picked by a person, even the one already shown.
  store.getState().setAccountChosen(true);
  const state = store.getState();
  const selection = { ...state.selection, profileId };
  useComposerHarnessMemoryStore
    .getState()
    .recordProfileSelection(
      state.catalog.hostId,
      selection.harnessId,
      profileId,
    );
  state.setSelection(selection);
}
