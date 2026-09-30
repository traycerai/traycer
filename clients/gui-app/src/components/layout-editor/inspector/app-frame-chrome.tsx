import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isVoiceInputRowAvailable } from "@/lib/settings/settings-availability";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { Fragment, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  ChevronsUpDown,
  History,
  House,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  type LucideIcon,
} from "lucide-react";
import {
  depictDockRows,
  depictRegion,
} from "@/components/layout-editor/region-depiction";
import { PanelTaskHeaderBody } from "@/components/epic-canvas/sidebar/panel-task-header-body";
import { SampleLiveAgentItems } from "@/components/sample-workspace/sample-strip-live-agents";
import {
  barClusterRegions,
  liveAgentsInStrip,
  type BarHost,
  type BarRegionId,
  type EdgeSide,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import {
  regionValuesHidden,
  type LayoutValues,
} from "@/lib/layout/layout-values";
import { railDisplayEntries } from "@/lib/layout/rail";
import { LeftPanelRailStack } from "@/components/epic-canvas/sidebar/left-panel-rail-stack";
import {
  SideTabMeter,
  type SideTabLiveAgents,
} from "@/components/layout/tabs/side-strip/agent-meter";
import { NO_LIVE_AGENTS } from "@/components/layout/tabs/side-strip/side-tab-live-agents";
import { MonogramChip } from "@/components/layout/tabs/monogram-chip";
import { tabAutoTint } from "@/components/layout/tabs/tab-identity";
import {
  SIDE_STRIP_ACCOUNT_ROW_CLASS,
  SIDE_STRIP_FOOT_CLASS,
  SIDE_STRIP_INSET_CLASS,
  SIDE_STRIP_LIST_CLASS,
  SIDE_STRIP_NAV_TILE_CLASS,
  SIDE_STRIP_RAIL_DIVIDER_CLASS,
  SIDE_STRIP_RAIL_NAV_CLASS,
  SIDE_STRIP_SECTION_LABEL_CLASS,
  SIDE_TAB_ACTIVE_CLASS,
  SIDE_TAB_LEADING_CLASS,
  SIDE_TAB_ROW_CLASS,
  SIDE_TAB_TILE_ACTIVE_CLASS,
  SIDE_TAB_TILE_CLASS,
  SIDE_TAB_TITLE_CLASS,
  STRIP_AGENT_GROUP_CLASS,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";
import type {
  RailRegionId,
  RegionId,
  ToolbarRegionId,
} from "@/lib/layout/region-id";
import {
  joinedAttribute,
  type SheetJoin,
} from "@/components/layout/tabs/side-strip/side-tab-join";
import { cn } from "@/lib/utils";

/**
 * The app's frame around the regions, for the preset cards' miniatures: the
 * tab labels, the header's icon cluster, the composer's box and its toolbar
 * clusters, the rail's dividers, and the dock's split into pills above one
 * joined frame - everything in the picture that is NOT a region.
 *
 * Placement stays with the caller (the miniature draws these inside a
 * 1000x620 frame with the app's own bars and paddings), so nothing here takes
 * a size or a padding. The side strip takes its edge and whether it is
 * collapsed: both are what the strip IS at that placement.
 */
export interface AppFrame {
  readonly values: LayoutValues;
  readonly arrangement: LayoutArrangement;
}

/** A task tab in the picture, which is chrome rather than a region. */
interface AppFrameTask {
  /** Seeds the auto tint (D11), as an epic id does. */
  readonly id: string;
  readonly label: string;
  readonly monogram: string;
  readonly active: boolean;
  readonly agents: SideTabLiveAgents;
}

/** The active task, whose panel sheet the frame draws beside the strip. */
const APP_FRAME_ACTIVE_TASK: AppFrameTask = {
  id: "app-frame-sample",
  label: "Sample chat",
  monogram: "SC",
  active: true,
  // The sample agents' two unfinished turns: one working, one waiting on a reply.
  agents: { turn: 2, background: 0, coverage: "covered" },
};

/** The tasks in every picture of the frame: the top bar's tabs, the strip's rows and tiles. */
const APP_FRAME_TABS: ReadonlyArray<AppFrameTask> = [
  {
    id: "app-frame-onboarding",
    label: "Onboarding flow",
    monogram: "OF",
    active: false,
    agents: { turn: 1, background: 0, coverage: "covered" },
  },
  APP_FRAME_ACTIVE_TASK,
  {
    id: "app-frame-release",
    label: "Release notes",
    monogram: "RN",
    active: false,
    agents: { turn: 0, background: 0, coverage: "covered" },
  },
];

/**
 * The top bar's row, minus the row itself: its two clusters, the home tab, the
 * tab strip and the header's own glyphs.
 *
 * A reading that named the header draws in the end it named (L-156), as
 * `HeaderBarCluster` renders it: left of the tabs or right of them, framed as
 * the top bar.
 *
 * Drawn with their real labels, because two blank rectangles are not a picture
 * of a top bar (I-03).
 */
export function AppFrameTopBar({ values, arrangement }: AppFrame): ReactNode {
  return (
    <>
      <AppFrameBarCluster
        host="header"
        side="left"
        values={values}
        arrangement={arrangement}
      />
      <AppFrameTabEntries values={values} arrangement={arrangement} />
      <span className="flex-1" />
      <AppFrameBarCluster
        host="header"
        side="right"
        values={values}
        arrangement={arrangement}
      />
      <History aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <Bell aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="size-5 shrink-0 rounded-full border border-border bg-foreground/10" />
    </>
  );
}

/**
 * The fake tabs as the top bar draws them, alongside Home: the top bar's
 * original markup, untouched. The side strip draws the same tasks through
 * `AppFrameSideStrip`, as rows or rail tiles.
 */
function AppFrameTabEntries({ values, arrangement }: AppFrame): ReactNode {
  return (
    <>
      <AppFrameRegion
        regionId="homeTab"
        values={values}
        arrangement={arrangement}
      />
      {APP_FRAME_TABS.map((tab) => (
        <span
          key={tab.id}
          // The active tab runs into its task's sheet, as the live one does; the
          // frame drawing this bar draws the bridge.
          {...(tab.active ? { "data-sheet-joined": "top" } : {})}
          className={cn(
            "flex h-8 shrink-0 items-center rounded-xl border border-transparent px-3 text-ui-sm text-muted-foreground",
            tab.active && "border-canvas-border bg-background text-foreground",
          )}
        >
          {tab.label}
        </span>
      ))}
    </>
  );
}

/** A task's monogram chip, the strip's and the panel header's own (D11). */
function AppFrameTaskChip(props: { readonly task: AppFrameTask }): ReactNode {
  return (
    <MonogramChip
      tile={{ kind: "monogram", text: props.task.monogram }}
      tint={tabAutoTint(props.task.id)}
      tinted
    />
  );
}

/**
 * The vertical strip as the shell draws it on the ground (D3-D6, F1, F7): the
 * top row (history arrows, the collapse toggle), the Notifications and All tasks
 * rows, Home, the primary New Task row, "Tasks" and its count, the task rows,
 * and the foot with the header-hosted readings over the account row.
 * Collapsed, the 60px rail as one centred column: the expand, Notifications, All
 * tasks and New Task tiles, a divider, Home and a 40x44 tile per task (its
 * monogram chip over its meter), then the avatar.
 *
 * The active task always joins its task's sheet, as the live strip's does,
 * through the same `data-sheet-joined` marker and the same bridge span, which
 * the shipped stylesheet paints. In the Activity view the expanded strip lists
 * the active task's live agents under its row (D9).
 *
 * Takes no size or padding: the strip's width and its place in the frame stay
 * with the caller. `relative`, because the bridge is positioned in it.
 */
export function AppFrameSideStrip({
  values,
  arrangement,
  edge,
  collapsed,
}: AppFrame & {
  readonly edge: EdgeSide;
  readonly collapsed: boolean;
}): ReactNode {
  const liveAgents = liveAgentsInStrip(
    arrangement.tabStripPlacement,
    collapsed,
    arrangement.sideStripView,
  );
  const CollapseIcon = COLLAPSE_ICON[edge][collapsed ? "expand" : "collapse"];
  const home = values.homeTab.shown === "shown";
  const join: SheetJoin = {
    edge,
    pane: arrangement.sidebarSide === edge ? "panel" : "canvas",
  };
  return (
    <div
      data-testid="app-frame-side-strip"
      data-collapsed={collapsed}
      className="relative flex flex-1 flex-col text-canvas-foreground"
    >
      {collapsed ? (
        <div className="flex flex-col items-center">
          <div className={cn(SIDE_STRIP_RAIL_NAV_CLASS, "pt-2")}>
            <AppFrameNavTile icon={CollapseIcon} primary={false} />
            <AppFrameNavTile icon={Bell} primary={false} />
            <AppFrameNavTile icon={History} primary={false} />
            <AppFrameNavTile icon={Plus} primary />
          </div>
          <span
            className={cn(
              SIDE_STRIP_RAIL_DIVIDER_CLASS,
              "shrink-0",
              !home && "mb-0",
            )}
          />
          {home ? <AppFrameHomeTile /> : null}
        </div>
      ) : (
        <div className={cn("flex flex-col gap-1 pt-2", SIDE_STRIP_INSET_CLASS)}>
          <div className="flex h-7 items-center gap-1 text-muted-foreground">
            <ArrowLeft aria-hidden className="size-4 shrink-0" />
            <ArrowRight aria-hidden className="size-4 shrink-0" />
            <span className="flex-1" />
            <CollapseIcon aria-hidden className="size-4 shrink-0" />
          </div>
          <AppFrameNavRow icon={Bell} label="Notifications" />
          <AppFrameNavRow icon={History} label="All tasks" />
          {home ? <AppFrameNavRow icon={House} label="Home" /> : null}
          <span
            className={cn(
              "flex items-center bg-primary font-medium text-primary-foreground",
              SIDE_TAB_ROW_CLASS,
            )}
          >
            <Plus
              aria-hidden
              className={cn(SIDE_TAB_LEADING_CLASS, "shrink-0")}
            />
            <span className={cn(SIDE_TAB_TITLE_CLASS, "truncate")}>
              New Task
            </span>
          </span>
          <div
            className={cn(
              SIDE_STRIP_SECTION_LABEL_CLASS,
              "flex items-center text-muted-foreground",
            )}
          >
            <span className="min-w-0 flex-1">Tasks</span>
            <span className="tabular-nums">{APP_FRAME_TABS.length}</span>
          </div>
        </div>
      )}
      <div
        className={cn(
          SIDE_STRIP_LIST_CLASS[collapsed ? "collapsed" : "expanded"],
          collapsed && "items-center",
        )}
      >
        {collapsed ? (
          APP_FRAME_TABS.map((task) => (
            <AppFrameTaskTile key={task.id} task={task} joined={join} />
          ))
        ) : (
          <AppFrameStripTaskRows
            liveAgents={liveAgents}
            joined={join}
            startAtActive={false}
          />
        )}
      </div>
      <span className="flex-1" />
      <div
        data-testid="app-frame-side-strip-foot"
        className={cn(
          SIDE_STRIP_FOOT_CLASS,
          "flex flex-col",
          collapsed ? "items-center" : "items-stretch",
        )}
      >
        {/* The live foot's readings row (F6): one equal share each, so two
            split the row and one takes all of it; collapsed, stacked tiles. */}
        <div
          className={cn(
            "gap-2 empty:hidden",
            collapsed
              ? "flex w-10 flex-col"
              : "grid auto-cols-fr grid-flow-col",
          )}
        >
          <AppFrameBarCluster
            host="header"
            side="left"
            values={values}
            arrangement={arrangement}
          />
          <AppFrameBarCluster
            host="header"
            side="right"
            values={values}
            arrangement={arrangement}
          />
        </div>
        <AppFrameAccount collapsed={collapsed} />
      </div>
      <span
        aria-hidden
        data-sheet-join-bridge={edge}
        data-join-active=""
        data-join-pane={join.pane}
      />
    </div>
  );
}

const COLLAPSE_ICON: Readonly<
  Record<EdgeSide, Readonly<Record<"collapse" | "expand", LucideIcon>>>
> = {
  left: { collapse: PanelLeftClose, expand: PanelLeftOpen },
  right: { collapse: PanelRightClose, expand: PanelRightOpen },
};

/** An expanded nav row (Notifications, All tasks, Home): the row's own box and type. */
function AppFrameNavRow(props: {
  readonly icon: LucideIcon;
  readonly label: string;
}): ReactNode {
  const Icon = props.icon;
  return (
    <span
      className={cn(
        "flex items-center text-muted-foreground",
        SIDE_TAB_ROW_CLASS,
      )}
    >
      <Icon aria-hidden className={cn(SIDE_TAB_LEADING_CLASS, "shrink-0")} />
      <span className={cn(SIDE_TAB_TITLE_CLASS, "truncate")}>
        {props.label}
      </span>
    </span>
  );
}

/** A collapsed nav control: the rail's 32px icon tile; New Task's is primary. */
function AppFrameNavTile(props: {
  readonly icon: LucideIcon;
  readonly primary: boolean;
}): ReactNode {
  const Icon = props.icon;
  return (
    <span
      className={cn(
        SIDE_STRIP_NAV_TILE_CLASS,
        "flex shrink-0 items-center justify-center",
        props.primary
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground",
      )}
    >
      <Icon aria-hidden className="size-4" />
    </span>
  );
}

/** Home on the rail: a 40x44 tile with its icon where a task's chip sits. */
function AppFrameHomeTile(): ReactNode {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center text-muted-foreground",
        SIDE_TAB_TILE_CLASS,
      )}
    >
      <MonogramChip
        tile={{ kind: "icon", icon: <House aria-hidden className="size-4" /> }}
        tint={null}
        tinted={false}
      />
      <SideTabMeter agents={NO_LIVE_AGENTS} attention={null} size="tile" />
    </span>
  );
}

