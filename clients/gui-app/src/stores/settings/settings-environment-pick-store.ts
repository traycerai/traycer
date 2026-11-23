import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { create } from "zustand";
import {
  UNRESOLVED_PICK,
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
 * when this window's host has one, else Personal once it answers), written by
 * the dropdown as statuses arrive. Until then the default is unresolved.
 * The default belongs to `defaultHostId`: readers reject it synchronously
 * after a window-host change. `staleLocalHostIds` are the computers whose
 * answered status leaves no Local row: a Local pick on one reads as the
 * default and is never rewritten, so it returns with the row. Pages read
 * `useEnvironmentPick()`.
 */
interface SettingsEnvironmentPickState {
  readonly pick: EnvironmentPick | null;
  readonly defaultPick: EnvironmentPick;
  readonly defaultHostId: string | null;
  readonly staleLocalHostIds: readonly string[];
  readonly setPick: (pick: EnvironmentPick | null) => void;
  readonly setDefaultPick: (
    pick: EnvironmentPick,
    hostId: string | null,
  ) => void;
  readonly setStaleLocalHostIds: (hostIds: readonly string[]) => void;
}

export const useSettingsEnvironmentPickStore =
  create<SettingsEnvironmentPickState>((set) => ({
    pick: null,
    defaultPick: UNRESOLVED_PICK,
    defaultHostId: null,
    staleLocalHostIds: [],
    setPick: (pick) => set({ pick }),
    setDefaultPick: (defaultPick, defaultHostId) =>
      set({ defaultPick, defaultHostId }),
    setStaleLocalHostIds: (staleLocalHostIds) => set({ staleLocalHostIds }),
  }));

/** The configuration the Environment group shows in this window. */
export function useEnvironmentPick(): EnvironmentPick {
  const hostId = useEffectiveHostId();
  return useSettingsEnvironmentPickStore((state) => {
    const { pick } = state;
    const stale =
      pick !== null &&
      pick.kind === "local" &&
      state.staleLocalHostIds.includes(pick.hostId);
    if (pick !== null && !stale) return pick;
    return state.defaultHostId === hostId ? state.defaultPick : UNRESOLVED_PICK;
  });
}
