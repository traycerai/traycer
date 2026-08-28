/**
 * Open a freshly created sidebar node as a canvas tile once its projection
 * lands in the open-epic store. Shared by the sidebar root-create flow
 * (`epic-sidebar.tsx`) and the artifact-tree child-create flow
 * (`epic-sidebar-artifact-tree.tsx`) so the wait/subscribe/timeout dance and
 * the `onBeforeOpen` handoff (e.g. one-shot editor focus) stay in lockstep.
 */
import { v4 as uuidv4 } from "uuid";
import { displayTitle } from "@/lib/display-title";
import {
  isOpenableEpicNodeKind,
  makeOpenableNodeRef,
  type EpicNodeRef,
  type OpenableEpicNodeKind,
} from "@/stores/epics/canvas/types";
import type {
  OpenEpicState,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

const PROJECTED_NODE_OPEN_WAIT_MS = 30_000;

export interface ProjectedSidebarNodeOpenArgs {
  readonly epicHandle: OpenEpicStoreHandle;
  readonly tabId: string;
  readonly nodeId: string;
  readonly fallbackHostId: string;
  readonly openTileInTab: (tabId: string, node: EpicNodeRef) => void;
  /** Runs with the resolved node ref right before the tile opens. */
  readonly onBeforeOpen: ((node: EpicNodeRef) => void) | null;
  readonly onOpened: () => void;
  readonly onUnavailable: () => void;
  /** Notified when the wait settles so callers can drop their cancel handle. */
  readonly onCleanup: ((cleanup: () => void) => void) | null;
}

/**
 * Returns a cancel function. If the node is already projected, it opens
 * synchronously and the returned cancel is a no-op; otherwise the store is
 * watched until the node appears or the wait times out.
 *
 * Caller-cancel vs timeout are distinct give-ups: the returned cancel is
 * SILENT (tears the wait down, notifies `onCleanup`, but never fires
 * `onUnavailable`) because "I no longer care / a newer action superseded this"
 * is not "the node is unavailable". Only the 30s timeout — the genuine
 * give-up that warrants a fallback — fires `onUnavailable`.
 */
export function openProjectedSidebarNodeInTabWhenAvailable(
  args: ProjectedSidebarNodeOpenArgs,
): () => void {
  let cancelled = false;
  let opened = false;
  let timeoutId: number | null = null;
  let unsubscribe: (() => void) | null = null;
  const teardown = (notifyUnavailable: boolean) => {
    if (cancelled) return;
    cancelled = true;
    unsubscribe?.();
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (notifyUnavailable && !opened) args.onUnavailable();
    if (args.onCleanup !== null) {
      args.onCleanup(cancel);
    }
  };
  // Returned to the caller: a silent cancel (no `onUnavailable`).
  const cancel = () => teardown(false);
  const openIfProjected = () => {
    const node = resolveProjectedSidebarNode(
      args.epicHandle.store.getState(),
      args.nodeId,
      args.fallbackHostId,
    );
    if (node === null) return false;
    const nodeRef = makeOpenableNodeRef({ ...node, instanceId: uuidv4() });
    if (args.onBeforeOpen !== null) {
      args.onBeforeOpen(nodeRef);
    }
    args.openTileInTab(args.tabId, nodeRef);
    opened = true;
    args.onOpened();
    return true;
  };
  if (openIfProjected()) {
    cancelled = true;
    return () => undefined;
  }

  unsubscribe = args.epicHandle.store.subscribe(() => {
    if (cancelled) return;
    if (!openIfProjected()) return;
    // Opened: tear down without firing `onUnavailable` (the node was found).
    teardown(false);
  });
  // The genuine give-up: fire `onUnavailable` so the caller can fall back.
  timeoutId = window.setTimeout(
    () => teardown(true),
    PROJECTED_NODE_OPEN_WAIT_MS,
  );
  return cancel;
}

function resolveProjectedSidebarNode(
  state: OpenEpicState,
  nodeId: string,
  fallbackHostId: string,
): {
  readonly id: string;
  readonly type: OpenableEpicNodeKind;
  readonly name: string;
  readonly hostId: string;
} | null {
  if (Object.hasOwn(state.chats.byId, nodeId)) {
    const chat = state.chats.byId[nodeId];
    return {
      id: chat.id,
      type: "chat",
      // Durable Agent node: an untitled Chat-interface Agent renders as
      // "Untitled agent". `type` remains the structural interface discriminator.
      name: displayTitle(chat.title, "agent"),
      hostId: chat.hostId ?? fallbackHostId,
    };
  }
  if (Object.hasOwn(state.tuiAgents.byId, nodeId)) {
    const agent = state.tuiAgents.byId[nodeId];
    return {
      id: agent.id,
      type: "terminal-agent",
      // Durable Agent node: an untitled Terminal-interface Agent renders as
      // "Untitled agent"; `type` stays the interface discriminator.
      name: displayTitle(agent.title, "agent"),
      hostId: agent.hostId,
    };
  }
  if (!Object.hasOwn(state.artifacts.byId, nodeId)) return null;
  const artifact = state.artifacts.byId[nodeId];
  if (!isOpenableEpicNodeKind(artifact.kind)) return null;
  return {
    id: artifact.id,
    type: artifact.kind,
    name: displayTitle(artifact.title, artifact.kind),
    hostId: fallbackHostId,
  };
}
