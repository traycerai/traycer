import type { ProviderId } from "@/components/home/data/landing-options";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";

/** The single memory-aware commit funnel behind every `(harness, model)` change. */
export function commitSelection(
  store: ComposerToolbarStore,
  harnessId: ProviderId,
  modelSlug: string | null,
  profileId: string | null,
): void {
  // The composer's target host keys every memory read/write below - the toolbar store carries it in
  // its catalog scope, so the picker and the palette funnel through the identical host without
  const hostId = store.getState().catalog.hostId;
  const memory = useComposerHarnessMemoryStore.getState();
  // Profile memory is independent of model memory.
  memory.recordProfileSelection(hostId, harnessId, profileId);
  const resolved =
    modelSlug === null
      ? memory.resolveHarnessSwitch(hostId, harnessId)
      : {
          modelSlug,
          ...memory.resolveModelSelection(hostId, harnessId, modelSlug),
        };
  store.getState().applyComposerSelection({
    selection: { harnessId, profileId, modelSlug: resolved.modelSlug },
    reasoning: resolved.reasoningEffort ?? "",
    serviceTier: resolved.serviceTier ?? "",
  });
}

/** Commits a profile-only change for the currently selected harness. */
export function commitProfileSelection(
  store: ComposerToolbarStore,
  profileId: string | null,
): void {
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