/**
 * The expanded strip's task rows, with the active task's live agents under its
 * row in the Activity view (D9): the strip draws them, and so does each Side
 * tab view picture, without the sheet join a lone picture has no sheet for.
 */
export function AppFrameStripTaskRows(props: {
  readonly liveAgents: boolean;
  readonly joined: SheetJoin | null;
  /** From the active task's row down, which is all a small picture needs. */
  readonly startAtActive: boolean;
}): ReactNode {
  const tasks = props.startAtActive
    ? APP_FRAME_TABS.slice(APP_FRAME_TABS.indexOf(APP_FRAME_ACTIVE_TASK))
    : APP_FRAME_TABS;
  return tasks.map((task) => (
    <Fragment key={task.id}>
      <AppFrameTaskRow task={task} joined={props.joined} />
      {task.active && props.liveAgents ? <AppFrameLiveAgents /> : null}
    </Fragment>
  ));
}

/**
 * An expanded task row: the empty 16px leading slot of an uncoloured, idle
 * task, the title, and the meter while more than one agent is live.
 */
function AppFrameTaskRow(props: {
  readonly task: AppFrameTask;
  readonly joined: SheetJoin | null;
}): ReactNode {
  const { task } = props;
  return (
    <span
      {...joinedAttribute(task.active ? props.joined : null)}
      className={cn(
        "flex items-center text-muted-foreground",
        SIDE_TAB_ROW_CLASS,
        task.active && cn("text-foreground", SIDE_TAB_ACTIVE_CLASS),
      )}
    >
      <span aria-hidden className={cn(SIDE_TAB_LEADING_CLASS, "shrink-0")} />
      <span className={cn(SIDE_TAB_TITLE_CLASS, "min-w-0 flex-1 truncate")}>
        {task.label}
      </span>
      {task.agents.turn + task.agents.background > 1 ? (
        <SideTabMeter agents={task.agents} attention={null} size="row" />
      ) : null}
    </span>
  );
}

