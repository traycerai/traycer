import { create } from "zustand";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

interface ProvidersFocusState {
  // The host/provider/profile intent to consume the next time Providers
  // settings mounts. Simple entry points only set `focusHarnessId`; profile
  // entry points also identify the tab host and can request that the selected
  // profile's sign-in flow start immediately.
  readonly focusHarnessId: GuiHarnessId | null;
  readonly focusHostId: string | null;
  /**
   * WHICH host the harness / profile / sign-in halves belong to, retained
   * until they are consumed — separate from `focusHostId`, which is only the
   * one-shot switch trigger and is cleared the moment the scope applies it.
   *
   * Splitting the two was necessary (see `clearFocusHostId`) but, on its own,
   * threw the association away: an intent whose target is unreachable or
   * plan-gated never reaches the rail that consumes the remainder, so the
   * harness / profile / `startSignIn` sat armed and HOSTLESS. Selecting any
   * other reachable host then let ITS rail consume them — opening an
   * automatic sign-in on the wrong machine whenever the profile id happened
   * to exist there too. `null` means "no host in particular" (the simple
   * entry points), which any rail may consume.
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
