import { useEffect, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  useActiveEpicArtifactId,
  useEpicCanvas,
  useEpicCanvasStore,
  useEpicTab,
} from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  useEpicArtifactRecords,
  useEpicLastFocusedArtifactId,
  useEpicSnapshotLoaded,
  useEpicTitle,
} from "@/lib/epic-selectors";
import { resolveAutoOpenTarget } from "@/lib/epic-auto-open";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { isTileRefRecordBacked } from "@/stores/epics/canvas/tile-schema";

export interface EpicRouteFocusIntent {
  readonly epicId: string;
  readonly tabId: string;
  readonly focusedAt: number | undefined;
  readonly focusArtifactId: string | undefined;
  readonly focusThreadId: string | undefined;
}

/**
 * Keeps the route's focus intent, the live per-epic session store, and the
 * GUI-owned canvas/tab store synchronized after mount. These writes target
 * external stores backed by a live stream/Y.Doc, so they intentionally stay
 * in effects rather than being derived during render.
 */
export function useEpicRouteSynchronization(
  intent: EpicRouteFocusIntent,
): void {
  const { epicId, tabId, focusedAt, focusArtifactId, focusThreadId } = intent;
  const handle = useOpenEpicHandle();
  const snapshotLoaded = useEpicSnapshotLoaded();
  const liveTitle = useEpicTitle();
  const persistedFocus = useEpicLastFocusedArtifactId();
  const records = useEpicArtifactRecords();
  const currentTab = useEpicTab(tabId);
  const renameTab = useEpicCanvasStore((s) => s.renameTab);
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);
  const closeCanvasTab = useEpicCanvasStore((s) => s.closeCanvasTab);
  const pendingCreateArtifactIds = useEpicCanvasStore(
    (s) => s.pendingCreateArtifactIds,
  );
  const activeArtifactId = useActiveEpicArtifactId(tabId);
  const canvas = useEpicCanvas(tabId);
  const hasRestoredCanvas = canvas.root !== null;

  const currentTabName = currentTab?.name ?? null;
  useEffect(() => {
    const nextTitle = liveTitle.trim();
    if (nextTitle.length === 0) return;
    if (currentTabName === nextTitle) return;
    renameTab(tabId, nextTitle);
  }, [currentTabName, tabId, liveTitle, renameTab]);

  useEffect(() => {
    if (!snapshotLoaded) return;
    const target = focusArtifactId ?? persistedFocus;
    if (target === null) return;
    handle.store.getState().setLastFocusedArtifactId(target);
  }, [snapshotLoaded, focusArtifactId, focusedAt, persistedFocus, handle]);

  useEffect(() => {
    if (!snapshotLoaded) return;
    if (focusThreadId === undefined) return;
    handle.store.getState().setLastFocusedThreadId(focusThreadId);
  }, [snapshotLoaded, focusThreadId, focusedAt, handle]);

  // When the route handed us a `focusThreadId`, swap the left panel to
  // Comments and activate the matching thread *after* the auto-open
  // effect has set the artifact active. Gating on `activeArtifactId ===
  // focusArtifactId` avoids racing active-artifact fallback behavior, which
  // reverts the panel when the active artifact stops supporting comments.
  // Each (focusedAt, threadId) combination fires once via the de-dupe ref so
  // manual user interactions (closing the comments panel) aren't fought by
  // stale route state.
  const lastDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshotLoaded) return;
    if (focusThreadId === undefined) return;
    if (focusArtifactId === undefined) return;
    if (activeArtifactId !== focusArtifactId) return;
    const key = `${epicId}|${focusedAt ?? ""}|${focusThreadId}`;
    if (lastDeepLinkRef.current === key) return;
    lastDeepLinkRef.current = key;
    useLeftPanelStore.getState().revealCommentsPanel(tabId);
    useLeftPanelStore.getState().setActivePanelIdAndExpand(tabId, "comments");
    useCommentThreadsStore.getState().setActiveThread(epicId, focusThreadId);
  }, [
    snapshotLoaded,
    focusThreadId,
    focusArtifactId,
    focusedAt,
    activeArtifactId,
    epicId,
    tabId,
  ]);

  const lastAutoOpenKey = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshotLoaded) return;
    if (records.length === 0 && focusArtifactId === undefined) {
      return;
    }

    const key = `${epicId}|${focusArtifactId ?? ""}|${focusedAt ?? ""}`;
    const hasExplicitFocus = focusArtifactId !== undefined;
    if (!hasExplicitFocus && hasRestoredCanvas) {
      lastAutoOpenKey.current = key;
      return;
    }
    if (!hasExplicitFocus && lastAutoOpenKey.current !== null) {
      return;
    }
    if (hasExplicitFocus && lastAutoOpenKey.current === key) {
      return;
    }

    lastAutoOpenKey.current = key;
    const target = resolveAutoOpenTarget(
      records,
      focusArtifactId ?? null,
      persistedFocus,
    );
    if (target === null) return;
    if (activeArtifactId === target.id) return;
    openTileInTab(tabId, {
      id: target.id,
      instanceId: uuidv4(),
      type: target.type,
      name: target.name,
      hostId: target.hostId,
    });
  }, [
    snapshotLoaded,
    records,
    focusArtifactId,
    focusedAt,
    persistedFocus,
    hasRestoredCanvas,
    openTileInTab,
    activeArtifactId,
    epicId,
    tabId,
  ]);

  const lastSyncedFocus = useRef<string | null>(persistedFocus);
  useEffect(() => {
    if (!snapshotLoaded) return;
    // `activeArtifactId` is `null` for non-artifact tabs (terminal,
    // workspace-file). Don't sync that `null` into `lastFocusedArtifactId`
    // - it would wipe the epic's last artifact focus, breaking the
    // fallback-restore path when the user returns to an artifact tab.
    if (activeArtifactId === null) return;
    if (activeArtifactId === lastSyncedFocus.current) return;
    lastSyncedFocus.current = activeArtifactId;
    handle.store.getState().setLastFocusedArtifactId(activeArtifactId);
  }, [snapshotLoaded, activeArtifactId, handle]);

  // Close any open tab whose underlying record was removed (sidebar delete,
  // server-side cascade, or remote delete by another collaborator). The
  // sidebar's optimistic Y.Doc delete unmounts the row before the mutation's
  // per-call `onSuccess` can fire (TanStack Query v5 drops observer-attached
  // callbacks on unmount), so the close has to be driven by record→canvas
  // sync rather than by mutation callbacks. Plain `terminal` tabs and
  // `git-diff` tiles aren't backed by Y.Doc records; pending-create ids cover
  // the optimistic-open window where a tab exists before its record has
  // projected. Those local/non-artifact tabs are excluded.
  useEffect(() => {
    if (!snapshotLoaded) return;
    if (canvas.root === null) return;
    const liveIds = new Set(records.map((r) => r.id));
    for (const pane of collectPanes(canvas.root)) {
      for (const instanceId of pane.tabInstanceIds) {
        const tab = canvas.tilesByInstanceId[instanceId];
        if (tab === undefined) continue;
        // Renderer-only tiles (terminal, workspace-file, git-diff) have no
        // Y.Doc-backed record, so a `liveIds` miss is not a deletion.
        if (!isTileRefRecordBacked(tab)) continue;
        if (liveIds.has(tab.id)) continue;
        if (pendingCreateArtifactIds.has(tab.id)) continue;
        closeCanvasTab(tabId, pane.id, tab.instanceId);
      }
    }
  }, [
    snapshotLoaded,
    canvas,
    records,
    pendingCreateArtifactIds,
    tabId,
    closeCanvasTab,
  ]);
}
