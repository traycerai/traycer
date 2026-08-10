import {
  useOrchestrationBindingStore,
  type OrchestrationBinding,
} from "@/stores/orchestration/orchestration-binding-store";
import { useOrchestrationEpicOverridesStore } from "@/stores/orchestration/orchestration-epic-overrides-store";

/**
 * Effective orchestration binding for a create path.
 *
 * Scope note (v1): `epic.create` from the landing composer passes
 * `epicId: null` → always the global binding. Per-epic overrides apply only
 * to chats created INSIDE an existing epic (new-conversation modal).
 *
 * When `epicId !== null` and an override is present, the override wins;
 * otherwise fall back to the global binding store.
 */
export function effectiveOrchestrationBinding(
  epicId: string | null,
): OrchestrationBinding {
  if (epicId !== null) {
    const overrides =
      useOrchestrationEpicOverridesStore.getState().overridesByEpicId;
    if (Object.hasOwn(overrides, epicId)) {
      return overrides[epicId];
    }
  }
  return useOrchestrationBindingStore.getState().binding;
}
