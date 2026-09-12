import type { ReactNode } from "react";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * What the top-level tab strip carries.
 *
 * Its own group rather than a row borrowed by the Status bar one: a tab is not
 * part of the footer, and the footer group collapses on a build where these
 * controls still apply. Nothing here keys on `isMobileApp()` for that reason -
 * the mobile app has no strip, but it draws what these rows govern (the Home
 * tab becomes the first entry in the nav drawer), so the group renders whole on
 * every build.
 *
 * It is a group rather than a loose row even while it holds ONE row, because a
 * group that exists is where the next such control lands instead of being
 * parked wherever looked closest - which is how `Home density` ended up on
 * Status bar before this group existed. That row is gone (the two spacings
 * were barely distinguishable, user ruling 2026-09-12) and Home renders the
 * comfortable one; the group stays for the tab strip's own next question.
 */
export function TabsLayoutGroup(): ReactNode {
  const homeTabEnabled = useSettingsStore((state) => state.homeTabEnabled);
  const setHomeTabEnabled = useSettingsStore(
    (state) => state.setHomeTabEnabled,
  );
  return (
    <SettingsGroup
      group={LAYOUT.definitions.tabs}
      showTitle
      tone="default"
      dataTestId="layout-tabs-group"
      fill={false}
    >
      {/* Moved off General with its store key and its `homeTabEnabled`
        analytics setting id intact; only the section it reports under follows
        the page. */}
      <SettingsRow
        row={LAYOUT.definitions.homeTab}
        control={
          <Switch
            checked={homeTabEnabled}
            onCheckedChange={(value) => {
              trackLayoutSetting("homeTabEnabled");
              setHomeTabEnabled(value);
            }}
            aria-label="Home tab"
          />
        }
      />
    </SettingsGroup>
  );
}
