import type { ReactNode } from "react";
import { useTopLevelStripPairPreview } from "@/components/epic-canvas/dnd/dnd-store";
import { LeaderDigitBadge } from "@/components/ui/leader-digit-badge";
import { leaderDigitFor } from "@/components/ui/leader-digit-shortcuts";
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { useRegisteredEpicTitleGenerating } from "@/lib/epic-selectors";
import type { HeaderTab } from "@/stores/tabs/types";
import {
  StripTabContextMenu,
  StripTabTitleInput,
} from "../strip-tab-item-parts";
import { TabLeadingIcon } from "../tab-leading-icon";
import type { StripTabItem, StripTabItemInput } from "../use-strip-tab-item";
import { useLiveAgentsInStrip } from "./strip-agents-mode";
import type { SideTabLiveAgents } from "./agent-meter";
import { useSideTabLiveAgents } from "./side-tab-live-agents";
import { railBadgeOf, type RailBadgeKind } from "./rail-badge-kind";
import type { DropIndicator } from "./side-strip-item-input";
import { SIDE_TAB_TITLE_INPUT_CLASS } from "./side-strip-tokens";
import { RailSectionCard } from "./strip-section-detail";
import {
  sectionStyleOf,
  taskStatusOf,
  twoLineRowOf,
} from "./strip-section-row";
import type { StripTaskRow } from "./strip-sections";
import {
  stripAgentGroupId,
  stripTaskRowId,
  type StripTaskGroup,
} from "./strip-task-group";
import {
  SideTabRow,
  type SideTabRowShape,
  type SideTabRowVariant,
} from "./side-tab-row";
import { SplitPairPreview } from "../split-pair-preview";
import { SideTabHoverCardBody } from "./side-tab-hover-card";
import { joinedAttribute, type SheetJoin } from "./side-tab-join";
import { sideTabTileOf, sideTabTitleIconOf } from "../tab-identity";

/**
 * One task tab's row over its `useStripTabItem` result, inside the tab's own
 * menu. The menu's trigger is a box-less wrapper, because the row takes its
 * element props through `frame` rather than as its own props.
 */
