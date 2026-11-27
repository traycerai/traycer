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
 * after a window-host change. Pages read `useEnvironmentPick()`.
 *
 * The pick moves only by an act of the person, and the newest act wins.
 * `acts` counts the person's acts in this window, in memory only: every
 * `setPick` is one. A write the person did not make (`setPickUnprompted`:
 * a stale Local pick or a team that is gone becoming Personal, a computer's
 * new host id) is not, and moves no computer in. A write that waits for an
 * answer (a Host Overview following its computer, a Settings host entry)
 * counts the act that started it (`startFollow`) and writes (`followPick`)
 * only while no later act has happened, so any later act, choosing the same
 * row again included, stops it for good.
 */
interface SettingsEnvironmentPickState {
  readonly pick: EnvironmentPick | null;
  readonly defaultPick: EnvironmentPick;
  readonly defaultHostId: string | null;
  readonly acts: number;
  /** The person's act: a row, an Accept, a link or a card they pressed. */
  readonly setPick: (pick: EnvironmentPick | null) => void;
  readonly setPickUnprompted: (pick: EnvironmentPick | null) => void;
  /** Counts the act that starts a waiting write; returns its number. */
  readonly startFollow: () => number;
  /** Writes only while `act` is still the newest act. */
  readonly followPick: (act: number, pick: EnvironmentPick | null) => void;
  readonly setDefaultPick: (
    pick: EnvironmentPick,
    hostId: string | null,
  ) => void;
}

export const useSettingsEnvironmentPickStore =
  create<SettingsEnvironmentPickState>((set, get) => ({
    pick: null,
    defaultPick: UNRESOLVED_PICK,
    defaultHostId: null,
    acts: 0,
    setPick: (pick) => set((state) => ({ pick, acts: state.acts + 1 })),
    setPickUnprompted: (pick) => set({ pick }),
    startFollow: () => {
      const act = get().acts + 1;
      set({ acts: act });
      return act;
    },
    followPick: (act, pick) =>
      set((state) => (state.acts === act ? { pick } : state)),
    setDefaultPick: (defaultPick, defaultHostId) =>
      set({ defaultPick, defaultHostId }),
  }));

/** The configuration the Environment group shows in this window. */
export function useEnvironmentPick(): EnvironmentPick {
  const hostId = useEffectiveHostId();
  return useSettingsEnvironmentPickStore(
    (state) =>
      state.pick ??
      (state.defaultHostId === hostId ? state.defaultPick : UNRESOLVED_PICK),
  );
}
