import { create } from "zustand";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

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
  /** Pending requester's resolver; settled exactly once per request. */
  readonly resolvePick: ((path: string | null) => void) | null;
  /**
   * Open the picker on the requester's client and resolve with the chosen
   * absolute host path, or null on cancel/dismiss. A second request while one
   * is open cancels the first (resolves it null) rather than stacking
   * dialogs.
   */
  readonly requestPick: (
    client: HostClient<HostRpcRegistry>,
  ) => Promise<string | null>;
  /** Settle the active request and close. Idempotent for a settled picker. */
  readonly settle: (path: string | null) => void;
}

/**
 * Promise-based bridge between `pickAndPrepareFolders` (an imperative flow
 * that awaits a folder choice) and the globally mounted
 * `RemoteFolderPickerDialog`. Mirrors how the native path awaits the OS
 * dialog, so the calling flow is identical for local and remote hosts.
 */
export const useRemoteFolderPickerStore = create<RemoteFolderPickerState>(
  (set, get) => ({
    open: false,
    client: null,
    requestId: 0,
    resolvePick: null,
    requestPick: (client) => {
      get().resolvePick?.(null);
      return new Promise<string | null>((resolve) => {
        set((state) => ({
          open: true,
          client,
          requestId: state.requestId + 1,
          resolvePick: resolve,
        }));
      });
    },
    settle: (path) => {
      const { resolvePick } = get();
      set({ open: false, client: null, resolvePick: null });
      resolvePick?.(path);
    },
  }),
);
