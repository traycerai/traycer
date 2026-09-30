import { useState, type ReactNode } from "react";
import {
  Cpu,
  Layers,
  MoveHorizontal,
  PanelLeft,
  PanelTop,
  Smartphone,
  UnfoldHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useLayoutFormHost } from "@/components/layout-editor/inspector/layout-form-host";
import { LayoutFormRow } from "@/components/layout-editor/inspector/rows/layout-form-row";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import { Button } from "@/components/ui/button";
import { navigateToLayoutRegion } from "@/lib/settings-navigation";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { SegmentedControl } from "@/components/layout-editor/inspector/segmented-control";
import { PicturedOptions } from "@/components/layout-editor/inspector/pictured-options";
import { AppFrameStripTaskRows } from "@/components/layout-editor/inspector/app-frame-chrome";
import { writeArrangementField } from "@/lib/layout/arrangement-gestures";
import {
  EDGE_SIDE_OPTIONS,
  READING_WIDTH_OPTIONS,
  SIDE_STRIP_VIEW_AT_TOP,
  SIDE_STRIP_VIEW_OPTIONS,
  TAB_OVERFLOW_OPTIONS,
  TAB_STRIP_PLACEMENT_OPTIONS,
  type SurfaceGroupId,
} from "@/components/layout-editor/regions/region-grammar";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import {
  DEFAULT_ARRANGEMENT,
  WIDE_READING_WIDTH_MAX_PX,
  WIDE_READING_WIDTH_MIN_PX,
  WIDE_READING_WIDTH_STEP_PX,
} from "@/lib/layout/layout-arrangement";
import { SIDE_STRIP_DEFAULT_WIDTH_PX } from "@/components/layout/tabs/side-strip/side-strip-tokens";
import {
  mobileFooterChanged,
  sidebarSideChanged,
  sideStripViewChanged,
  tabStripPlacementChanged,
} from "@/lib/layout/layout-diff";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";
import {
  useLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import { Switch } from "@/components/ui/switch";
import {
  Slider,
  SliderRange,
  SliderThumb,
  SliderTrack,
} from "@/components/ui/slider";
import {
  isControlValueChanged,
  revertControlValue,
  writeControlValue,
} from "@/components/layout-editor/inspector/region-control-io";

/**
 * The rows that belong to an AREA rather than to a region: where the task tabs
 * sit, what their side strip shows and how they overflow; which side of the
 * task canvas the sidebar takes and whether agent rows carry resource
 * readings; the Composer's fixed Message queue note; and the small-screen
 * status bar.
 *
 * Neither the tab strip nor the sidebar column is a region, so these rows sit
 * in their area's form in both hosts, drawn as a `LayoutFormRow`. Each reads
 * the STORED arrangement, writes it as one recorded gesture (L-18) and offers
 * a revert only while the value differs from the shipped one. Label,
 * description and availability are the Settings search definitions', so a
 * search result and the row say the same thing.
 */

const TAB_STRIP_PLACEMENT_ROW = LAYOUT.definitions.tabStripPlacement;
const SIDE_STRIP_VIEW_ROW = LAYOUT.definitions.sideStripView;
const TAB_OVERFLOW_ROW = LAYOUT.definitions.taskTabLayout;
const SIDEBAR_SIDE_ROW = LAYOUT.definitions.sidebarSide;
const READING_WIDTH_ROW = LAYOUT.definitions.readingWidth;
const RESOURCE_READINGS_ROW = LAYOUT.definitions.resourceReadings;
const MOBILE_FOOTER_ROW = LAYOUT.definitions.mobileFooter;

/** An area's own rows that come before its lists. */
export function SurfaceLeadingRows(props: {
  readonly surface: SurfaceGroupId;
}): ReactNode {
  if (props.surface === "topBar") {
    return (
      <>
        <TabStripPositionRow />
        <SideStripViewRow />
        <TabOverflowRow />
      </>
    );
  }
  if (props.surface === "sidebar") return <SidebarSideRow />;
  if (props.surface === "chat") {
    return (
      <>
        <ReadingWidthRow />
        <WideReadingWidthRow />
      </>
    );
  }
  return null;
}

/** An area's own rows that come after its lists. */
export function SurfaceTrailingRows(props: {
  readonly surface: SurfaceGroupId;
}): ReactNode {
  if (props.surface === "sidebar") return <ResourceReadingsRow />;
  if (props.surface === "statusBar") return <MobileFooterRow />;
  return null;
}

/**
 * One area row, or nothing where its definition says the build has no use for
 * it (the installed mobile app). `status` stands in place of the description:
 * why the control is disabled, or the description with a control of its own.
 */
function PlacementRow(props: {
  readonly row: SettingsRowDefinition;
  readonly icon: LucideIcon;
  readonly control: ReactNode;
  readonly onRevert: (() => void) | null;
  readonly revertLabel: string;
  readonly status: ReactNode;
  /** A control that is a list of its own, under the label. */
  readonly stacked: boolean;
  readonly selected: boolean;
}): ReactNode {
  const { row, icon, control, onRevert, revertLabel, status } = props;
  const availability = useSettingsAvailabilityContext();
  if (!row.availableWhen(availability)) return null;
  return (
    <LayoutFormRow
      anchor={row.anchor ?? null}
      icon={icon}
      label={row.label}
      description={status ?? row.description ?? null}
      control={control}
      onRevert={onRevert}
      revertLabel={revertLabel}
      stacked={props.stacked}
      selected={props.selected}
    />
  );
}

/** Where the task tabs sit: across the top, or a vertical strip at an edge. */
export function TabStripPositionRow(): ReactNode {
  const arrangement = useLayoutStore((state) => state.arrangement);
  return (
    <PlacementRow
      row={TAB_STRIP_PLACEMENT_ROW}
      icon={PanelTop}
      onRevert={
        tabStripPlacementChanged(arrangement, DEFAULT_ARRANGEMENT)
          ? () => {
              writeArrangementField(
                "tabStripPlacement",
                DEFAULT_ARRANGEMENT.tabStripPlacement,
              );
            }
          : null
      }
      revertLabel="Reset tab placement to default: Top"
      status={null}
      stacked={false}
      selected={false}
      control={
        <SegmentedControl
          ariaLabel="Tab placement"
          options={TAB_STRIP_PLACEMENT_OPTIONS}
          value={arrangement.tabStripPlacement}
          onChange={(next) => {
            const option = TAB_STRIP_PLACEMENT_OPTIONS.find(
              (candidate) => candidate.value === next,
            );
            if (option === undefined) return;
            writeArrangementField("tabStripPlacement", option.value);
          }}
        />
      }
    />
  );
}

/**
 * What the vertical strip shows (D8), each value drawn as the strip itself: the
 * sample task's row and the one below it, with its live agents between them in
 * Tabs and agents. It only means something while the tabs are at an edge, so
 * at the top the pictures are disabled and the row says why; the stored value
 * is kept for the way back.
 *
 * Its part on the editor's canvas is the list under the active tab, so it is
 * the one area row that selects: pressing or focusing it rings that list, and
 * a press on the list selects it (`LayoutSettingId`).
 */
export function SideStripViewRow(): ReactNode {
  const arrangement = useLayoutStore((state) => state.arrangement);
  const selected = useLayoutEditorStore(
    (state) => state.selectedSetting === "sideStripView",
  );
  const atTop = arrangement.tabStripPlacement === "top";
  return (
    <PlacementRow
      row={SIDE_STRIP_VIEW_ROW}
      icon={Layers}
      onRevert={
        sideStripViewChanged(arrangement, DEFAULT_ARRANGEMENT)
          ? () => {
              writeArrangementField(
                "sideStripView",
                DEFAULT_ARRANGEMENT.sideStripView,
              );
            }
          : null
      }
      revertLabel="Reset side tab view to default: Tabs only"
      status={atTop ? SIDE_STRIP_VIEW_AT_TOP : null}
      stacked
      selected={selected}
      control={
        <PicturedOptions
          label="Side tab view"
          value={arrangement.sideStripView}
          disabled={atTop}
          labelPlacement="above"
          onChange={(next) => {
            const option = SIDE_STRIP_VIEW_OPTIONS.find(
              (candidate) => candidate.value === next,
            );
            if (option === undefined) return;
            writeArrangementField("sideStripView", option.value);
          }}
          options={SIDE_STRIP_VIEW_OPTIONS.map((option) => ({
            id: option.value,
            label: option.label,
            picture: (
              <div
                className="flex w-full flex-col gap-0.5"
                style={{ maxWidth: SIDE_STRIP_DEFAULT_WIDTH_PX }}
              >
                <AppFrameStripTaskRows
                  liveAgents={option.value === "activity"}
                  joined={null}
                  startAtActive
                />
              </div>
            ),
          }))}
        />
      }
    />
  );
}

/** Which side of the task canvas the sidebar sits on. */
export function SidebarSideRow(): ReactNode {
  const arrangement = useLayoutStore((state) => state.arrangement);
  return (
    <PlacementRow
      row={SIDEBAR_SIDE_ROW}
      icon={PanelLeft}
      onRevert={
        sidebarSideChanged(arrangement, DEFAULT_ARRANGEMENT)
          ? () => {
              writeArrangementField(
                "sidebarSide",
                DEFAULT_ARRANGEMENT.sidebarSide,
              );
            }
          : null
      }
      revertLabel="Reset sidebar side to default"
      status={null}
      stacked={false}
      selected={false}
      control={
        <SegmentedControl
          ariaLabel="Sidebar side"
          options={EDGE_SIDE_OPTIONS}
          value={arrangement.sidebarSide}
          onChange={(next) => {
            if (next !== "left" && next !== "right") return;
            writeArrangementField("sidebarSide", next);
          }}
        />
      }
    />
  );
}

/** How wide the transcript, the composer and an artifact's body run. */
export function ReadingWidthRow(): ReactNode {
  const readingWidth = useLayoutStore(
    (state) => state.arrangement.readingWidth,
  );
  return (
    <PlacementRow
      row={READING_WIDTH_ROW}
      icon={UnfoldHorizontal}
      onRevert={
        readingWidth === DEFAULT_ARRANGEMENT.readingWidth
          ? null
          : () => {
              writeArrangementField(
                "readingWidth",
                DEFAULT_ARRANGEMENT.readingWidth,
              );
            }
      }
      revertLabel="Reset reading width to default: Comfortable"
      status={null}
      stacked={false}
      selected={false}
      control={
        <SegmentedControl
          ariaLabel="Reading width"
          options={READING_WIDTH_OPTIONS}
          value={readingWidth}
          onChange={(next) => {
            if (next !== "comfortable" && next !== "wide") return;
            writeArrangementField("readingWidth", next);
          }}
        />
      }
    />
  );
}

/**
 * The wide column's own width, as a slider beneath the Reading width row -
 * visible only while `readingWidth` is "wide" (the same conditional-row
 * pattern `surface-section.tsx`'s `tabStripHosted` gate uses for the Display
 * row: read the sibling value, drop the row where it has nothing to do). The
 * floor matches today's fixed wide column, so the slider never reads
 * narrower than "Wide" has always meant; the ceiling is generous, since
 * `useReadingWidthStyle` viewport-clamps whatever is actually applied.
 *
 * `draftPx` is `null` whenever the thumb is at rest, so the slider reads the
 * STORE value directly and always stays fresh against a revert, an undo, or
 * another window. It is only ever non-null mid-drag, and `onValueCommit`
 * writes the arrangement exactly once and clears it back to `null` - a whole
 * drag is one recorded gesture (`writeArrangement`'s own invariant), so
 * writing on every intermediate `onValueChange` would flood undo with one
 * step per pixel.
 */
export function WideReadingWidthRow(): ReactNode {
  const readingWidth = useLayoutStore(
    (state) => state.arrangement.readingWidth,
  );
  const storedPx = useLayoutStore(
    (state) => state.arrangement.wideReadingWidthPx,
  );
  const [draftPx, setDraftPx] = useState<number | null>(null);
  const availability = useSettingsAvailabilityContext();
  // Withheld wherever its parent row is: a slider under a missing row.
  if (readingWidth !== "wide" || !READING_WIDTH_ROW.availableWhen(availability))
    return null;
  const px = draftPx ?? storedPx;
  return (
    <LayoutFormRow
      anchor={null}
      icon={null}
      label="Wide column width"
      description={`${px}px, clamped to the window width near its edge.`}
      onRevert={
        storedPx === DEFAULT_ARRANGEMENT.wideReadingWidthPx
          ? null
          : () => {
              writeArrangementField(
                "wideReadingWidthPx",
                DEFAULT_ARRANGEMENT.wideReadingWidthPx,
              );
            }
      }
      revertLabel={`Reset wide column width to default: ${DEFAULT_ARRANGEMENT.wideReadingWidthPx}px`}
      stacked
      selected={false}
      control={
        <Slider
          className="min-w-0 flex-1"
          value={[px]}
          min={WIDE_READING_WIDTH_MIN_PX}
          max={WIDE_READING_WIDTH_MAX_PX}
          step={WIDE_READING_WIDTH_STEP_PX}
          onValueChange={(next) => {
            setDraftPx(next[0]);
          }}
          onValueCommit={(next) => {
            writeArrangementField("wideReadingWidthPx", next[0]);
            setDraftPx(null);
          }}
        >
          <SliderTrack size="default">
            <SliderRange />
          </SliderTrack>
          <SliderThumb size="default" aria-label="Wide column width" />
        </Slider>
      }
    />
  );
}

/**
 * How tabs fit a horizontal strip. A side strip stacks its tabs and never
 * scrolls or shrinks them sideways, so while the tabs sit at a side the
 * control is disabled and says why; the stored value is kept for the way back.
 * The installed mobile app always draws its tabs at the top.
 */
export function TabOverflowRow(): ReactNode {
  const taskTabLayout = useLayoutStore(
    (state) => state.arrangement.taskTabLayout,
  );
  const placement = useLayoutStore(
    (state) => state.arrangement.tabStripPlacement,
  );
  const availability = useSettingsAvailabilityContext();
  const atSide =
    TAB_STRIP_PLACEMENT_ROW.availableWhen(availability) && placement !== "top";
  return (
    <PlacementRow
      row={TAB_OVERFLOW_ROW}
      icon={MoveHorizontal}
      onRevert={
        taskTabLayout === DEFAULT_ARRANGEMENT.taskTabLayout
          ? null
          : () => {
              writeArrangementField(
                "taskTabLayout",
                DEFAULT_ARRANGEMENT.taskTabLayout,
              );
            }
      }
      revertLabel="Reset tab overflow to default: Scroll"
      status={atSide ? "Available when tabs are at the top." : null}
      stacked={false}
      selected={false}
      control={
        <SegmentedControl
          ariaLabel="Tab overflow"
          options={TAB_OVERFLOW_OPTIONS}
          value={taskTabLayout}
          disabled={atSide}
          onChange={(next) => {
            if (next !== "scroll" && next !== "shrink") return;
            writeArrangementField("taskTabLayout", next);
          }}
        />
      }
    />
  );
}

/**
 * The resource readings on each agent and terminal row in the sidebar (G7).
 * Stored beside the Resource monitor's values, but a Sidebar setting: it works
 * whether or not the monitor is shown, so it never greys with it. WHICH
 * readings is the monitor's own Metrics choice (L-174), so the description
 * links there.
 */
export function ResourceReadingsRow(): ReactNode {
  const snapshot = useLayoutSnapshot();
  const on = effectiveLayoutValues(snapshot.basePreset, snapshot.overrides)
    .resourceMonitor.agentRows;
  const page = useLayoutFormHost() === "page";
  // Each host opens the monitor's row its own way: the page lands on it as a
  // settings result does, the editor opens its area with the row expanded.
  const openResourceMonitor = (): void => {
    if (page) {
      navigateToLayoutRegion("resourceMonitor");
      return;
    }
    useLayoutEditorStore
      .getState()
      .openArea(LAYOUT_REGIONS.resourceMonitor.surface, "resourceMonitor");
  };
  return (
    <PlacementRow
      row={RESOURCE_READINGS_ROW}
      icon={Cpu}
      onRevert={
        isControlValueChanged("resourceMonitor", "agentRows")
          ? () => {
              revertControlValue("resourceMonitor", "agentRows");
            }
          : null
      }
      revertLabel="Reset readings on agent rows"
      stacked={false}
      selected={false}
      status={
        <>
          {RESOURCE_READINGS_ROW.description}{" "}
          <Button
            type="button"
            variant="link"
            size={page ? "inline" : "inline-xs"}
            onClick={openResourceMonitor}
          >
            Choose metrics
          </Button>
        </>
      }
      control={
        <Switch
          aria-label={RESOURCE_READINGS_ROW.label}
          checked={on}
          onCheckedChange={(next) => {
            writeControlValue("resourceMonitor", "agentRows", next);
          }}
        />
      }
    />
  );
}

/**
 * Whether the strip is drawn at all on a narrow viewport (L-51). Only the
 * installed mobile app has the switch: every other build draws the footer
 * whenever a reading names it.
 */
function MobileFooterRow(): ReactNode {
  const arrangement = useLayoutStore((state) => state.arrangement);
  return (
    <PlacementRow
      row={MOBILE_FOOTER_ROW}
      icon={Smartphone}
      onRevert={
        mobileFooterChanged(arrangement)
          ? () => {
              writeArrangementField(
                "mobileFooter",
                DEFAULT_ARRANGEMENT.mobileFooter,
              );
            }
          : null
      }
      revertLabel="Reset the small-screen status bar"
      status={null}
      stacked={false}
      selected={false}
      control={
        <Switch
          checked={arrangement.mobileFooter}
          onCheckedChange={(checked) => {
            writeArrangementField("mobileFooter", checked);
          }}
          aria-label={MOBILE_FOOTER_ROW.label}
        />
      }
    />
  );
}
