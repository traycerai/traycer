import { useCallback, useMemo } from "react";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { getClientAppVersion } from "@/lib/app-version";
import { hostAppVersionFromDirectoryEntry } from "@/lib/host/version-skew-copy";

/**
 * What a chat tile's pre-snapshot panes need in order to offer a host update:
 * the two versions `describeVersionSkew` compares, and the one gesture that
 * takes the reader to where the update actually happens.
 */
export interface ChatTileHostUpdate {
  /** This tile's bound host, from the live directory row. `null` if unknown. */
  readonly hostAppVersion: string | null;
  readonly clientAppVersion: string | null;
  readonly openHostUpdate: () => void;
}

/**
 * The tile's host-update affordance.
 *
 * `openHostUpdate` NAVIGATES rather than updating: Settings ▸ Host is where
 * every host update is decided (`host-overview-updates.tsx` owns Update now,
 * its staged/deferred/CLI-floor states and its confirmation of the sessions a
 * restart ends), and a second trigger that dispatched `host.update.install`
 * from a tile would be a second decider on all of that. It is the same jump
 * the resource monitor, the rate-limit popover and the workspace host switcher
 * make - `carryViewedHostIntoSettingsScope` first, so the page opens scoped to
 * the host the reader was looking at rather than the app-wide one.
 *
 * The version is read from THIS TAB's host row (`useTabHostId`), never the
 * app-wide host: a tile is bound to its host for life, and on a machine with
 * several hosts the app-wide one is routinely a different, healthy build.
 */
export function useChatTileHostUpdate(): ChatTileHostUpdate {
  const tabHostId = useTabHostId();
  const hostEntry = useHostDirectoryEntry(tabHostId);
  const { openSettings } = useSystemTabModalActions();
  const openHostUpdate = useCallback(() => {
    carryViewedHostIntoSettingsScope(tabHostId);
    openSettings({ section: "host", resetToGeneral: false });
  }, [openSettings, tabHostId]);
  return useMemo(
    () => ({
      hostAppVersion: hostAppVersionFromDirectoryEntry(hostEntry),
      clientAppVersion: getClientAppVersion(),
      openHostUpdate,
    }),
    [hostEntry, openHostUpdate],
  );
}