/** A rail tile: the task's monogram chip over its meter, 40x44. */
function AppFrameTaskTile(props: {
  readonly task: AppFrameTask;
  readonly joined: SheetJoin;
}): ReactNode {
  const { task } = props;
  return (
    <span
      {...joinedAttribute(task.active ? props.joined : null)}
      className={cn(
        "flex shrink-0 items-center justify-center",
        SIDE_TAB_TILE_CLASS,
        task.active && SIDE_TAB_TILE_ACTIVE_CLASS,
      )}
    >
      <AppFrameTaskChip task={task} />
      <SideTabMeter agents={task.agents} attention={null} size="tile" />
    </span>
  );
}

/** The active task's panel header: its chip and title, as the real panel draws them. */
export function AppFramePanelTaskHeader(): ReactNode {
  return (
    <PanelTaskHeaderBody
      testId={null}
      chip={<AppFrameTaskChip task={APP_FRAME_ACTIVE_TASK} />}
      title={APP_FRAME_ACTIVE_TASK.label}
      titleEditor={null}
      titleAction={null}
    />
  );
}

/** The active task's live agents under its row, as the Activity view nests them (D9). */
function AppFrameLiveAgents(): ReactNode {
  return (
    <ul data-testid="app-frame-live-agents" className={STRIP_AGENT_GROUP_CLASS}>
      <SampleLiveAgentItems />
    </ul>
  );
}

