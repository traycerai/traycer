import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

export type FolderPickerIntent =
  | { readonly kind: "prepare"; readonly folderPaths: readonly string[] }
  | { readonly kind: "createAndPrepare"; readonly path: string };

interface RemoteFolderPickerState {
  readonly open: boolean;
  /**
   * Client of the surface that requested the pick. Tabs are bound to a host
   * for life, so every browse level AND the eventual path use exactly this
   * client - the globally mounted dialog must not fall back to the app-wide
   * active host, which can be a different machine.
   */
  readonly client: HostClient<HostRpcRegistry> | null;
  /** Monotonic per-request id; keys the dialog body so its state resets. */
  readonly requestId: number;
  readonly showHiddenFolders: boolean;
  readonly setShowHiddenFolders: (showHiddenFolders: boolean) => void;
  /** Pending requester's resolver; settled exactly once per request. */
  readonly resolvePick: ((intent: FolderPickerIntent | null) => void) | null;
  /**
   * Open the picker on the requester's client and resolve with the chosen
   * host operation, or null on cancel/dismiss. A second request while one is
   * open cancels the first (resolves it null) rather than stacking dialogs.
   */
  readonly requestPick: (
    client: HostClient<HostRpcRegistry>,
  ) => Promise<FolderPickerIntent | null>;
  /** Settle the active request and close. Idempotent for a settled picker. */
  readonly settle: (intent: FolderPickerIntent | null) => void;
}

/**
 * Promise-based bridge between `pickAndPrepareFolders` (an imperative flow
 * that awaits a folder choice) and the globally mounted picker. Local and
 * remote hosts share this path so pasted paths, navigation and recents behave
 * identically on every client shell.
 */
const FOLDER_PICKER_PERSIST_KEY = persistKey(
  STORE_KEYS.folderPickerPreferences,
);

export const useRemoteFolderPickerStore = create<RemoteFolderPickerState>()(
  persist(
    (set, get) => ({
      open: false,
      client: null,
      requestId: 0,
      showHiddenFolders: false,
      resolvePick: null,
      setShowHiddenFolders: (showHiddenFolders) => set({ showHiddenFolders }),
      requestPick: (client) => {
        get().resolvePick?.(null);
        return new Promise<FolderPickerIntent | null>((resolve) => {
          set((state) => ({
            open: true,
            client,
            requestId: state.requestId + 1,
            resolvePick: resolve,
          }));
        });
      },
      settle: (selection) => {
        const { resolvePick } = get();
        set({ open: false, client: null, resolvePick: null });
        resolvePick?.(selection);
      },
    }),
    {
      ...basePersistOptions(FOLDER_PICKER_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        showHiddenFolders: state.showHiddenFolders,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        showHiddenFolders:
          typeof persistedState === "object" &&
          persistedState !== null &&
          "showHiddenFolders" in persistedState &&
          persistedState.showHiddenFolders === true,
      }),
    },
  ),
);
