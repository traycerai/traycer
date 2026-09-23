import { useCallback } from "react";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * Opens Settings ▸ Permissions on its Judge tab - the composer mode picker's
 * "Permission settings…" item, on desktop and in the phone sheet alike.
 *
 * The Judge tab rather than the page's default because the picker's own
 * disclosure is about the judge: the Auto row names which model reviews and
 * who pays, and this is where that is changed.
 */
export function useOpenPermissionSettings(): () => void {
  const { openSettings } = useSystemTabModalActions();
  return useCallback(() => {
    openSettings({
      section: "permissions",
      tab: "judge",
      draft: null,
      resetToGeneral: false,
    });
  }, [openSettings]);
}
