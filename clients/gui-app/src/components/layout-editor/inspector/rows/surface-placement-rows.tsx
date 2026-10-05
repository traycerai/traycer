import { useState, type ReactNode } from "react";
import {
  Cpu,
  Layers,
  MoveHorizontal,
  Paintbrush,
  PanelLeft,
  PanelTop,
  Smartphone,
  UnfoldHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useLayoutFormHost } from "@/components/layout-editor/inspector/layout-form-host";
import { LayoutFormRow } from "@/components/layout-editor/inspector/rows/layout-form-row";
import { StyleRow } from "@/components/layout-editor/inspector/rows/style-row";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import { Button } from "@/components/ui/button";
import { navigateToLayoutRegion } from "@/lib/settings-navigation";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { SegmentedControl } from "@/components/layout-editor/inspector/segmented-control";
import { PicturedOptions } from "@/components/layout-editor/inspector/pictured-options";
import { AppFrameStripTaskRows } from "@/components/layout-editor/inspector/app-frame-chrome";
import { writeArrangementField } from "@/lib/layout/arrangement-gestures";
import {
  AREA_ROWS,
  type AreaRowId,
} from "@/components/layout-editor/regions/area-rows";
import { TOOLBAR_STYLE_EXAMPLES } from "@/components/layout-editor/regions/composer-regions";
import {
  EDGE_SIDE_OPTIONS,
  READING_WIDTH_OPTIONS,
  SIDE_STRIP_VIEW_OPTIONS,
  TAB_OVERFLOW_OPTIONS,
  TAB_STRIP_PLACEMENT_OPTIONS,
  type SurfaceGroupId,
} from "@/components/layout-editor/regions/region-grammar";
import {
  orderedRows,
  type LayoutFormContext,
  type ShownRowAvailability,
} from "@/components/layout-editor/regions/row-availability";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
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
import { useLayoutStore } from "@/stores/layout/layout-store";
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
 * sit, how they overflow and what their side strip shows; which side of the
 * task canvas the sidebar takes and whether agent rows carry resource
 * readings; the reading width; the composer toolbar's style; and the
 * small-screen status bar.
 *
 * Neither the tab strip nor the sidebar column is a region, so these rows sit
 * in their area's form in both hosts, drawn as a `LayoutFormRow`. Each reads
 * the STORED arrangement, writes it as one recorded gesture (L-18) and offers
 * a revert only while the value differs from the shipped one. Label and
 * description are the Settings search definitions', so a search result and
 * the row say the same thing. Which rows an area draws, in what order, nested
 * under what and with what reason is `regions/area-rows.ts`'s (P1).
 */

const TAB_STRIP_PLACEMENT_ROW = LAYOUT.definitions.tabStripPlacement;
const SIDE_STRIP_VIEW_ROW = LAYOUT.definitions.sideStripView;
const TAB_OVERFLOW_ROW = LAYOUT.definitions.taskTabLayout;
const SIDEBAR_SIDE_ROW = LAYOUT.definitions.sidebarSide;
const READING_WIDTH_ROW = LAYOUT.definitions.readingWidth;
const RESOURCE_READINGS_ROW = LAYOUT.definitions.resourceReadings;
const TOOLBAR_STYLE_ROW = LAYOUT.definitions.toolbarStyle;
const MOBILE_FOOTER_ROW = LAYOUT.definitions.mobileFooter;

/** What every area row takes from where the registry places it. */
interface AreaRowPlacement {
  readonly availability: ShownRowAvailability;
  readonly depth: 0 | 1;
}

/**
 * An area's own rows before its lists (`leading`) or after them
 * (`trailing`), in the registry's order, each under the row that controls it.
 */
export function SurfaceAreaRows(props: {
  readonly surface: SurfaceGroupId;
  readonly place: "leading" | "trailing";
  readonly context: LayoutFormContext;
}): ReactNode {
  const { surface, place, context } = props;
  const rows = orderedRows(
    AREA_ROWS.filter((row) => row.surface === surface && row.place === place),
    context,
  );
  return rows.map(({ row, depth, availability }) => (
    <AreaRowView
      key={row.id}
      id={row.id}
      context={context}
      availability={availability}
      depth={depth}
    />
  ));
}

