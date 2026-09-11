import type { ReactNode } from "react";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  SettingsSegmentedControl,
  type SettingsSegmentedOption,
} from "@/components/settings/controls/settings-segmented-control";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  useLayoutStore,
  type HomeDensity,
} from "@/stores/settings/layout-store";

const HOME_DENSITY_OPTIONS: ReadonlyArray<
  SettingsSegmentedOption<HomeDensity>
> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

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
 * It is a group rather than a loose row because the strip is a surface with
 * more than one question to answer, and because a group that exists is where
 * the next such control lands instead of being parked wherever looked closest -
 * which is exactly what `Home density` did.
 *
 * Home's OTHER preference, which of its two views is showing, is deliberately
 * not here. It is written by a control on the page itself and persists its last
 * selection; a Settings row would be a second place to answer a question the
 * page answers better, and one the user would have to leave Home to change.
 */
export function TabsLayoutGroup(): ReactNode {
  const homeTabEnabled = useSettingsStore((state) => state.homeTabEnabled);
  const setHomeTabEnabled = useSettingsStore(
    (state) => state.setHomeTabEnabled,
  );
  const homeDensity = useLayoutStore((state) => state.home.density);
  const setHomeDensity = useLayoutStore((state) => state.setHomeDensity);
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
      <SettingsRow
        row={LAYOUT.definitions.homeDensity}
        control={
          <SettingsSegmentedControl
            value={homeDensity}
            options={HOME_DENSITY_OPTIONS}
            onChange={(density) => {
              trackLayoutSetting("layout.home.density");
              setHomeDensity(density);
            }}
            ariaLabel="Home density"
          />
        }
      />
    </SettingsGroup>
  );
}
