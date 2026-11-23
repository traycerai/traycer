import { useCallback, useSyncExternalStore } from "react";
import { subscribeNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import {
  hostLacksEnvironmentStatus,
  isOldHostLocalPick,
  type EnvironmentPick,
  oldHostSectionShown,
  pickOffersSection,
} from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * Whether the pick is a Local row on a host that serves no `environment.status`,
 * read from that host's own negotiated manifest by its id: a Local pick names
 * a computer, which need not be the window's host or have a client yet. A
 * Personal pick is never old, whatever the window's host has negotiated, so an
 * outage never touches it.
 *
 * With no pick and no default stored for this window's host, the pick the
 * dropdown will resolve is this host's own Local row when its manifest lacks
 * `environment.status` (`localPickerRow`, version `false`), so that manifest is
 * read directly: a surface that never mounts the dropdown, such as the command
 * palette in a window that has not opened Settings, lists no page the host lacks.
 */
export function useOldHostLocalPick(): boolean {
  return useIsOldHostPick(useEnvironmentPick());
}

function useIsOldHostPick(pick: EnvironmentPick): boolean {
  const windowHostId = useEffectiveHostId();
  const getSnapshot = useCallback(
    () =>
      pick.kind === "unresolved"
        ? windowHostId !== null && hostLacksEnvironmentStatus(windowHostId)
        : isOldHostLocalPick(pick),
    [pick, windowHostId],
  );
  return useSyncExternalStore(subscribeNegotiatedManifests, getSnapshot);
}

/**
 * Whether the pick in effect offers `section`: the single answer an in-app
 * entry to a page asks before it is shown, so a link never lands on a page the
 * pick does not draw.
 */
export function useSectionOffered(section: SettingsSectionId): boolean {
  const pick = useEnvironmentPick();
  return pickOffersSection(pick, useIsOldHostPick(pick), section);
}

/**
 * The section a surface draws, and the rail highlights, for the one it holds.
 * A Local pick on an old host offers only some pages, and a link, a deep link,
 * a remembered route or a palette row can still name another: Providers is
 * drawn then, so the page the host lacks never mounts and the rail's row for
 * what is drawn is the active one.
 */
export function useDrawnSection(section: SettingsSectionId): SettingsSectionId;
export function useDrawnSection(
  section: SettingsSectionId | null,
): SettingsSectionId | null;
export function useDrawnSection(
  section: SettingsSectionId | null,
): SettingsSectionId | null {
  const oldHost = useOldHostLocalPick();
  return section !== null && oldHost && !oldHostSectionShown(section)
    ? "providers"
    : section;
}