function AreaRowView(
  props: AreaRowPlacement & {
    readonly id: AreaRowId;
    readonly context: LayoutFormContext;
  },
): ReactNode {
  const { id, context, ...placement } = props;
  switch (id) {
    case "tabStripPlacement":
      return <TabStripPositionRow {...placement} />;
    case "taskTabLayout":
      return <TabOverflowRow {...placement} />;
    case "sideStripView":
      return <SideStripViewRow {...placement} />;
    case "sidebarSide":
      return <SidebarSideRow {...placement} />;
    case "resourceReadings":
      return <ResourceReadingsRow {...placement} context={context} />;
    case "readingWidth":
      return <ReadingWidthRow {...placement} />;
    case "wideReadingWidth":
      return <WideReadingWidthRow {...placement} />;
    case "toolbarStyle":
      return <ToolbarStyleRow {...placement} context={context} />;
    case "mobileFooter":
      return <MobileFooterRow {...placement} />;
  }
}

/** One area row, worded by its Settings search definition. */
function PlacementRow(
  props: AreaRowPlacement & {
    readonly row: SettingsRowDefinition;
    readonly icon: LucideIcon;
    readonly control: ReactNode;
    readonly onRevert: (() => void) | null;
    readonly revertLabel: string;
    /** The definition's description, or text carrying a link of the row's own. */
    readonly description: ReactNode;
    /** A control that is a list of its own, under the label. */
    readonly stacked: boolean;
    readonly selected: boolean;
  },
): ReactNode {
  const { row, icon, control, onRevert, revertLabel } = props;
  return (
    <LayoutFormRow
      anchor={row.anchor ?? null}
      icon={icon}
      label={row.label}
      description={props.description}
      control={control}
      onRevert={onRevert}
      revertLabel={revertLabel}
      stacked={props.stacked}
      selected={props.selected}
      availability={props.availability}
      depth={props.depth}
    />
  );
}

