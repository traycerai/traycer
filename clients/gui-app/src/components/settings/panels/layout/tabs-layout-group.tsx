import type { ReactNode } from "react";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Switch } from "@/components/ui/switch";
import {
  useSettingsStore,
  type TaskTabLayout,
} from "@/stores/settings/settings-store";
import {
  SettingsSegmentedControl,
  type SettingsSegmentedOption,
} from "@/components/settings/controls/settings-segmented-control";

const TAB_LAYOUT_OPTIONS: ReadonlyArray<
  SettingsSegmentedOption<TaskTabLayout>
> = [
  { value: "scroll", label: "Scroll" },
  { value: "shrink", label: "Shrink to fit" },
];

export function TabsLayoutGroup(): ReactNode {
  const taskTabLayout = useSettingsStore((state) => state.taskTabLayout);
  const setTaskTabLayout = useSettingsStore((state) => state.setTaskTabLayout);
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
      <SettingsRow
        row={LAYOUT.definitions.taskTabLayout}
        control={
          <SettingsSegmentedControl
            value={taskTabLayout}
            options={TAB_LAYOUT_OPTIONS}
            onChange={(value) => {
              trackLayoutSetting("taskTabLayout");
              setTaskTabLayout(value);
            }}
            ariaLabel="Task tab layout"
          />
        }
      />
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
