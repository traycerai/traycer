import { useMemo, useSyncExternalStore } from "react";
import {
  CHATS_TREE_FILTER,
  collectArchiveHiddenIds,
  sidebarTreeRootIds,
} from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import type { EpicTreeIndex } from "@/lib/epic-selectors";
import { isDefaultSort, makeNodeComparator } from "@/lib/epic-sort";
import {
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { useChatSort } from "@/stores/epics/left-panel-store";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

/** One agent of a task, where the Chats panel's tree puts it. */
export type BotTaskAgentNode = {
  readonly id: string;
  /** 0 for a root; one more per parent above it. */
  readonly depth: number;
  readonly title: string;
  readonly updatedAt: number;
  /** The host that owns the agent; `null` for a record predating the field. */
  readonly ownerHostId: string | null;
};

/** A task's agents as this window's session for it holds them. */
export type BotTaskAgents = {
  /** Every agent, archived ones included, in the Chats panel's tree order. */
  readonly nodes: ReadonlyArray<BotTaskAgentNode>;
  /** What the panel's default view hides as archived, before its reveal. */
  readonly archiveHidden: ReadonlySet<string>;
  readonly tree: EpicTreeIndex;
  /** The host serving the session. */
  readonly sessionHostId: string | null;
};

const noopSubscribe = (): (() => void) => () => undefined;

/**
 * A task's agents, from the session this window holds for it, the only
 * thing that names them; `null` for a task with none (a cold task), as the
 * side strip reads its tasks. Roots follow the task's chosen sort and children
 * the tree's own order, as the Chats panel lists them.
 */
export function useBotTaskAgents(taskId: string): BotTaskAgents | null {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.peek(taskId),
    () => null,
  );
  const state = useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe(),
    () => handle?.store.getState() ?? null,
    () => null,
  );
  const sort = useChatSort(taskId);
  const tree = state?.tree ?? null;
  const chats = state?.chats ?? null;
  const tuiAgents = state?.tuiAgents ?? null;
  return useMemo(() => {
    if (handle === null || tree === null || chats === null) return null;
    if (tuiAgents === null) return null;
    const comparator = isDefaultSort(sort) ? null : makeNodeComparator(sort);
    const archivedIds = [
      ...chats.allIds.filter((id) => chats.byId[id].archivedAt !== null),
      ...tuiAgents.allIds.filter(
        (id) => tuiAgents.byId[id].archivedAt !== null,
      ),
    ];
    return {
      nodes: treeOrder(
        tree,
        (id) => ownerHostOf(chats, tuiAgents, id),
        sidebarTreeRootIds({
          tree,
          treeFilter: CHATS_TREE_FILTER,
          comparator,
          clock: null,
        }),
      ),
      archiveHidden: collectArchiveHiddenIds(archivedIds, tree),
      tree,
      sessionHostId: getEpicSessionHandleHostId(handle),
    };
  }, [chats, handle, sort, tree, tuiAgents]);
}

function ownerHostOf(
  chats: OpenEpicState["chats"],
  tuiAgents: OpenEpicState["tuiAgents"],
  id: string,
): string | null {
  if (Object.hasOwn(chats.byId, id)) return chats.byId[id].hostId;
  if (Object.hasOwn(tuiAgents.byId, id)) return tuiAgents.byId[id].hostId;
  return null;
}

function treeOrder(
  tree: OpenEpicState["tree"],
  hostOf: (id: string) => string | null,
  rootIds: ReadonlyArray<string>,
): ReadonlyArray<BotTaskAgentNode> {
  const nodes: BotTaskAgentNode[] = [];
  const visited = new Set<string>();
  const stack = [...rootIds].reverse().map((id) => ({ id, depth: 0 }));
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || visited.has(next.id)) continue;
    visited.add(next.id);
    if (!Object.hasOwn(tree.nodeById, next.id)) continue;
    const node = tree.nodeById[next.id];
    if (!CHATS_TREE_FILTER(node.type)) continue;
    nodes.push({
      id: node.id,
      depth: next.depth,
      title: node.title,
      updatedAt: node.updatedAt,
      ownerHostId: hostOf(node.id),
    });
    const children = Object.hasOwn(tree.childrenByParent, node.id)
      ? tree.childrenByParent[node.id]
      : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ id: children[index], depth: next.depth + 1 });
    }
  }
  return nodes;
}
