import type { ReactNode } from "react";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  HOME_STATUS_DONE_HIDE_OPTIONS,
  HOME_STATUS_IN_PROGRESS_STALE_OPTIONS,
  HOME_STATUS_NEEDS_YOU_STALE_OPTIONS,
  type HomeStatusThresholdOption,
} from "@/lib/home-focus/home-status-thresholds";
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
      {homeTabEnabled ? <HomeStatusThresholdRows /> : null}
    </SettingsGroup>
  );
}

/**
 * The status board's thresholds, directly under the switch that draws the
 * board. A closed Home tab keeps the stored choices; they are configuring a
 * surface that is switched off, not one the user has stopped meaning.
 */
function HomeStatusThresholdRows(): ReactNode {
  const inProgress = useSettingsStore(
    (state) => state.homeStatusInProgressStaleAfter,
  );
  const setInProgress = useSettingsStore(
    (state) => state.setHomeStatusInProgressStaleAfter,
  );
  const needsYou = useSettingsStore(
    (state) => state.homeStatusNeedsYouStaleAfter,
  );
  const setNeedsYou = useSettingsStore(
    (state) => state.setHomeStatusNeedsYouStaleAfter,
  );
  const doneHide = useSettingsStore((state) => state.homeStatusDoneHideAfter);
  const setDoneHide = useSettingsStore(
    (state) => state.setHomeStatusDoneHideAfter,
  );
  return (
    <>
      <SettingsRow
        row={LAYOUT.definitions.homeStatusInProgressStale}
        control={
          <ThresholdSelect
            value={inProgress}
            options={HOME_STATUS_IN_PROGRESS_STALE_OPTIONS}
            ariaLabel="In progress stale after"
            onChange={(value) => {
              trackLayoutSetting("homeStatusInProgressStaleAfter");
              setInProgress(value);
            }}
          />
        }
      />
      <SettingsRow
        row={LAYOUT.definitions.homeStatusNeedsYouStale}
        control={
          <ThresholdSelect
            value={needsYou}
            options={HOME_STATUS_NEEDS_YOU_STALE_OPTIONS}
            ariaLabel="Needs you stale after"
            onChange={(value) => {
              trackLayoutSetting("homeStatusNeedsYouStaleAfter");
              setNeedsYou(value);
            }}
          />
        }
      />
      <SettingsRow
        row={LAYOUT.definitions.homeStatusDoneHide}
        control={
          <ThresholdSelect
            value={doneHide}
            options={HOME_STATUS_DONE_HIDE_OPTIONS}
            ariaLabel="Done hide after"
            onChange={(value) => {
              trackLayoutSetting("homeStatusDoneHideAfter");
              setDoneHide(value);
            }}
          />
        }
      />
    </>
  );
}

function ThresholdSelect<Value extends string>(props: {
  readonly value: Value;
  readonly options: ReadonlyArray<HomeStatusThresholdOption<Value>>;
  readonly ariaLabel: string;
  readonly onChange: (value: Value) => void;
}): ReactNode {
  const { value, options, ariaLabel, onChange } = props;
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option === undefined || option.value === value) return;
        onChange(option.value);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={ariaLabel}
        className="w-[min(40vw,8rem)]"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
