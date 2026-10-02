import { useShallow } from "zustand/react/shallow";
import {
  findPaneTabForRef,
  type TileIdentity,
} from "@/stores/epics/canvas/actions";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { resolveActivePaneTab } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import {
  selectHostActiveSurfaceRefs,
  selectHostFocusedRef,
} from "@/stores/tabs/selectors";
import { useTabsStore, type TabsStoreState } from "@/stores/tabs/store";

/** The tile a chat is showing in, for a chat that is on screen. */
export interface AgentOnScreen {
  readonly instanceId: string;
  /** The tile is in the focused pane of the focused task. */
  readonly focused: boolean;
}

type TaskPresence = "focused" | "visible" | "hidden";

/**
 * Whether a task's canvas is in front: the focused task, its split partner
 * (both are showing), or neither.
 */
function taskPresence(state: TabsStoreState, tabId: string): TaskPresence {
  if (selectHostFocusedRef(state)?.id === tabId) return "focused";
  return selectHostActiveSurfaceRefs(state).some((ref) => ref.id === tabId)
    ? "visible"
    : "hidden";
}

/**
 * The tile `node` shows in, when it is the visible tab of a pane of a task
 * that is in front. A chat in a background tab, in a task that is not showing,
 * or not open at all is not on screen. A canvas holds a chat in at most one
 * pane (global dedupe), so there is at most one such tile.
 */
function onScreenTileOf(
  canvas: EpicCanvasState | undefined,
  node: TileIdentity,
  presence: TaskPresence,
): AgentOnScreen | null {
  if (canvas === undefined || presence === "hidden") return null;
  const found = findPaneTabForRef(canvas, node);
  if (
    found === null ||
    resolveActivePaneTab(found.pane.activeTabId, found.pane.tabInstanceIds) !==
      found.instanceId
  ) {
    return null;
  }
  return {
    instanceId: found.instanceId,
    focused: presence === "focused" && canvas.activePaneId === found.pane.id,
  };
}

/** Where the chat `node` is showing on `tabId`'s task, or `null` off screen. */
export function useAgentOnScreen(
  tabId: string,
  node: TileIdentity,
): AgentOnScreen | null {
  const presence = useTabsStore((state) => taskPresence(state, tabId));
  return useEpicCanvasStore(
    useShallow((state) =>
      onScreenTileOf(state.canvasByTabId[tabId], node, presence),
    ),
  );
}
