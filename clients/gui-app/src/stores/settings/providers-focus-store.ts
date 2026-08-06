import { create } from "zustand";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

interface ProvidersFocusState {
  // The host/provider/profile intent to consume the next time Providers
  // settings mounts. Simple entry points only set `focusHarnessId`; profile
  // entry points also identify the tab host and can request that the selected
  // profile's sign-in flow start immediately.
  readonly focusHarnessId: GuiHarnessId | null;
  readonly focusHostId: string | null;
  readonly focusProfileId: string | null;
  readonly startSignIn: boolean;
  setFocusHarnessId: (harnessId: GuiHarnessId) => void;
  setProfileFocus: (input: {
    readonly harnessId: GuiHarnessId;
    readonly hostId: string;
    readonly profileId: string;
    readonly startSignIn: boolean;
  }) => void;
  clearFocusHarnessId: () => void;
  // The HOST half of the intent, clearable on its own the moment the scope
  // applies it. It has to be separable: the harness / profile / tab halves are
  // consumed further down, INSIDE the host-scoped rail, which never renders
  // when the target host is unreachable. Clearing them together would mean an
  // unreachable target left the host intent armed, so every later visit to
  // Providers silently re-selected a host the user had since navigated away
  // from.
  clearFocusHostId: () => void;
  // Optional tab within that provider to open (e.g. "env", "mcp"). Consumed
  // once alongside `focusHarnessId`; ignored when the target provider does not
  // advertise the tab in `nativeCapabilities.supportedTabs`.
  readonly focusTab: string | null;
  setFocusTab: (tab: string) => void;
  clearFocusTab: () => void;
}

export const useProvidersFocusStore = create<ProvidersFocusState>((set) => ({
  focusHarnessId: null,
  focusHostId: null,
  focusProfileId: null,
  startSignIn: false,
  focusTab: null,
  setFocusHarnessId: (harnessId) =>
    set({
      focusHarnessId: harnessId,
      focusHostId: null,
      focusProfileId: null,
      startSignIn: false,
    }),
  setProfileFocus: ({ harnessId, hostId, profileId, startSignIn }) =>
    set({
      focusHarnessId: harnessId,
      focusHostId: hostId,
      focusProfileId: profileId,
      startSignIn,
    }),
  clearFocusHarnessId: () =>
    set({
      focusHarnessId: null,
      focusHostId: null,
      focusProfileId: null,
      startSignIn: false,
    }),
  clearFocusHostId: () => set({ focusHostId: null }),
  setFocusTab: (tab) => set({ focusTab: tab }),
  clearFocusTab: () => set({ focusTab: null }),
}));
