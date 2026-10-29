import { useMemo } from "react";
import { create } from "zustand";
import { resolveScopedHost } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import {
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { UNNAMED_HOST_LABEL } from "@/lib/host/host-name";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

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

function useChosenEnvironmentPick(): EnvironmentPick {
  return useSettingsEnvironmentPickStore(
    (state) => state.pick ?? state.defaultPick,
  );
}

/**
 * The Settings Host picker's host as a Local row. With no host to name (none
 * listed, or the pick vanished) the row names the vanished id or none, so the
 * pages still take their host arm and show their no-host state.
 */
function useHostPickerPick(): EnvironmentPick {
  const scopedHostId = useSettingsHostScopeStore((s) => s.scopedHostId);
  const { hosts, activeHostId, listsResolved, listsFailed } = useHostOptions();
  const resolved = resolveScopedHost({
    hosts,
    scopedHostId,
    activeHostId,
    listsResolved,
    listsFailed,
  });
  const hostId = resolved.host?.hostId ?? resolved.vanishedHostId ?? "";
  const hostName =
    resolved.host?.name ??
    (resolved.vanishedHostId === null ? "No host" : UNNAMED_HOST_LABEL);
  return useMemo(
    (): EnvironmentPick => ({ kind: "local", hostId, hostName }),
    [hostId, hostName],
  );
}

/**
 * The configuration the Environment group shows in this window. A build
 * without environments (`unreleased-features.ts`) has no Environment
 * dropdown: every page is the Host picker's host's own, as before the feature.
 */
export const useEnvironmentPick: () => EnvironmentPick =
  UNRELEASED_FEATURES_ENABLED ? useChosenEnvironmentPick : useHostPickerPick;
