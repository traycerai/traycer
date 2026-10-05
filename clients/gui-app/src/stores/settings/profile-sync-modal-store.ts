import { create } from "zustand";

/**
 * Whether the Sync profiles dialog is open, and for which SOURCE host.
 *
 * The host id is read at the click that opened the dialog and never
 * re-derived: the dialog is mounted at the app root, outside any Settings host
 * scope, so moving Settings to another host re-routes nothing. In memory only.
 * It names a host of the signed-in ACCOUNT, so `EpicSessionLifecycleBridge`
 * closes it on sign-out and on a user switch.
 */
interface ProfileSyncModalState {
  readonly sourceHostId: string | null;
  readonly open: (sourceHostId: string) => void;
  readonly close: () => void;
}

export const useProfileSyncModalStore = create<ProfileSyncModalState>(
  (set) => ({
    sourceHostId: null,
    open: (sourceHostId) => set({ sourceHostId }),
    close: () => set({ sourceHostId: null }),
  }),
);