/** The foot's account row (avatar, name, host line), or the avatar tile alone. */
function AppFrameAccount(props: { readonly collapsed: boolean }): ReactNode {
  const avatar = (
    <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-micro font-medium text-muted-foreground">
      S
    </span>
  );
  if (props.collapsed) {
    return (
      <span
        className={cn(
          SIDE_STRIP_NAV_TILE_CLASS,
          "flex shrink-0 items-center justify-center",
        )}
      >
        {avatar}
      </span>
    );
  }
  return (
    <span
      className={cn("flex min-w-0 items-center", SIDE_STRIP_ACCOUNT_ROW_CLASS)}
    >
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui-sm font-medium text-foreground">
          Sample account
        </span>
        <span className="truncate text-ui-xs text-muted-foreground">
          Sample host
        </span>
      </span>
      <ChevronsUpDown
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    </span>
  );
}

/**
 * The dock and the composer as the app assembles them (L-97, L-99): the
 * compact pills above the composer's left edge, the full-size rows in one
 * joined frame whose bottom edge disappears under the box, and the box itself.
 *
 * One stack rather than three parts, because the tuck only exists while the
 * frame touches the composer: anything a caller could put between them would
 * break it, and one of the two callers used to.
 */
export function AppFrameComposerStack({
  values,
  arrangement,
}: AppFrame): ReactNode {
  return (
    <div className="flex w-full flex-col">
      <AppFrameDock values={values} arrangement={arrangement} />
      <AppFrameComposerBox values={values} arrangement={arrangement} />
    </div>
  );
}

