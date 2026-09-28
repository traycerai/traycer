import { useContext, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import {
  LIVE_AGENTS_LIST_CLASS,
  LiveAgentRowView,
  type LiveAgentKind,
} from "@/components/epic-canvas/sidebar/live-agent-row";
import {
  CHATS_TREE_FILTER,
  sidebarTreeRootIds,
} from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { useChatRowOpenRef } from "@/components/epic-canvas/sidebar/use-chat-row-open-ref";
import { ownChatStatusKind } from "@/components/epic-canvas/sidebar/use-chat-archive-hidden-ids";
import { useLiveAgentsSlot } from "@/components/layout/tabs/side-strip/live-agents-slot-store";
import { ChatIndicatorHostScopes } from "@/components/notifications/chat-indicator-host-scopes";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useEpicStore } from "@/hooks/use-epic-store";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  useEpicAgentActivityTiers,
  useEpicNodeHostId,
  useEpicNodeHostIds,
  useEpicNodeOwnerUserId,
  useEpicNodeUpdatedAt,
  useEpicTreeIndex,
} from "@/lib/epic-selectors";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { chatIndicatorHostScopes } from "@/lib/notifications/chat-indicator-scopes";
import { isOpenableEpicNodeKind } from "@/stores/epics/canvas/types";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import type { TreeSlice } from "@/stores/epics/open-epic/types";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import {
  selectAgentActivityCoverage,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";
import { selectNotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

interface LiveAgentRow {
  readonly nodeId: string;
  readonly kind: LiveAgentKind;
  /** How many live agents it sits under. */
  readonly depth: number;
}

/**
 * The Activity view's live agents list (D9), owned by the epic surface and
 * portalled into the strip's slot under this tab's row, so it reads this
 * surface's session and no second one mounts. Nothing renders while the
 * strip does not ask for it, nor while the session is still opening: a new
 * task's surface mounts with a null handle, and the list reads the store.
 */
export function StripLiveAgentsPortal(props: {
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  const slot = useLiveAgentsSlot(props.tabId);
  if (slot === null) return null;
  return createPortal(
    <EpicSessionGate fallback={null}>
      <StripLiveAgents epicId={props.epicId} tabId={props.tabId} />
    </EpicSessionGate>,
    slot,
  );
}

/**
 * Every agent's notification state, asked of each agent's own host like the
 * Agents tree asks, so a waiting or failed agent lists the same way it shows
 * there.
 */
function StripLiveAgents(props: {
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  const { epicId } = props;
  const chatIds = useEpicStore(
    useShallow((state: OpenEpicState) => agentIdsOf(state.tree)),
  );
  const hostIds = useEpicNodeHostIds(chatIds);
  const sessionHostId = useEpicSessionHostId();
  const scopes = useMemo(
    () =>
      chatIndicatorHostScopes(
        chatIds.map((chatId, index) => ({
          chatId,
          hostId: hostIds[index] ?? sessionHostId ?? UNKNOWN_HOST_PLACEHOLDER,
        })),
      ),
    [chatIds, hostIds, sessionHostId],
  );
  const chatEpicIds = useMemo(
    () => Object.fromEntries(chatIds.map((chatId) => [chatId, epicId])),
    [chatIds, epicId],
  );
  return (
    <ChatIndicatorHostScopes scopes={scopes} chatEpicIds={chatEpicIds}>
      <LiveAgentRows
        epicId={epicId}
        tabId={props.tabId}
        chatIds={chatIds}
        hostIds={hostIds}
      />
    </ChatIndicatorHostScopes>
  );
}

function LiveAgentRows(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly chatIds: ReadonlyArray<string>;
  readonly hostIds: ReadonlyArray<string | null>;
}): ReactNode {
  const { epicId, chatIds, hostIds } = props;
  const tree = useEpicTreeIndex();
  const tiers = useEpicAgentActivityTiers();
  const indicators = useContext(NotificationIndicatorsContext);
  const localRows = useAppLocalNotificationsStore((state) => state.byId);
  // Each agent's activity coverage, asked of its own host: an agent on a host
  // the plane does not reach lists as unknown instead of vanishing.
  const coverages = useAgentActivityStore(
    useShallow((state) =>
      hostIds.map((hostId) =>
        selectAgentActivityCoverage(state.byHost, hostId),
      ),
    ),
  );
  const rows = useMemo(() => {
    const kinds = new Map<string, LiveAgentKind>();
    for (const [index, chatId] of chatIds.entries()) {
      const kind = ownChatStatusKind(
        selectNotificationIndicatorState(
          { byId: localRows },
          { epicId, chatId },
          hostIds[index] ?? null,
          indicators,
        ),
        tiers.get(chatId),
        coverages[index] ?? "indeterminate",
      );
      if (kind !== null && kind !== "done" && kind !== "terminal-failure") {
        kinds.set(chatId, kind);
      }
    }
    return liveRowsOf(tree, kinds);
  }, [chatIds, coverages, epicId, hostIds, indicators, localRows, tiers, tree]);
  if (rows.length === 0) return null;
  return (
    <ul
      aria-label="Live agents"
      data-testid="strip-live-agents"
      className={LIVE_AGENTS_LIST_CLASS}
    >
      {rows.map((row) => (
        <li key={row.nodeId}>
          <LiveAgentRowButton epicId={epicId} tabId={props.tabId} row={row} />
        </li>
      ))}
    </ul>
  );
}

/** One live agent's row, fed from the session and opening its chat. */
function LiveAgentRowButton(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly row: LiveAgentRow;
}): ReactNode {
  const { epicId, tabId, row } = props;
  const title = useEpicStore((state: OpenEpicState) =>
    Object.hasOwn(state.tree.nodeById, row.nodeId)
      ? state.tree.nodeById[row.nodeId].title
      : "",
  );
  const type = useEpicStore((state: OpenEpicState) =>
    Object.hasOwn(state.tree.nodeById, row.nodeId)
      ? state.tree.nodeById[row.nodeId].type
      : null,
  );
  const ownerHostId = useEpicNodeHostId(row.nodeId);
  const ownerUserId = useEpicNodeOwnerUserId(row.nodeId);
  const sessionHostId = useEpicSessionHostId();
  const updatedAt = useEpicNodeUpdatedAt(row.nodeId);
  const { openTile } = useEpicTileNavigation();
  const openRef = useChatRowOpenRef({
    epicId,
    nodeId: row.nodeId,
    nodeName: title,
    openableType: type !== null && isOpenableEpicNodeKind(type) ? type : null,
    ownerHostId,
    ownerUserId,
    sessionHostId,
  });
  return (
    <LiveAgentRowView
      nodeId={row.nodeId}
      kind={row.kind}
      depth={row.depth}
      title={title}
      updatedAt={updatedAt}
      onClick={() => {
        openTile(tileIntent(openRef(), { tabId }, "single", "direct_ui"));
      }}
    />
  );
}

/** Every agent in the tree, parents before their children. */
function agentIdsOf(tree: TreeSlice): string[] {
  const ids: string[] = [];
  walkAgents(tree, (id) => {
    ids.push(id);
    return false;
  });
  return ids;
}

/**
 * The live agents in tree order, each indented under its nearest live
 * ancestor; a live child of an idle agent stands at the parent's depth.
 */
function liveRowsOf(
  tree: TreeSlice,
  kinds: ReadonlyMap<string, LiveAgentKind>,
): ReadonlyArray<LiveAgentRow> {
  const rows: LiveAgentRow[] = [];
  walkAgents(tree, (id, liveAncestors) => {
    const kind = kinds.get(id);
    if (kind === undefined) return false;
    rows.push({ nodeId: id, kind, depth: liveAncestors });
    return true;
  });
  return rows;
}

/**
 * Depth-first over the agents (chats and terminal agents), roots in the tree's
 * own order. `visit` returns whether the agent counts as a live ancestor for
 * its children. Cycle-guarded, like the tree's own walks.
 */
function walkAgents(
  tree: TreeSlice,
  visit: (id: string, liveAncestors: number) => boolean,
): void {
  const seen = new Set<string>();
  const descend = (id: string, liveAncestors: number): void => {
    if (seen.has(id) || !Object.hasOwn(tree.nodeById, id)) return;
    seen.add(id);
    if (!CHATS_TREE_FILTER(tree.nodeById[id].type)) return;
    const live = visit(id, liveAncestors);
    if (!Object.hasOwn(tree.childrenByParent, id)) return;
    for (const child of tree.childrenByParent[id]) {
      descend(child, live ? liveAncestors + 1 : liveAncestors);
    }
  };
  const roots = sidebarTreeRootIds({
    tree,
    treeFilter: CHATS_TREE_FILTER,
    comparator: null,
    clock: null,
  });
  for (const root of roots) descend(root, 0);
}
