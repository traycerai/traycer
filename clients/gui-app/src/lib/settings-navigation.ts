import type { SettingsSectionId } from "@/lib/settings-sections";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";

/** Move the Settings surface to `sectionId`, whichever surface it is. */
export function navigateToSettingsSection(sectionId: SettingsSectionId): void {
  const api = getSystemTabModalApi();
  if (api === null) return;
  if (api.isOverlayActive("settings")) {
    api.setSection(sectionId);
    return;
  }
  api.openSettings({ section: sectionId, resetToGeneral: false });
}
