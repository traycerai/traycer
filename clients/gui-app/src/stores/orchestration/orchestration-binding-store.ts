import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Global selection for orchestration injection at chat creation.
 *
 * Injected ONLY into `initialMessage` when a chat/epic is created — never on
 * subsequent sends. Disable with `enabled: false`.
 */
const ORCHESTRATION_BINDING_PERSIST_KEY =
  "traycer-gui-app:orchestration-binding:v1";

export interface OrchestrationBinding {
  readonly enabled: boolean;
  readonly orchestrationName: string;
  readonly roleId: string;
  /** `null` = use orchestration default model group. */
  readonly modelGroup: string | null;
}

interface OrchestrationBindingStoreState {
  readonly binding: OrchestrationBinding;
  readonly setBinding: (binding: OrchestrationBinding) => void;
  readonly setEnabled: (enabled: boolean) => void;
  readonly setOrchestrationName: (orchestrationName: string) => void;
  readonly setRoleId: (roleId: string) => void;
  readonly setModelGroup: (modelGroup: string | null) => void;
}

const DEFAULT_BINDING: OrchestrationBinding = {
  enabled: true,
  orchestrationName: "auto",
  roleId: "orchestrator",
  modelGroup: null,
};

export const useOrchestrationBindingStore =
  create<OrchestrationBindingStoreState>()(
    persist(
      (set, get) => ({
        binding: DEFAULT_BINDING,
        setBinding: (binding) => set({ binding }),
        setEnabled: (enabled) =>
          set({ binding: { ...get().binding, enabled } }),
        setOrchestrationName: (orchestrationName) =>
          set({ binding: { ...get().binding, orchestrationName } }),
        setRoleId: (roleId) => set({ binding: { ...get().binding, roleId } }),
        setModelGroup: (modelGroup) =>
          set({ binding: { ...get().binding, modelGroup } }),
      }),
      {
        name: ORCHESTRATION_BINDING_PERSIST_KEY,
        storage: createJSONStorage(() => localStorage),
        partialize: (state) => ({ binding: state.binding }),
      },
    ),
  );
