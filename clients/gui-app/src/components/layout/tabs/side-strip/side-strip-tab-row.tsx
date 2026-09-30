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
import { sideTabWaitingLabel } from "../tab-waiting";
import type { StripTabItem, StripTabItemInput } from "../use-strip-tab-item";
import { useLiveAgentsInStrip } from "./strip-agents-mode";
import { useSideTabLiveAgents } from "./side-tab-live-agents";
import { railBadgeOf } from "./rail-badge-kind";
import type { DropIndicator } from "./side-strip-item-input";
import { SIDE_TAB_TITLE_INPUT_CLASS } from "./side-strip-tokens";
import {
  stripAgentGroupId,
  stripTaskRowId,
  type StripTaskGroup,
} from "./strip-task-group";
import {
  SideTabRow,
  type SideGroupLine,
  type SideTabRowVariant,
} from "./side-tab-row";
import { SideTabHoverCardBody } from "./side-tab-hover-card";
import { joinedAttribute, type SheetJoin } from "./side-tab-join";
import { sideTabTileOf } from "../tab-identity";

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
  readonly groupLine: SideGroupLine | null;
  readonly dropIndicator: DropIndicator;
  /** How this row joins its task's sheet; `null` for a plain row. */
  readonly joined: SheetJoin | null;
  /** The agents nested under this row, whose chevron and state it carries. */
  readonly group: StripTaskGroup | null;
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
  // The bare status glyph: the custom icon, when there is one, is the tile.
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
  const fullCard =
    tab.kind === "sample-workspace" ? (
      // A mode, not a task: no agents, so no "Idle" (audit F2).
      <div
        data-testid="side-tab-hover-card-body"
        className="flex flex-col gap-2"
      >
        <div className="text-ui-sm font-medium text-foreground">
          {item.displayName}
        </div>
        <div className="text-muted-foreground">Sample workspace</div>
      </div>
    ) : (
      <SideTabHoverCardBody
        title={item.displayName}
        epicId={epicId}
        badge={badge}
        agents={agents}
      />
    );
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
          active={isActive}
          session={sessionOf(tab, isActive)}
          tint={item.appearance?.color ?? null}
          groupLine={props.groupLine}
          leading={leading}
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
          waitingLabel={sideTabWaitingLabel(item.waitingReason)}
          dropIndicator={props.dropIndicator}
          pairPreview={pairPreview}
          dragSource={item.isDragging}
        />
      </div>
    </StripTabContextMenu>
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
