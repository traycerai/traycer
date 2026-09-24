import { useCallback } from "react";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * Opens Settings ▸ Permissions on its Judge tab - the composer mode picker's
 * "Permission settings…" item, on desktop and in the phone sheet alike.
 *
 * The Judge tab rather than the page's default because the picker's own
 * disclosure is about the judge: the Auto row names which model reviews and
 * who pays, and this is where that is changed.
 *
 * `hostId` is the composer's run-target host. The judge is stored per machine,
 * so the page scopes Settings to that machine before showing the tab; without
 * it a composer on machine B would open the judge of whatever machine Settings
 * last showed. `null` (no resolved target yet) leaves Settings where it is.
 */
export function useOpenPermissionSettings(hostId: string | null): () => void {
  const { openSettings } = useSystemTabModalActions();
  return useCallback(() => {
    openSettings({
      section: "permissions",
      tab: "judge",
      draft: null,
      resetToGeneral: false,
      hostId,
    });
  }, [hostId, openSettings]);
}