/**
 * The dock, split the way the canvas splits it.
 *
 * The pills go ABOVE the joined frame, both at the composer's left edge. Drawn
 * as separate cards, the Compact card had nothing left to claim: the fold to
 * chips IS the claim (G1-02), so the two shapes have to look different from
 * each other here.
 */
function AppFrameDock({ values, arrangement }: AppFrame): ReactNode {
  const shown = arrangement.dock.filter(
    (regionId) => values[regionId].shown === "shown",
  );
  const rows = shown.filter((regionId) => values[regionId].size === "full");
  const chips = shown.filter((regionId) => values[regionId].size === "chip");
  if (rows.length === 0 && chips.length === 0) return null;
  return (
    <div
      data-testid="app-frame-dock"
      className={cn(
        "flex flex-col gap-1.5",
        // `-mb-px` over a frame with no bottom border: the seam between the
        // dock and the composer is one line, not two touching ones. With no
        // frame there is nothing to tuck, and the pills keep their own gap.
        rows.length > 0 ? "-mb-px" : "mb-1.5",
      )}
    >
      {chips.length === 0 ? null : (
        <div
          data-testid="app-frame-dock-chips"
          className="flex items-center gap-1.5"
        >
          {chips.map((regionId) => (
            <span key={regionId}>
              {/* Framed as a chip because its VALUES say so, which is what
                `hostContextFor` reads; this list is the chip-sized members. */}
              {depictRegion(regionId, values[regionId], arrangement)}
            </span>
          ))}
        </div>
      )}
      {rows.length === 0 ? null : depictDockRows(rows, values, arrangement)}
    </div>
  );
}

