import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useChatRowOpenRef } from "@/components/epic-canvas/sidebar/use-chat-row-open-ref";
import { useLayoutSettingPart } from "@/components/layout-editor/use-layout-surface";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  useRegisteredEpicLiveAgents,
  useRegisteredEpicSessionHostId,
} from "@/lib/epic-selectors";
import { activateTabIntent, resourceEpicTabIntent } from "@/lib/tab-navigation";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { cn } from "@/lib/utils";
import {
  STRIP_AGENT_FADE_IN_CLASS,
  STRIP_AGENT_GROUP_CLASS,
  STRIP_AGENT_ROW_CLASS,
  STRIP_AGENT_VISIBLE_MAX,
} from "./side-strip-tokens";
import { StripAgentRow } from "./strip-agent-row";
import {
  stripAgentGroupId,
  stripTaskRowId,
  type StripGroupRow,
  type StripTaskGroup,
} from "./strip-task-group";
import type { StripAgent } from "./strip-task-agents";
import { useNeedsYouActivation } from "./use-needs-you-activation";

const NO_FOCUS = {
  focusedAt: undefined,
  focusArtifactId: undefined,
  focusThreadId: undefined,
  migrationSource: undefined,
};

/**
 * A task's nested agents under its row in the Activity view (D9): a
 * `role="group"` labelled by the task row, holding plain buttons. It is not a
 * tab, so the strip stays one tablist and the selected tab is still the one
 * `aria-selected` names.
 *
 * Expanded shows five agents and then "Show N more"; the layout editor's
 * sample task's group is Side tab view's part on the canvas.
 */
export function StripAgentGroup(props: {
  readonly group: StripTaskGroup | null;
}): ReactNode {
  if (props.group === null) return null;
  return <StripAgentGroupBody group={props.group} />;
}

function StripAgentGroupBody(props: {
  readonly group: StripTaskGroup;
}): ReactNode {
  const { group } = props;
  const [showAll, setShowAll] = useState(false);
  const activate = useNeedsYouActivation();
  const part = useLayoutSettingPart("sideStripView");
  const shown = showAll
    ? group.rows
    : group.rows.slice(0, STRIP_AGENT_VISIBLE_MAX);
  const more = group.rows.length - shown.length;
  const fade =
    group.disclosure?.animate === true ? STRIP_AGENT_FADE_IN_CLASS : undefined;
  return (
    <div
      id={stripAgentGroupId(group.tabId)}
      role="group"
      aria-labelledby={stripTaskRowId(group.tabId)}
      data-testid="strip-agent-group"
      data-ghost={group.ghost ? "1" : undefined}
      // A collapsed task with nobody waiting keeps the group its chevron
      // controls, but out of the accessibility tree.
      hidden={group.rows.length === 0}
      ref={group.epicId === null ? part : undefined}
      className={STRIP_AGENT_GROUP_CLASS}
    >
      {shown.map((row) => (
        <div key={row.agent.id} className={fade}>
          <GroupRow group={group} row={row} onNeedsYou={activate} />
        </div>
      ))}
      {more > 0 ? (
        <button
          type="button"
          data-testid="strip-agent-show-more"
          onClick={() => {
            setShowAll(true);
          }}
          className={cn(STRIP_AGENT_ROW_CLASS, fade)}
        >
          <span aria-hidden className="size-1.5 shrink-0" />
          Show {more} more
        </button>
      ) : null}
    </div>
  );
}

function GroupRow(props: {
  readonly group: StripTaskGroup;
  readonly row: StripGroupRow;
  readonly onNeedsYou: (row: MergedNotificationRow) => void;
}): ReactNode {
  const { group, row, onNeedsYou } = props;
  const { notification } = row;
  if (notification !== null) {
    return (
      <StripAgentRow
        agent={row.agent}
        onClick={() => {
          onNeedsYou(notification);
        }}
      />
    );
  }
  if (group.epicId === null) {
    return <StripAgentRow agent={row.agent} onClick={undefined} />;
  }
  return (
    <OpenAgentRow
      epicId={group.epicId}
      tabId={group.tabId}
      active={group.active}
      agent={row.agent}
    />
  );
}

/**
 * A warm task's agent row: a click opens the chat in that task's canvas, or
 * focuses its tile when it is already open, activating the task first when it
 * is not the one in front. The open is built from the task's session, not from
 * its canvas, so it works from the strip.
 */
function OpenAgentRow(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly active: boolean;
  readonly agent: StripAgent;
}): ReactNode {
  const { epicId, tabId, active, agent } = props;
  const refs = useMemo(
    () => [{ epicId, agentId: agent.id }],
    [epicId, agent.id],
  );
  const [live] = useRegisteredEpicLiveAgents(refs);
  const sessionHostId = useRegisteredEpicSessionHostId(epicId);
  const openRef = useChatRowOpenRef({
    epicId,
    nodeId: agent.id,
    nodeName: agent.title ?? "",
    openableType: live?.kind ?? "chat",
    ownerHostId: live?.hostId ?? null,
    ownerUserId: live?.userId ?? null,
    sessionHostId,
  });
  const { openTile } = useEpicTileNavigation();
  const navigate = useNavigate();
  return (
    <StripAgentRow
      agent={agent}
      onClick={() => {
        const node = openRef();
        if (active) {
          openTile(tileIntent(node, { tabId }, "single", "direct_ui"));
          return;
        }
        // Tile placement alone does not activate another task's header tab.
        activateTabIntent(
          navigate,
          resourceEpicTabIntent({
            epicId,
            tabId,
            name: undefined,
            focus: NO_FOCUS,
            preparation: { kind: "open-tile", node, gesture: "single" },
            includeNestedFocus: true,
          }),
          undefined,
        );
      }}
    />
  );
}
