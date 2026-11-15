import { create } from "zustand";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

export interface SwitchAccountSource {
  readonly profileId: string;
  readonly label: string;
}

interface ProviderProfileAddFlowState {
  readonly switchSource: SwitchAccountSource | null;
  readonly harnessId: GuiHarnessId | null;
  /** The host to create the profile on - the id of the picker's owning tab,
   *  or `null` for the app-wide default host (a picker not bound to any tab
   *  yet, e.g. the landing composer). Captured at the moment "Create new
   *  profile" is clicked (`harness-model-picker-panel.tsx`) so the flow host
   *  - mounted globally, outside any `<TabHostProvider>` - can resolve the
   *  SAME host scope the picker was actually browsing, never silently
   *  falling back to the renderer-default host for a tab bound elsewhere. */
  readonly hostId: string | null;
  /** Captured alongside `harnessId`/`hostId` at the same "Add a profile"
   *  click - lets the flow host jump the OPENING picker's own selection to
   *  the newly created profile once it's saved, without this globally-mounted
   *  store knowing anything about which composer/picker instance opened it. */
  readonly onProfileCreated: ((profileId: string) => void) | null;
  openForHarness: (
    harnessId: GuiHarnessId,
    hostId: string | null,
    onProfileCreated: (profileId: string) => void,
  ) => void;
  openForSwitch: (
    harnessId: GuiHarnessId,
    hostId: string,
    source: SwitchAccountSource,
    onProfileCreated: (profileId: string) => void,
  ) => void;
  close: () => void;
}

export const useProviderProfileAddFlowStore =
  create<ProviderProfileAddFlowState>((set) => ({
    switchSource: null,
    harnessId: null,
    hostId: null,
    onProfileCreated: null,
    openForHarness: (harnessId, hostId, onProfileCreated) =>
      set({ harnessId, hostId, onProfileCreated, switchSource: null }),
    openForSwitch: (harnessId, hostId, switchSource, onProfileCreated) =>
      set({ harnessId, hostId, switchSource, onProfileCreated }),
    close: () =>
      set({
        harnessId: null,
        hostId: null,
        onProfileCreated: null,
        switchSource: null,
      }),
  }));
