import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { create } from "zustand";
import {
  UNRESOLVED_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";

/**
 * The person's pick once this window has seen it go: a Local pick whose
 * computer answered with no Local row, or a team the person was removed from.
 * It reads as `readsAs` for the rest of the window, or the default where that
 * is `null`. A new pick clears it, so the same choice made again reads as
 * made.
 */
interface GonePick {
  readonly readsAs: EnvironmentPick | null;
}

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
 * after a window-host change. `gone` marks `pick` once it has gone, and
 * nothing rewrites the pick: it stays gone until the person picks again, even
 * if its computer has its own settings again or leaves the host list. Pages
 * read `useEnvironmentPick()`.
 */
interface SettingsEnvironmentPickState {
  readonly pick: EnvironmentPick | null;
  readonly defaultPick: EnvironmentPick;
  readonly defaultHostId: string | null;
  readonly gone: GonePick | null;
  readonly setPick: (pick: EnvironmentPick | null) => void;
  readonly setDefaultPick: (
    pick: EnvironmentPick,
    hostId: string | null,
  ) => void;
  /** Marks the current pick gone, to read as `readsAs` (`null`: the default). */
  readonly markPickGone: (readsAs: EnvironmentPick | null) => void;
}

export const useSettingsEnvironmentPickStore =
  create<SettingsEnvironmentPickState>((set) => ({
    pick: null,
    defaultPick: UNRESOLVED_PICK,
    defaultHostId: null,
    gone: null,
    setPick: (pick) => set({ pick, gone: null }),
    setDefaultPick: (defaultPick, defaultHostId) =>
      set((state) =>
        state.defaultPick === defaultPick &&
        state.defaultHostId === defaultHostId
          ? state
          : { defaultPick, defaultHostId },
      ),
    markPickGone: (readsAs) =>
      set((state) =>
        state.pick === null || state.gone?.readsAs === readsAs
          ? state
          : { gone: { readsAs } },
      ),
  }));

/**
 * What the person's pick reads as: itself, what it was marked to read as once
 * gone, or `null` for the default.
 */
export function pickReading(
  pick: EnvironmentPick | null,
  gone: GonePick | null,
): EnvironmentPick | null {
  if (pick === null) return null;
  return gone === null ? pick : gone.readsAs;
}

/** The configuration the Environment group shows in this window. */
export function useEnvironmentPick(): EnvironmentPick {
  const hostId = useEffectiveHostId();
  return useSettingsEnvironmentPickStore((state) => {
    const reading = pickReading(state.pick, state.gone);
    if (reading !== null) return reading;
    return state.defaultHostId === hostId ? state.defaultPick : UNRESOLVED_PICK;
  });
}
