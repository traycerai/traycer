import { useCallback, useSyncExternalStore } from "react";
import { subscribeNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  isOldHostLocalPick,
  oldHostSectionShown,
} from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * Whether the pick is a Local row on a host that serves no `environment.status`,
 * read from that host's own negotiated manifest by its id: a Local pick names
 * a computer, which need not be the window's host or have a client yet. A
 * Personal pick is never old, whatever the window's host has negotiated, so an
 * outage never touches it.
 */
export function useOldHostLocalPick(): boolean {
  const pick = useEnvironmentPick();
  const getSnapshot = useCallback(() => isOldHostLocalPick(pick), [pick]);
  return useSyncExternalStore(subscribeNegotiatedManifests, getSnapshot);
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
