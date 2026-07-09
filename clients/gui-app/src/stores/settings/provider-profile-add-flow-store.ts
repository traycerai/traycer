import { create } from "zustand";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

interface ProviderProfileAddFlowState {
  readonly harnessId: GuiHarnessId | null;
  /** The host to create the profile on - the id of the picker's owning tab,
   *  or `null` for the app-wide default host (a picker not bound to any tab
   *  yet, e.g. the landing composer). Captured at the moment "Create new
   *  profile" is clicked (`harness-model-picker-panel.tsx`) so the flow host
   *  - mounted globally, outside any `<TabHostProvider>` - can resolve the
   *  SAME host scope the picker was actually browsing, never silently
   *  falling back to the renderer-default host for a tab bound elsewhere. */
  readonly hostId: string | null;
  openForHarness: (harnessId: GuiHarnessId, hostId: string | null) => void;
  close: () => void;
}

export const useProviderProfileAddFlowStore =
  create<ProviderProfileAddFlowState>((set) => ({
    harnessId: null,
    hostId: null,
    openForHarness: (harnessId, hostId) => set({ harnessId, hostId }),
    close: () => set({ harnessId: null, hostId: null }),
  }));
