import type { ProviderId } from "@/components/home/data/landing-options";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";

/**
 * The single memory-aware commit funnel behind every `(harness, model)` change.
 * Reads the per-harness / per-(harness, model) memory, then drives the toolbar
 * store's combined `applyComposerSelection` so the switch restores what was last
 * used for that harness - model, thinking effort, and service tier - falling
 * back to the model's own defaults (the `""` no-carry lever) when there is no
 * history.
 *
 * - `modelSlug === null` is a harness SWITCH: resolve the harness's last model
 *   and that pair's effort/tier (`resolveHarnessSwitch`).
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
  const memory = useComposerHarnessMemoryStore.getState();
  // Profile memory is independent of model memory. Record the explicit choice
  // immediately so header usage previews can follow it even while the target
  // harness's model catalog is still resolving (and before a settings emit).
  memory.recordProfileSelection(harnessId, profileId);
  const resolved =
    modelSlug === null
      ? memory.resolveHarnessSwitch(harnessId, profileId)
      : {
          modelSlug,
          ...memory.resolveModelSelection(harnessId, profileId, modelSlug),
        };
  store.getState().applyComposerSelection({
    selection: { harnessId, profileId, modelSlug: resolved.modelSlug },
    reasoning: resolved.reasoningEffort ?? "",
    serviceTier: resolved.serviceTier ?? "",
  });
}
