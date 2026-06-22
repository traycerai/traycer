import { create } from "zustand";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

interface ProvidersFocusState {
  // The harness/provider to pre-select the next time the Providers settings
  // panel mounts. Set by deep-link entry points (e.g. the model picker's "Add
  // API key" CTA) and consumed once by `ProvidersRailLayout`. Stored as the
  // GUI harness id (what callers have); the panel maps it to the provider row.
  readonly focusHarnessId: GuiHarnessId | null;
  setFocusHarnessId: (harnessId: GuiHarnessId) => void;
  clearFocusHarnessId: () => void;
}

export const useProvidersFocusStore = create<ProvidersFocusState>((set) => ({
  focusHarnessId: null,
  setFocusHarnessId: (harnessId) => set({ focusHarnessId: harnessId }),
  clearFocusHarnessId: () => set({ focusHarnessId: null }),
}));
