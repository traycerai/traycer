import {
  environmentPageSection,
  pickForConfiguration,
  type EnvironmentPageAddress,
} from "@/lib/settings-environment-pages";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/**
 * Opens an Environment page by its address: picks the configuration in the
 * Environment dropdown, then moves Settings to the page's section.
 */
export function openEnvironmentPage(address: EnvironmentPageAddress): void {
  useSettingsEnvironmentPickStore
    .getState()
    .setPick(pickForConfiguration(address.configurationId));
  navigateToSettingsSection(environmentPageSection(address.pageId));
}
