import { trackSettingChanged, type AnalyticsSetting } from "@/lib/analytics";

/**
 * Every control on the Layout page reports under the `layout` section,
 * including the rows relocated onto it from General and Appearance - their
 * analytics ids are unchanged, only the section they are attributed to moved.
 * One helper so a group added later cannot report under a different one.
 */
export function trackLayoutSetting(setting: AnalyticsSetting): void {
  trackSettingChanged("layout", setting);
}
