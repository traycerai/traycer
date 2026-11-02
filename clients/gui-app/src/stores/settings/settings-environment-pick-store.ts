import { create } from "zustand";
import {
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";

/**
 * WHICH CONFIGURATION Settings ▸ Environment is showing: Personal, a team, or
 * a Local row (a computer whose settings have not moved).
 *
 * Beside `settings-host-scope-store` and independent of it: the Environment
 * dropdown picks what you edit, the Host picker what machine you look at.
 * Kept per window, as that store is, and not persisted.
 *
 * `pick` is the person's own choice in this window, `null` until they make
 * one. `defaultPick` is what the dropdown resolves without one (the Local row
 * when this window's host has one, else Personal), written by the dropdown
 * as the hosts' statuses arrive. Pages read `useEnvironmentPick()`.
 */
interface SettingsEnvironmentPickState {
  readonly pick: EnvironmentPick | null;
  readonly defaultPick: EnvironmentPick;
  readonly setPick: (pick: EnvironmentPick | null) => void;
  readonly setDefaultPick: (pick: EnvironmentPick) => void;
}

export const useSettingsEnvironmentPickStore =
  create<SettingsEnvironmentPickState>((set) => ({
    pick: null,
    defaultPick: PERSONAL_PICK,
    setPick: (pick) => set({ pick }),
    setDefaultPick: (defaultPick) => set({ defaultPick }),
  }));

/** The configuration the Environment group shows in this window. */
export function useEnvironmentPick(): EnvironmentPick {
  return useSettingsEnvironmentPickStore(
    (state) => state.pick ?? state.defaultPick,
  );
}
