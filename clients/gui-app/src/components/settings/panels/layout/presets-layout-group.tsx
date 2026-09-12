import type { ReactNode } from "react";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  SettingsSegmentedControl,
  type SettingsSegmentedOption,
} from "@/components/settings/controls/settings-segmented-control";
import { Button } from "@/components/ui/button";
import {
  applyLayoutPreset,
  LAYOUT_PRESET_LABELS,
  matchLayoutPreset,
  resetLayoutToDefaults,
  type LayoutPresetId,
  type LayoutPresetMatch,
} from "@/lib/layout-presets";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import {
  areLeftPanelGroupsEqual,
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const PRESET_OPTIONS: ReadonlyArray<SettingsSegmentedOption<LayoutPresetId>> = [
  { value: "default", label: LAYOUT_PRESET_LABELS.default },
  { value: "compact", label: LAYOUT_PRESET_LABELS.compact },
  { value: "detailed", label: LAYOUT_PRESET_LABELS.detailed },
];

/**
 * The whole page in one click, and the way back.
 *
 * First group on the page because it is the coarsest control on it: a reader
 * who wants "less chrome" should not have to find the eleven rows that say so,
 * and a reader who wants one row still scrolls past this to reach it. Every
 * row below stays exactly as reachable as it was - a preset writes the same
 * store keys those rows write, so the page after a click is a page the user
 * could have arrived at by hand.
 *
 * **There is no "selected preset" state.** The pressed segment is derived from
 * the stores on every render, so changing any row below flips this to `Custom`
 * at once rather than leaving a stale badge claiming a preset the page no
 * longer matches. `Custom` is shown as a fourth, unpressable segment: it is a
 * verdict, not a choice, and a control that offered it would be offering to
 * change nothing.
 *
 * **The segment and the button are not the same gesture.** `Default` is the
 * third DENSITY bundle - it leaves the strip's placement and the rail exactly
 * where they are, as Compact and Detailed do. `Reset to defaults` puts the
 * whole page back, those two included, which is why it stays enabled on a page
 * already reading `Default` whose strip has been moved or whose rail has been
 * rearranged: there is still something for it to undo.
 *
 * Reset asks nothing first. The page is autosave and every value it writes is
 * one click from coming back, so a confirm would be a dialog guarding
 * something less destructive than the rows it sits above.
 */
export function PresetsLayoutGroup(): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const match = useLayoutPresetMatch();
  const fullyDefault = useLayoutIsFullyDefault(match);
  return (
    <SettingsGroup
      group={LAYOUT.definitions.presets}
      showTitle
      tone="default"
      dataTestId="layout-presets-group"
      fill={false}
    >
      <SettingsRow
        row={LAYOUT.definitions.presetChoice}
        control={
          <div
            className={cn(
              "flex flex-wrap items-center justify-end gap-2",
              compact ? "gap-1.5" : "gap-2",
            )}
          >
            <LayoutPresetChoice match={match} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={fullyDefault}
              onClick={() => {
                // The same id the `Default` segment fires: one gesture, one
                // setting, and the two differ in what they restore rather than
                // in what they are about.
                trackLayoutSetting("layout.preset.default");
                resetLayoutToDefaults();
              }}
            >
              Reset to defaults
            </Button>
          </div>
        }
      />
    </SettingsGroup>
  );
}

/**
 * The three presets, plus `Custom` while none of them is the answer.
 *
 * Two controls rather than one with a conditional option, because the option
 * list would otherwise change length as the user edits rows - a segmented
 * control that grows a fourth segment when you touch a switch below reads as a
 * glitch. `Custom` is a pressed, disabled segment drawn beside the group
 * instead: same shape, no affordance, and it disappears the moment a preset
 * matches again.
 */