export function SideStripTabRow(props: {
  readonly item: Omit<StripTabItem, "rootRef">;
  readonly rootRef: (node: HTMLDivElement | null) => void;
  readonly input: StripTabItemInput;
  readonly variant: SideTabRowVariant;
  /** A row of its own, or a half of a split pair's row. */
  readonly shape: SideTabRowShape;
  /** The row sits in its group's block or column, which carries the group's colour. */
  readonly inBlock: boolean;
  readonly dropIndicator: DropIndicator;
  /** How this row joins its task's sheet; `null` for a plain row. */
  readonly joined: SheetJoin | null;
  /** The agents nested under this row, whose chevron and state it carries. */
  readonly group: StripTaskGroup | null;
  /** The Activity view's section and what it draws on this row; `null` in the Layered view. */
  readonly section: StripTaskRow | null;
}): ReactNode {
  const { item, input, rootRef } = props;
  const { tab, isActive } = input;
  const epicId = tab.kind === "epic" ? tab.epicId : null;
  const activityStatus = useEpicActivityStatus(epicId);
  const titleGenerating = useRegisteredEpicTitleGenerating(epicId);
  const pairPreview = useTopLevelStripPairPreview(tab.kind, tab.id);
  const agents = useSideTabLiveAgents(epicId);
  // The Activity view shows a task's agents and state in the strip itself, so
  // its card is only the full title of a name the row cuts short.
  const titleOnlyCard = useLiveAgentsInStrip();
  const badge = railBadgeOf(item.indicatorState);
  const groupDisclosure = props.group?.disclosure ?? null;
  const row = props.section;
  const half = props.shape !== "row";
  const section = row === null ? null : sectionStyleOf(row, half);
  const status = taskStatusOf({
    row,
    tabId: tab.id,
    indicator: item.indicatorState,
    agents,
    activityStatus,
    titleGenerating,
    meterHidden: groupDisclosure?.expanded === true,
    half,
  });
  // The rail's tile falls back on the status glyph for a title with no letter.
  const leading = (
    <TabLeadingIcon
      icon={tab.icon}
      identity={null}
      titleGenerationPending={titleGenerating}
      activityStatus={activityStatus}
      indicatorState={item.indicatorState}
      tabId={tab.id}
    />
  );
  const fullCard = fullCardOf({
    tab,
    title: item.displayName,
    variant: props.variant,
    row,
    badge,
    agents,
  });
  return (
    <StripTabContextMenu item={item} input={input}>
      <div className="contents">
        <SideTabRow
          frame={{
            ...item.dragListeners,
            ...item.rootProps,
            ...joinedAttribute(props.joined),
            id: stripTaskRowId(tab.id),
            ...(groupDisclosure === null
              ? {}
              : {
                  "aria-expanded": groupDisclosure.expanded,
                  "aria-controls": stripAgentGroupId(tab.id),
                }),
            ref: rootRef,
            className: "cursor-pointer [-webkit-app-region:no-drag]",
          }}
          variant={props.variant}
          shape={props.shape}
          active={isActive}
          session={sessionOf(tab, isActive)}
          tint={item.appearance?.color ?? null}
          inBlock={props.inBlock}
          titleIcon={sideTabTitleIconOf({
            appearance: item.appearance,
            icon: tab.icon,
          })}
          tile={
            // The session tab is a mode with its own icon, never a monogram.
            tab.kind === "sample-workspace"
              ? { kind: "icon", icon: leading }
              : sideTabTileOf({
                  appearance: item.appearance,
                  title: item.displayTab.name,
                  titleGenerating,
                  fallback: leading,
                })
          }
          badge={badge}
          agents={agents}
          status={status}
          section={section}
          disclosure={
            groupDisclosure === null
              ? null
              : {
                  expanded: groupDisclosure.expanded,
                  animate: groupDisclosure.animate,
                  controlsId: stripAgentGroupId(tab.id),
                  label: `${groupDisclosure.expanded ? "Hide" : "Show"} agents in ${item.displayName}`,
                  onToggle: groupDisclosure.toggle,
                }
          }
          title={
            item.rename.isEditing ? (
              <StripTabTitleInput
                item={item}
                tab={tab}
                className={SIDE_TAB_TITLE_INPUT_CLASS}
              />
            ) : (
              item.displayName
            )
          }
          hoverCardBody={
            titleOnlyCard ? (
              <div
                data-testid="side-tab-hover-card-body"
                className="text-ui-sm font-medium break-words text-foreground"
              >
                {item.displayName}
              </div>
            ) : (
              fullCard
            )
          }
          hoverCardOnOverflow={titleOnlyCard}
          leaderBadge={
            item.leaderBadge === null ? null : (
              <LeaderDigitBadge
                digit={leaderDigitFor(item.leaderBadge.index)}
                modifier={item.leaderBadge.modifier}
                ariaLabel={item.leaderBadge.hint}
                testId={`tab-digit-${leaderDigitFor(item.leaderBadge.index)}`}
                className={undefined}
              />
            )
          }
          close={{
            label: `Close ${item.displayName}`,
            testId: `tab-close-${tab.kind}-${tab.id}`,
            disabled: !item.canClose,
            onClose: item.close,
          }}
          dropIndicator={props.dropIndicator}
          pairPreview={
            pairPreview === null ? null : (
              <SplitPairPreview
                placement="side"
                side={pairPreview}
                title={item.displayName}
                testId="side-tab-pair-preview"
              />
            )
          }
          dragSource={item.isDragging}
        />
      </div>
    </StripTabContextMenu>
  );
}

/**
 * The card body a row or tile opens when it is not showing the title alone. The
 * Activity rail's tile has no second line of its own, so the card of a task
 * that needs the person carries the one its row would.
 */
function fullCardOf(input: {
  readonly tab: HeaderTab;
  readonly title: string;
  readonly variant: SideTabRowVariant;
  readonly row: StripTaskRow | null;
  readonly badge: RailBadgeKind | null;
  readonly agents: SideTabLiveAgents;
}): ReactNode {
  const { tab, title } = input;
  if (tab.kind === "sample-workspace") {
    // A mode, not a task: no agents, so no "Idle" (audit F2).
    return (
      <div
        data-testid="side-tab-hover-card-body"
        className="flex flex-col gap-2"
      >
        <div className="text-ui-sm font-medium text-foreground">{title}</div>
        <div className="text-muted-foreground">Sample workspace</div>
      </div>
    );
  }
  const railRow =
    input.variant === "collapsed" ? twoLineRowOf(input.row) : null;
  if (railRow !== null) return <RailSectionCard title={title} row={railRow} />;
  return (
    <SideTabHoverCardBody
      title={title}
      epicId={tab.kind === "epic" ? tab.epicId : null}
      badge={input.badge}
      agents={input.agents}
    />
  );
}

/** The layout session's own tab (L-163): filled while active, capped at rest. */
function sessionOf(
  tab: HeaderTab,
  isActive: boolean,
): "active" | "rest" | null {
  if (tab.kind !== "sample-workspace") return null;
  return isActive ? "active" : "rest";
}
