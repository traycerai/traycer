import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Per-host Project-scope workspace selection for provider MCP settings.
 * Avoids the B6 `folders[0]`-from-global-history misrouting: selection is
 * explicit and host-scoped.
 */
interface ProvidersWorkspaceSelectionStore {
  /** hostId → selected workspace root path */
  readonly selectedByHostId: Readonly<Record<string, string>>;
  readonly setSelected: (hostId: string, workspaceRoot: string | null) => void;
}

export const useProvidersWorkspaceSelectionStore =
  create<ProvidersWorkspaceSelectionStore>()(
    persist(
      (set) => ({
        selectedByHostId: {},
        setSelected: (hostId, workspaceRoot) => {
          set((state) => {
            const next = { ...state.selectedByHostId };
            if (workspaceRoot === null) {
              delete next[hostId];
            } else {
              next[hostId] = workspaceRoot;
            }
            return { selectedByHostId: next };
          });
        },
      }),
      {
        ...basePersistOptions(
          persistKey(STORE_KEYS.providersWorkspaceSelection),
        ),
        partialize: (state) => ({
          selectedByHostId: state.selectedByHostId,
        }),
      },
    ),
  );