/** Where the task tabs sit: across the top, or a vertical strip at an edge. */
export function TabStripPositionRow(props: AreaRowPlacement): ReactNode {
  const arrangement = useLayoutStore((state) => state.arrangement);
  return (
    <PlacementRow
      {...props}
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
      description={TAB_STRIP_PLACEMENT_ROW.description}
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
export function SideStripViewRow(props: AreaRowPlacement): ReactNode {
  const arrangement = useLayoutStore((state) => state.arrangement);
  const selected = useLayoutEditorStore(
    (state) => state.selectedSetting === "sideStripView",
  );
  return (
    <PlacementRow
      {...props}
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
      description={SIDE_STRIP_VIEW_ROW.description}
      stacked
      selected={selected}
      control={
        <PicturedOptions
          label="Side tab view"
          value={arrangement.sideStripView}
          // The row's fieldset turns the radios off; the pictures dim with
          // them by the same `disabled` state.
          disabled={props.availability.kind === "disabled"}
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
export function SidebarSideRow(props: AreaRowPlacement): ReactNode {
  const arrangement = useLayoutStore((state) => state.arrangement);
  return (
    <PlacementRow
      {...props}
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
      description={SIDEBAR_SIDE_ROW.description}
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
export function ReadingWidthRow(props: AreaRowPlacement): ReactNode {
  const readingWidth = useLayoutStore(
    (state) => state.arrangement.readingWidth,
  );
  return (
    <PlacementRow
      {...props}
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
      description={READING_WIDTH_ROW.description}
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
 * The wide column's own width, as a slider under the Reading width row. It
 * stays in place while Comfortable, disabled and saying so (C5), rather than
 * coming and going with the choice above it. The floor matches today's fixed
 * wide column, so the slider never reads narrower than "Wide" has always
 * meant; the ceiling is generous, since the column is never wider than the
 * pane it is drawn in (`useReadingWidthStyle`).
 *
 * `draftPx` is `null` whenever the thumb is at rest, so the slider reads the
 * STORE value directly and always stays fresh against a revert, an undo, or
 * another window. It is only ever non-null mid-drag, and `onValueCommit`
 * writes the arrangement exactly once and clears it back to `null` - a whole
 * drag is one recorded gesture (`writeArrangement`'s own invariant), so
 * writing on every intermediate `onValueChange` would flood undo with one
 * step per pixel.
 */
export function WideReadingWidthRow(props: AreaRowPlacement): ReactNode {
  const storedPx = useLayoutStore(
    (state) => state.arrangement.wideReadingWidthPx,
  );
  const [draftPx, setDraftPx] = useState<number | null>(null);
  const px = draftPx ?? storedPx;
  return (
    <LayoutFormRow
      anchor={null}
      icon={null}
      label="Wide column width"
      description={`${px}px. Never wider than the pane it is in.`}
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
      availability={props.availability}
      depth={props.depth}
      control={
        <Slider
          className="min-w-0 flex-1"
          value={[px]}
          min={WIDE_READING_WIDTH_MIN_PX}
          max={WIDE_READING_WIDTH_MAX_PX}
          step={WIDE_READING_WIDTH_STEP_PX}
          // A slider's thumb is not a form control, so the row's fieldset
          // cannot turn it off; it is told directly.
          disabled={props.availability.kind === "disabled"}
          onValueChange={(next) => {
            setDraftPx(next[0]);
          }}
          onValueCommit={(next) => {
            writeArrangementField("wideReadingWidthPx", next[0]);
            setDraftPx(null);
          }}
          // Radix skips `onValueCommit` when the drag ends back at its
          // starting value, which would otherwise leave `draftPx` set and
          // the row reading a stale draft past the next external write (a
          // revert, an undo, another window) - see the docstring above.
          onPointerUp={() => setDraftPx(null)}
          onPointerCancel={() => setDraftPx(null)}
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
 */
export function TabOverflowRow(props: AreaRowPlacement): ReactNode {
  const taskTabLayout = useLayoutStore(
    (state) => state.arrangement.taskTabLayout,
  );
  return (
    <PlacementRow
      {...props}
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
      description={TAB_OVERFLOW_ROW.description}
      stacked={false}
      selected={false}
      control={
        <SegmentedControl
          ariaLabel="Tab overflow"
          options={TAB_OVERFLOW_OPTIONS}
          value={taskTabLayout}
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
export function ResourceReadingsRow(
  props: AreaRowPlacement & { readonly context: LayoutFormContext },
): ReactNode {
  const on = props.context.values.resourceMonitor.agentRows;
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
      {...props}
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
      description={
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
 * The whole composer toolbar's chrome - attach, access, model and the
 * microphone - drawn as the real buttons (C3). Stored on Model, the one
 * toolbar region that never hides (G6), and an area row because it styles
 * every member of the toolbar rather than one.
 */
function ToolbarStyleRow(
  props: AreaRowPlacement & { readonly context: LayoutFormContext },
): ReactNode {
  const { context } = props;
  return (
    <StyleRow
      anchor={TOOLBAR_STYLE_ROW.anchor ?? null}
      icon={Paintbrush}
      label={TOOLBAR_STYLE_ROW.label}
      description={TOOLBAR_STYLE_ROW.description}
      styleKey="toolbarStyle"
      labelPlacement="end"
      examples={TOOLBAR_STYLE_EXAMPLES}
      regionId="model"
      values={context.values}
      arrangement={context.arrangement}
      availability={props.availability}
      depth={props.depth}
    />
  );
}

/**
 * Whether the phone layout draws its footer at all (L-51). While it is off,
 * the phone header draws the two readings as icons, and the settings under
 * this row do nothing; the area says so once, under this row (U1).
 */
function MobileFooterRow(props: AreaRowPlacement): ReactNode {
  const arrangement = useLayoutStore((state) => state.arrangement);
  return (
    <PlacementRow
      {...props}
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
      description={MOBILE_FOOTER_ROW.description}
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