function LayoutPresetChoice(props: {
  readonly match: LayoutPresetMatch;
}): ReactNode {
  return (
    <>
      <SettingsSegmentedControl<LayoutPresetMatch>
        // `custom` is a legal VALUE here and never one of the options, so no
        // segment is pressed while it is the verdict - the honest rendering of
        // "none of these", and what the badge beside it then explains.
        value={props.match}
        options={PRESET_OPTIONS}
        onChange={(preset) => {
          // Narrowing a union the control cannot emit: it only ever hands back
          // one of its own options, and `custom` is not one.
          if (preset === "custom") return;
          trackLayoutSetting(PRESET_ANALYTICS_SETTINGS[preset]);
          applyLayoutPreset(preset);
        }}
        ariaLabel="Layout preset"
      />
      {props.match === "custom" ? (
        <span
          data-testid="layout-preset-custom"
          className="inline-flex items-center rounded-md border border-border bg-foreground/3 px-2 py-1 text-ui-sm text-muted-foreground"
        >
          {LAYOUT_PRESET_LABELS.custom}
        </span>
      ) : null}
    </>
  );
}

/**
 * One analytics id per preset rather than one id carrying the preset as a
 * property: `setting_changed` has a fixed three-key payload (`source`,
 * `section`, `setting`), and every id in that vocabulary already names the
 * thing that changed rather than the value it took.
 */
const PRESET_ANALYTICS_SETTINGS: Readonly<
  Record<
    LayoutPresetId,
    "layout.preset.default" | "layout.preset.compact" | "layout.preset.detailed"
  >
> = {
  default: "layout.preset.default",
  compact: "layout.preset.compact",
  detailed: "layout.preset.detailed",
};

/**
 * Whether Reset has anything left to do: the Default densities AND the
 * structural settings the bundles do not carry.
 *
 * Read here rather than folded into `matchLayoutPreset`, because the two
 * answer different questions - the segment says which density bundle the page
 * is on, and this says whether the page as a whole is already the default one.
 */
function useLayoutIsFullyDefault(match: LayoutPresetMatch): boolean {
  const placement = useLayoutStore((state) => state.statusBar.placement);
  const reasoningFooterControl = useLayoutStore(
    (state) => state.composer.reasoningFooterControl,
  );
  const panelGroups = useLeftPanelStore((state) => state.panelGroups);
  const visibilityOverrides = useLeftPanelStore(
    (state) => state.panelVisibilityOverrideById,
  );
  return (
    match === "default" &&
    placement === DEFAULT_STATUS_BAR_LAYOUT.placement &&
    reasoningFooterControl === DEFAULT_COMPOSER_LAYOUT.reasoningFooterControl &&
    areLeftPanelGroupsEqual(panelGroups, DEFAULT_LEFT_PANEL_GROUPS) &&
    Object.keys(visibilityOverrides).length === 0
  );
}

/**
 * The verdict, recomputed from the stores on every render.
 *
 * Subscribed SLICE BY SLICE rather than through one selector returning an
 * object: a selector that builds a fresh object each call makes
 * `useSyncExternalStore` see a new snapshot on every read and re-render
 * forever. Each value read here is either a stable slice reference or a
 * primitive, and the snapshot is assembled in render where that does not
 * matter.
 */
function useLayoutPresetMatch(): LayoutPresetMatch {
  const statusBar = useLayoutStore((state) => state.statusBar);
  const composer = useLayoutStore((state) => state.composer);
  const pinContextUsageBreakdown = useSettingsStore(
    (state) => state.pinContextUsageBreakdown,
  );
  const pinnedContextBreakdownFields = useSettingsStore(
    (state) => state.pinnedContextBreakdownFields,
  );
  const contextIndicatorStyle = useSettingsStore(
    (state) => state.contextIndicatorStyle,
  );
  const chatTurnMinimapSide = useSettingsStore(
    (state) => state.chatTurnMinimapSide,
  );
  const navigatorResourceMetrics = useSettingsStore(
    (state) => state.navigatorResourceMetrics,
  );
  return matchLayoutPreset({
    statusBar,
    composer,
    chat: {
      pinContextUsageBreakdown,
      pinnedContextBreakdownFields,
      contextIndicatorStyle,
      chatTurnMinimapSide,
    },
    sidebar: { navigatorResourceMetrics },
  });
}
