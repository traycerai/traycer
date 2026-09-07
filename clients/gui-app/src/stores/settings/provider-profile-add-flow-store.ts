import { create } from "zustand";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

interface ProviderProfileAddFlowState {
  readonly harnessId: GuiHarnessId | null;
  /**
   * The host to create the profile on - the id of the picker's owning tab, or `null` for the
   * app-wide default host (a picker not bound to any tab yet, e.g. the landing composer).
   */
  readonly hostId: string | null;
  readonly onProfileCreated: ((profileId: string) => void) | null;
  openForHarness: (
    harnessId: GuiHarnessId,
    hostId: string | null,
    onProfileCreated: (profileId: string) => void,
  ) => void;
  close: () => void;
}

export const useProviderProfileAddFlowStore =
  create<ProviderProfileAddFlowState>((set) => ({
    harnessId: null,
    hostId: null,
    onProfileCreated: null,
    openForHarness: (harnessId, hostId, onProfileCreated) =>
      set({ harnessId, hostId, onProfileCreated }),
    close: () => set({ harnessId: null, hostId: null, onProfileCreated: null }),
  }));
