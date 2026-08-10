import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions } from "@/lib/persist";
import type { OrchestrationBinding } from "./orchestration-binding-store";

const ORCHESTRATION_EPIC_OVERRIDES_PERSIST_KEY =
  "traycer-gui-app:orchestration-epic-overrides:v1";

interface OrchestrationEpicOverridesStore {
  readonly overridesByEpicId: Readonly<Record<string, OrchestrationBinding>>;
  readonly setEpicOverride: (
    epicId: string,
    binding: OrchestrationBinding,
  ) => void;
  readonly clearEpicOverride: (epicId: string) => void;
  readonly resetForTests: () => void;
}

/**
 * Per-epic orchestration binding overrides (G3).
 *
 * Pattern mirrors composer-run-settings-store's epic map: write-through
 * localStorage, explicit clear, resetForTests for vitest isolation.
 */
export const useOrchestrationEpicOverridesStore =
  create<OrchestrationEpicOverridesStore>()(
    persist(
      (set, get) => ({
        overridesByEpicId: {},
        setEpicOverride: (epicId, binding) => {
          set({
            overridesByEpicId: {
              ...get().overridesByEpicId,
              [epicId]: binding,
            },
          });
        },
        clearEpicOverride: (epicId) => {
          const current = get().overridesByEpicId;
          if (!Object.hasOwn(current, epicId)) return;
          const next = { ...current };
          delete next[epicId];
          set({ overridesByEpicId: next });
        },
        resetForTests: () => {
          set({ overridesByEpicId: {} });
        },
      }),
      {
        ...basePersistOptions(ORCHESTRATION_EPIC_OVERRIDES_PERSIST_KEY),
        storage: createJSONStorage(() => window.localStorage),
        partialize: (state) => ({
          overridesByEpicId: state.overridesByEpicId,
        }),
      },
    ),
  );
