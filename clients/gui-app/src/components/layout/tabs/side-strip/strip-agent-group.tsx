import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { useChatTranscriptJumpStore } from "@/stores/chats/chat-transcript-jump-store";
import {
  clearPaneOutline,
  flashPaneOf,
  outlinePaneOf,
} from "@/stores/epics/canvas/pane-emphasis-store";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { cn } from "@/lib/utils";
import {
  STRIP_AGENT_FADE_IN_CLASS,
  STRIP_AGENT_GROUP_CLASS,
  STRIP_AGENT_ROW_CLASS,
  STRIP_AGENT_VISIBLE_MAX,
} from "./side-strip-tokens";
import { useAgentOnScreen } from "./strip-agent-on-screen";
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
          <span aria-hidden className="size-3.5 shrink-0" />
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
    // A prompt with no agent to open: the notification's own activation.
    return (
      <StripAgentRow
        agent={row.agent}
        onScreen={false}
        onClick={() => {
          onNeedsYou(notification);
        }}
        onHoverChange={undefined}
      />
    );
  }
  if (group.epicId === null) {
    return (
      <StripAgentRow
        agent={row.agent}
        onScreen={false}
        onClick={undefined}
        onHoverChange={undefined}
      />
    );
  }
  return (
    <OpenAgentRow
      epicId={group.epicId}
      tabId={group.tabId}
      active={group.active}
      agent={row.agent}
      prompt={row.prompt}
      onNeedsYou={onNeedsYou}
    />
  );
}

/**
 * A warm task's agent row. It shows where the agent's chat is, and a click
 * takes the person to where that chat is live: it opens in the task's canvas,
 * or focuses the tile that is already open there, activating the task first
 * when it is not the one in front (the open is built from the task's session,
 * not its canvas, so it works from the strip). The chat then scrolls to its
 * live point: a prompt waiting on the person through the notification's own
 * activation, which lands on the pending card, and any other agent's at the
 * end of its transcript.
 *
 * The click also flashes the pane when it moves focus between two panes that
 * are both on screen, the one move nothing else on screen shows. Hovering a row
 * whose chat is on screen outlines its pane.
 */
function OpenAgentRow(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly active: boolean;
  readonly agent: StripAgent;
  readonly prompt: MergedNotificationRow | null;
  readonly onNeedsYou: (row: MergedNotificationRow) => void;
}): ReactNode {
  const { epicId, tabId, active, agent, prompt, onNeedsYou } = props;
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
  const requestJump = useChatTranscriptJumpStore((state) => state.requestJump);
  const identity = useMemo(() => openRef(), [openRef]);
  const onScreen = useAgentOnScreen(tabId, identity);
  const [hovering, setHovering] = useState(false);
  const outlinedInstanceId =
    hovering && onScreen !== null ? onScreen.instanceId : null;
  useEffect(() => {
    if (outlinedInstanceId === null) return;
    outlinePaneOf(outlinedInstanceId);
    return () => {
      clearPaneOutline(outlinedInstanceId);
    };
  }, [outlinedInstanceId]);
  return (
    <StripAgentRow
      agent={agent}
      onScreen={onScreen !== null}
      onHoverChange={setHovering}
      onClick={() => {
        if (onScreen !== null && !onScreen.focused) {
          flashPaneOf(onScreen.instanceId);
        }
        if (prompt !== null) {
          onNeedsYou(prompt);
          return;
        }
        const node = openRef();
        if (active) {
          openTile(tileIntent(node, { tabId }, "single", "direct_ui"));
        } else {
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
        }
        // Parked, so a chat this click opens picks it up when it mounts.
        if (node.type === "chat") {
          requestJump(node.hostId, node.id, { kind: "end" });
        }
      }}
    />
  );
}