/**
 * The composer: a box with the prompt line above its two toolbar clusters.
 *
 * A box and nothing more. What the composer LOOKS like inside is the
 * depictions' business.
 *
 * `bg-foreground/3` rather than `bg-card`, for the reason I-03 exists: every
 * dark preset defines `--card` as `--background`, so a `bg-card` box on this
 * frame is a border around nothing. It is also the real composer shell's own
 * material.
 */
function AppFrameComposerBox({ values, arrangement }: AppFrame): ReactNode {
  return (
    <div
      data-testid="app-frame-composer"
      className="rounded-xl border border-border bg-foreground/3 px-3 pt-2.5 pb-2"
    >
      <div className="pb-4 text-ui-sm text-muted-foreground">
        Describe the next change...
      </div>
      <div className="flex items-center">
        <AppFrameToolbarCluster
          regionIds={arrangement.toolbarLeft}
          values={values}
          arrangement={arrangement}
        />
        <span className="flex-1" />
        <AppFrameToolbarCluster
          regionIds={arrangement.toolbarRight}
          values={values}
          arrangement={arrangement}
        />
        <span className="ml-1.5 size-6 shrink-0 rounded-full border border-border bg-foreground/10" />
      </div>
    </div>
  );
}

function AppFrameToolbarCluster(props: {
  readonly regionIds: ReadonlyArray<ToolbarRegionId>;
  readonly values: LayoutValues;
  readonly arrangement: LayoutArrangement;
}): ReactNode {
  const { regionIds, values, arrangement } = props;
  return (
    <div className="flex items-center gap-1.5">
      {regionIds.map((regionId) => (
        <AppFrameRegion
          key={regionId}
          regionId={regionId}
          values={values}
          arrangement={arrangement}
        />
      ))}
    </div>
  );
}

/**
 * The status strip's ordered children, and nothing else.
 *
 * Which of the two readings leads and where the spacer goes is ASSEMBLY
 * rather than placement, and it lives here once: the preset card and the
 * Settings band draw the strip through this, so they cannot disagree about it
 * (R1-04, R2-02).
 *
 * The bar's own BOX stays with each caller, and so does each one's answer for
 * a strip with nothing left in it, because those two genuinely differ: the
 * miniature draws no strip at all, the page's band draws a sentence saying
 * where its readings went.
 */
export function AppFrameStatusBarRow({
  values,
  arrangement,
}: AppFrame): ReactNode {
  return (
    <>
      <AppFrameBarCluster
        host="status-bar"
        side="left"
        values={values}
        arrangement={arrangement}
      />
      <span className="flex-1" />
      <AppFrameBarCluster
        host="status-bar"
        side="right"
        values={values}
        arrangement={arrangement}
      />
    </>
  );
}

