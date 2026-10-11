import { createContext, useEffect, useState } from "react";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import {
  hasPreviewDemand,
  useSurfaceDemandStore,
} from "@/stores/tabs/surface-demand";

const RETAINED_PREWARM_INTERVAL_MS = 150;
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  collectPanes,
  resolveActivePaneTab,
} from "@/stores/epics/canvas/tile-tree";

export const ChatPrewarmContext = createContext(false);

export function useChatPrewarmEligible(
  viewTabId: string,
  instanceId: string,
  handle: ChatSessionStoreHandle,
): boolean {
  const paneVisible = usePaneVisible();
  const previewing = useSurfaceDemandStore(
    (state) =>
      state.topLevelPreviewKeys.length > 0 ||
      Object.keys(state.panePreviewTargets).length > 0,
  );
  const [preparedFor, setPreparedFor] =
    useState<WeakRef<ChatSessionStoreHandle> | null>(null);
  const eligible = useEpicCanvasStore((state) => {
    if (!paneVisible || previewing) return false;
    const canvas = state.canvasByTabId[viewTabId];
    if (canvas?.root === null || canvas === undefined) return false;
    const pane = collectPanes(canvas.root).find((candidate) =>
      candidate.tabInstanceIds.includes(instanceId),
    );
    if (pane === undefined) return false;
    const active = resolveActivePaneTab(pane.activeTabId, pane.tabInstanceIds);
    const live = new Set(pane.tabInstanceIds);
    // Settled MRU history, never the cycling preview, chooses the one neighbour.
    return (
      pane.activationHistory.find(
        (id) =>
          id !== active &&
          live.has(id) &&
          canvas.tilesByInstanceId[id]?.type === "chat",
      ) === instanceId
    );
  });
  // A warm session can outlive its body. Each newly mounted neighbour prepares
  // its own rows through the same queue, including when no acquisition is due.
  useEffect(() => {
    if (!eligible || preparedFor?.deref() === handle) return;
    return prewarmRetainedChat(true, () => {
      setPreparedFor(new WeakRef(handle));
    });
  }, [eligible, handle, preparedFor]);
  return eligible && preparedFor?.deref() === handle;
}

// Only mounted retained bodies enqueue here. The pane's existing retention cap
// supplies the neighbour; prefer it over bodies in hidden top-level tabs.
const retainedPrewarms = new Set<{
  readonly paneVisible: boolean;
  readonly acquire: () => void;
}>();
let retainedPrewarmTimer: number | null = null;

export function cancelRetainedChatPrewarms(): void {
  retainedPrewarms.clear();
  if (retainedPrewarmTimer !== null) clearTimeout(retainedPrewarmTimer);
  retainedPrewarmTimer = null;
}

function scheduleRetainedPrewarm(): void {
  if (
    retainedPrewarmTimer !== null ||
    retainedPrewarms.size === 0 ||
    hasPreviewDemand()
  ) {
    return;
  }
  retainedPrewarmTimer = window.setTimeout(() => {
    retainedPrewarmTimer = null;
    const pending = [...retainedPrewarms];
    const next = pending.find((entry) => entry.paneVisible) ?? pending.at(0);
    if (next === undefined) return;
    retainedPrewarms.delete(next);
    try {
      next.acquire();
    } finally {
      scheduleRetainedPrewarm();
    }
  }, RETAINED_PREWARM_INTERVAL_MS);
}

export function prewarmRetainedChat(
  paneVisible: boolean,
  acquire: () => (() => void) | void,
): () => void {
  let release: (() => void) | void;
  const pending = {
    paneVisible,
    acquire: () => {
      release = acquire();
    },
  };
  retainedPrewarms.add(pending);
  scheduleRetainedPrewarm();
  return () => {
    retainedPrewarms.delete(pending);
    if (retainedPrewarms.size === 0 && retainedPrewarmTimer !== null) {
      clearTimeout(retainedPrewarmTimer);
      retainedPrewarmTimer = null;
    }
    release?.();
  };
}

useSurfaceDemandStore.subscribe(() => {
  if (retainedPrewarmTimer !== null) clearTimeout(retainedPrewarmTimer);
  retainedPrewarmTimer = null;
  scheduleRetainedPrewarm();
});
