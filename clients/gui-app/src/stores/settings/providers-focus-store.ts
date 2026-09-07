import { create } from "zustand";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

interface ProvidersFocusState {
  // The host/provider/profile intent to consume the next time Providers settings mounts.
  readonly focusHarnessId: GuiHarnessId | null;
  readonly focusHostId: string | null;
  /**
   * WHICH host the harness / profile / sign-in halves belong to, retained until they are consumed -
   * separate from `focusHostId`, which is only the one-shot switch trigger and is cleared the moment
   */
  readonly focusTargetHostId: string | null;
  readonly focusProfileId: string | null;
  readonly startSignIn: boolean;
  setFocusHarnessId: (harnessId: GuiHarnessId) => void;
  setProfileFocus: (input: {
    readonly harnessId: GuiHarnessId;
    readonly hostId: string | null;
    readonly profileId: string;
    readonly startSignIn: boolean;
  }) => void;
  clearFocusHarnessId: () => void;
  // The HOST half of the intent, clearable on its own the moment the scope applies it.
  clearFocusHostId: () => void;
  // Optional tab within that provider to open (e.g. "env", "mcp").
  readonly focusTab: string | null;
  setFocusTab: (tab: string) => void;
  clearFocusTab: () => void;
}

export const useProvidersFocusStore = create<ProvidersFocusState>((set) => ({
  focusHarnessId: null,
  focusHostId: null,
  focusTargetHostId: null,
  focusProfileId: null,
  startSignIn: false,
  focusTab: null,
  setFocusHarnessId: (harnessId) =>
    set({
      focusHarnessId: harnessId,
      focusHostId: null,
      // No host in particular: "open this provider wherever Settings is
      // pointed", so any rail may consume it.
      focusTargetHostId: null,
      focusProfileId: null,
      startSignIn: false,
    }),
  setProfileFocus: ({ harnessId, hostId, profileId, startSignIn }) =>
    set({
      focusHarnessId: harnessId,
      focusHostId: hostId,
      focusTargetHostId: hostId,
      focusProfileId: profileId,
      startSignIn,
    }),
  clearFocusHarnessId: () =>
    set({
      focusHarnessId: null,
      focusHostId: null,
      focusTargetHostId: null,
      focusProfileId: null,
      startSignIn: false,
    }),
  clearFocusHostId: () => set({ focusHostId: null }),
  setFocusTab: (tab) => set({ focusTab: tab }),
  clearFocusTab: () => set({ focusTab: null }),
}));
