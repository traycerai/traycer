import { create } from "zustand";

/**
 * WHICH HOST SETTINGS IS ADMINISTERING - and nothing else. This is deliberately NOT the app-wide
 * active host.
 */
interface SettingsHostScopeState {
  /** `null` means "follow the active host" - not "no host". */
  readonly scopedHostId: string | null;
  /** `null` returns to following the active host. */
  readonly setScopedHostId: (hostId: string | null) => void;
}

export const useSettingsHostScopeStore = create<SettingsHostScopeState>(
  (set) => ({
    scopedHostId: null,
    setScopedHostId: (hostId) => set({ scopedHostId: hostId }),
  }),
);