/**
 * One end of one bar: the readings that named it, in the model's own order
 * (L-156).
 *
 * Both bars draw their clusters through this, so the picture cannot put the
 * monitor ahead of the usage limits in one place and behind it in another -
 * and neither bar has to know which regions can move.
 */
function AppFrameBarCluster(props: {
  readonly host: BarHost;
  readonly side: EdgeSide;
  readonly values: LayoutValues;
  readonly arrangement: LayoutArrangement;
}): ReactNode {
  const { host, side, values, arrangement } = props;
  return barClusterRegions(arrangement, host, side).map(
    (regionId: BarRegionId) => (
      <AppFrameRegion
        key={regionId}
        regionId={regionId}
        values={values}
        arrangement={arrangement}
      />
    ),
  );
}

/**
 * The real rail: the arrangement's own entries, dividers and stacks included
 * (L-155, L-166), in the order the list beside them is in, across the top of
 * the panel sheet as the expanded panel draws it. Each panel brings its own
 * rail frame, so this adds no spacing of its own.
 *
 * A stack is drawn as the same one group icon the real rail draws, through
 * the same component (L-11, G3, L-181): the card is a picture of the app at
 * rest, where a stack shows its top panel's icon and no count.
 *
 * A panel the user hid leaves a gap exactly as it leaves one in the rail;
 * `auto` is not off, so only `hidden` does. It leaves its stack too, which
 * is what `railDisplayEntries` answers for every rail at once.
 */
export function AppFrameRailEntries({
  values,
  arrangement,
}: AppFrame): ReactNode {
  return railDisplayEntries(
    arrangement.rail,
    (regionId) => values[regionId].shown !== "hidden",
  ).map((entry) => {
    if (entry.kind === "divider") {
      // The space a divider is at rest, and nothing else (L-11, L-140): a
      // preset card is a picture of the app AT REST, and there a divider draws
      // the column's own gap again rather than a line. The hairline this used
      // to draw was a picture of something the sidebar never shows.
      return <span key={entry.id} className="h-full w-1 shrink-0" />;
    }
    if (entry.kind === "stack") {
      return (
        <LeftPanelRailStack
          key={entry.id}
          stackId={entry.id}
          memberCount={entry.members.length}
          showCount={false}
        >
          {depictRailRegion(entry.members[0], values, arrangement)}
        </LeftPanelRailStack>
      );
    }
    return (
      <span key={entry.id}>
        {depictRailRegion(entry.id, values, arrangement)}
      </span>
    );
  });
}

function depictRailRegion(
  regionId: RailRegionId,
  values: LayoutValues,
  arrangement: LayoutArrangement,
): ReactNode {
  return depictRegion(regionId, values[regionId], arrangement);
}

/**
 * One region, drawn only where the surface really draws it.
 *
 * There are exactly TWO askers of "is this drawn", and they ask different
 * questions: this one, whose regions have a two-state `shown`, and
 * `AppFrameRailEntries` above, because `RailValues.shown` is
 * `auto | shown | hidden` and `auto` is the shipped default for all nine
 * panels (L-93) - so `!== "shown"` would hide every panel nobody has touched.
 *
 * The parameter excludes `RailRegionId` for that reason (R2-06): the signature
 * used to invite a caller to draw a rail panel through here, and every
 * untouched panel would have vanished from that picture with nothing red
 * anywhere.
 */
export function AppFrameRegion<
  K extends Exclude<RegionId, RailRegionId>,
>(props: {
  readonly regionId: K;
  readonly values: LayoutValues;
  readonly arrangement: LayoutArrangement;
}): ReactNode {
  const { regionId, values, arrangement } = props;
  const regionValues = values[regionId];
  const availability = useSettingsAvailabilityContext();
  const voiceEnabled = useSettingsStore((state) => state.voiceInputEnabled);
  if (
    regionId === "mic" &&
    (!isVoiceInputRowAvailable(availability) || !voiceEnabled)
  )
    return null;
  if (regionValuesHidden(regionValues)) return null;
  return depictRegion(regionId, regionValues, arrangement);
}
