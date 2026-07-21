import { EMPTY_CANVAS } from "@/stores/epics/canvas/canvas-state";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  WORKSPACE_FILE_TAB_KIND,
  type EpicCanvasState,
} from "@/stores/epics/canvas/types";
import { isDiffTileRef } from "@/stores/epics/canvas/types";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import type {
  HostNotificationsPresenceEntity,
  HostNotificationsSubscribeClientFrame,
} from "@traycer/protocol/host/notifications/contracts";

export interface HostNotificationPresenceInput {
  readonly windowId: string;
  readonly now: () => number;
}

export type HostNotificationPresenceFrame = Extract<
  HostNotificationsSubscribeClientFrame,
  { readonly kind: "presence" }
>;

export function readHostNotificationPresenceFrame(
  input: HostNotificationPresenceInput,
): HostNotificationPresenceFrame {
  return {
    kind: "presence",
    hasBinaryPayload: false,
    windowId: input.windowId,
    focused: isDocumentFocused(),
    entity: readActiveHostNotificationPresenceEntity(),
    at: input.now(),
  };
}

export function subscribeHostNotificationPresence(
  sendPresence: () => void,
): () => void {
  const unsubscribeCanvas = useEpicCanvasStore.subscribe((state, previous) => {
    if (
      state.activeTabId !== previous.activeTabId ||
      state.canvasByTabId !== previous.canvasByTabId ||
      state.tabsById !== previous.tabsById
    ) {
      sendPresence();
    }
  });
  if (typeof window === "undefined" || typeof document === "undefined") {
    return unsubscribeCanvas;
  }
  window.addEventListener("focus", sendPresence);
  window.addEventListener("blur", sendPresence);
  document.addEventListener("visibilitychange", sendPresence);
  return () => {
    unsubscribeCanvas();
    window.removeEventListener("focus", sendPresence);
    window.removeEventListener("blur", sendPresence);
    document.removeEventListener("visibilitychange", sendPresence);
  };
}

/**
 * The entity this window is actively looking at, or `null` when the window is
 * blurred or no epic/chat tile is active. Read live (canvas store + document
 * focus) so display-time gates see the current state rather than the last
 * presence frame that happened to be sent.
 */
export function readFocusedHostNotificationPresenceEntity(): HostNotificationsPresenceEntity | null {
  if (!isDocumentFocused()) return null;
  return readActiveHostNotificationPresenceEntity();
}

function isDocumentFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

function readActiveHostNotificationPresenceEntity(): HostNotificationsPresenceEntity | null {
  const state = useEpicCanvasStore.getState();
  const activeTab =
    state.activeTabId === null ? null : state.tabsById[state.activeTabId];
  if (activeTab === null || activeTab === undefined) return null;
  const canvas = state.canvasByTabId[activeTab.tabId] ?? EMPTY_CANVAS;
  const active = activeCanvasTile(canvas);
  if (
    active?.type === "chat" ||
    active?.type === "terminal" ||
    active?.type === "terminal-agent"
  ) {
    return { epicId: activeTab.epicId, chatId: active.id };
  }
  return { epicId: activeTab.epicId };
}

function activeCanvasTile(canvas: EpicCanvasState) {
  if (canvas.activePaneId === null) return null;
  const pane = findPaneById(canvas.root, canvas.activePaneId);
  if (pane === null || pane.activeTabId === null) return null;
  const active = canvas.tilesByInstanceId[pane.activeTabId];
  if (active === undefined) return null;
  if (active.type === WORKSPACE_FILE_TAB_KIND) return null;
  if (isDiffTileRef(active)) return null;
  return active;
}
