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
}

export const useProvidersFocusStore = create<ProvidersFocusState>((set) => ({
  focusHarnessId: null,
  focusHostId: null,
  focusProfileId: null,
  startSignIn: false,
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
}));
