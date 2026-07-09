import { useEffect, useMemo, useRef } from "react";
import {
  useNavigate,
  useRouter,
  type UseNavigateResult,
} from "@tanstack/react-router";
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
import { getHistoryController } from "@/lib/persistent-history";
import {
  areNestedFocusTargetsEqual,
  buildNestedFocusSearchPatch,
  getCurrentNestedFocusTarget,
  parseNestedFocusTargetFromSearch,
  resolveNestedFocusTarget,
  type NestedFocusTarget,
} from "@/lib/epic-nested-focus-route";

type NavigateFn = UseNavigateResult<string>;

export interface EpicRouteFocusIntent {
  readonly epicId: string;
  readonly tabId: string;
  readonly focusedAt: number | undefined;
  readonly focusArtifactId: string | undefined;
  readonly focusThreadId: string | undefined;
  readonly focusPaneId: string | undefined;
  readonly focusTileInstanceId: string | undefined;
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
  const {
    epicId,
    tabId,
    focusedAt,
    focusArtifactId,
    focusThreadId,
    focusPaneId,
    focusTileInstanceId,
  } = intent;
  const router = useRouter();
  const navigate = useNavigate();
  const handle = useOpenEpicHandle();
  const snapshotLoaded = useEpicSnapshotLoaded();
  const liveTitle = useEpicTitle();
  const persistedFocus = useEpicLastFocusedArtifactId();
  const records = useEpicArtifactRecords();
  const currentTab = useEpicTab(tabId);
  const renameTab = useEpicCanvasStore((s) => s.renameTab);
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);
  const applyNestedRouteFocus = useEpicCanvasStore(
    (s) => s.applyNestedRouteFocus,
  );
  const closeCanvasTab = useEpicCanvasStore((s) => s.closeCanvasTab);
  const pendingCreateArtifactIds = useEpicCanvasStore(
    (s) => s.pendingCreateArtifactIds,
  );
  const activeArtifactId = useActiveEpicArtifactId(tabId);
  const canvas = useEpicCanvas(tabId);
  const hasRestoredCanvas = canvas.root !== null;
  const nestedRouteTarget = useMemo(
    () =>
      parseNestedFocusTargetFromSearch({
        focusPaneId,
        focusTileInstanceId,
      }),
    [focusPaneId, focusTileInstanceId],
  );
  const nestedFocusEnabled = getHistoryController(router.history) !== null;
  const currentNestedTarget = useMemo(
    () => (hasRestoredCanvas ? getCurrentNestedFocusTarget(canvas) : null),
    [hasRestoredCanvas, canvas],
  );
  const resolvedNestedRouteTarget = useMemo(
    () =>
      nestedFocusEnabled && hasRestoredCanvas && nestedRouteTarget !== null
        ? resolveNestedFocusTarget(canvas, nestedRouteTarget)
        : null,
    [nestedFocusEnabled, hasRestoredCanvas, nestedRouteTarget, canvas],
  );
  const nestedRouteTargetApplied = isNestedRouteTargetApplied(
    resolvedNestedRouteTarget,
    currentNestedTarget,
  );
  const legacyFocusHonorableAfterArtifactActivation =
    !nestedFocusEnabled ||
    nestedRouteTarget === null ||
    (focusArtifactId !== undefined &&
      nestedRouteTargetApplied &&
      activeArtifactId === focusArtifactId);

  const currentTabName = currentTab?.name ?? null;
  useEffect(() => {
    const nextTitle = liveTitle.trim();
    if (nextTitle.length === 0) return;
    if (currentTabName === nextTitle) return;
    renameTab(tabId, nextTitle);
  }, [currentTabName, tabId, liveTitle, renameTab]);

  useEffect(() => {
    if (!snapshotLoaded) {
      return;
    }
    if (!nestedFocusEnabled) {
      return;
    }
    if (!hasRestoredCanvas) {
      return;
    }

    if (nestedRouteTarget === null) {
      if (
        shouldDeferToLegacyArtifactFocus({
          focusArtifactId,
          focusThreadId,
          activeArtifactId,
        })
      ) {
        return;
      }
      const target = getCurrentNestedFocusTarget(canvas);
      if (target === null) {
        return;
      }
      replaceNestedFocusRoute(navigate, { epicId, tabId }, target);
      return;
    }

    const resolved = resolveNestedFocusTarget(canvas, nestedRouteTarget);
    if (resolved === null) {
      const fallback = getCurrentNestedFocusTarget(canvas);
      replaceNestedFocusRoute(navigate, { epicId, tabId }, fallback);
      return;
    }

    if (!isNestedRouteTargetApplied(resolved, currentNestedTarget)) {
      applyNestedRouteFocus(tabId, resolved);
      return;
    }
  }, [
    snapshotLoaded,
    nestedFocusEnabled,
    hasRestoredCanvas,
    nestedRouteTarget,
    focusArtifactId,
    focusThreadId,
    activeArtifactId,
    canvas,
    navigate,
    epicId,
    tabId,
    currentNestedTarget,
    applyNestedRouteFocus,
  ]);

  // The nested-route target we last moved DOM focus to. This effect re-runs on
  // every canvas mutation - a title rename gives `useEpicCanvas` a new identity
  // while the applied target stays byte-for-byte the same - and the restore is
  // only meant to service genuine pane/tab navigation. Gating on an actual
  // target change keeps a bare rename from re-focusing the tile, which would
  // eject a user typing in the body or paint a stray selection ring after a
  // tab-strip rename.
  const lastRestoredNestedTargetRef = useRef<NestedFocusTarget | null>(null);
  useEffect(() => {
    if (!snapshotLoaded) return;
    if (!nestedFocusEnabled) return;
    if (!hasRestoredCanvas) return;
    if (nestedRouteTarget === null) return;
    if (resolvedNestedRouteTarget === null) {
      return;
    }
    if (!nestedRouteTargetApplied) {
      return;
    }
    if (
      areNestedFocusTargetsEqual(
        lastRestoredNestedTargetRef.current,
        resolvedNestedRouteTarget,
      )
    ) {
      return;
    }
    const targetToFocus = resolvedNestedRouteTarget;
    const frame = window.requestAnimationFrame(() => {
      lastRestoredNestedTargetRef.current = targetToFocus;
      focusNestedRouteTarget(targetToFocus);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    snapshotLoaded,
    nestedFocusEnabled,
    hasRestoredCanvas,
    nestedRouteTarget,
    resolvedNestedRouteTarget,
    nestedRouteTargetApplied,
    currentNestedTarget,
    epicId,
    tabId,
  ]);

  useEffect(() => {
    if (!snapshotLoaded) return;
    if (
      focusArtifactId !== undefined &&
      !legacyFocusHonorableAfterArtifactActivation
    ) {
      return;
    }
    const target = focusArtifactId ?? persistedFocus;
    if (target === null) return;
    handle.store.getState().setLastFocusedArtifactId(target);
  }, [
    snapshotLoaded,
    focusArtifactId,
    focusedAt,
    persistedFocus,
    legacyFocusHonorableAfterArtifactActivation,
    handle,
    epicId,
    tabId,
    activeArtifactId,
    nestedRouteTarget,
  ]);

  useEffect(() => {
    if (!snapshotLoaded) return;
    if (focusThreadId === undefined) return;
    if (!legacyFocusHonorableAfterArtifactActivation) {
      return;
    }
    handle.store.getState().setLastFocusedThreadId(focusThreadId);
  }, [
    snapshotLoaded,
    focusThreadId,
    focusedAt,
    legacyFocusHonorableAfterArtifactActivation,
    handle,
    epicId,
    tabId,
    focusArtifactId,
    activeArtifactId,
    nestedRouteTarget,
  ]);

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
    if (!legacyFocusHonorableAfterArtifactActivation) return;
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
    legacyFocusHonorableAfterArtifactActivation,
    epicId,
    tabId,
  ]);

  const lastAutoOpenKey = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshotLoaded) return;
    if (
      shouldSuppressLegacyAutoOpen({
        nestedFocusEnabled,
        nestedRouteTarget,
        focusArtifactId,
        recordCount: records.length,
      })
    ) {
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
    if (target === null) {
      return;
    }
    if (activeArtifactId === target.id) {
      return;
    }
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
    nestedFocusEnabled,
    nestedRouteTarget,
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
    epicId,
    tabId,
    closeCanvasTab,
  ]);
}

function replaceNestedFocusRoute(
  navigate: NavigateFn,
  tab: { readonly epicId: string; readonly tabId: string },
  target: NestedFocusTarget | null,
): void {
  void navigate({
    to: "/epics/$epicId/$tabId",
    params: { epicId: tab.epicId, tabId: tab.tabId },
    search: (prev) => ({
      ...prev,
      focusedAt: prev.focusedAt,
      focusArtifactId: prev.focusArtifactId,
      focusThreadId: prev.focusThreadId,
      migrationSource: prev.migrationSource,
      ...buildNestedFocusSearchPatch(target),
    }),
    replace: true,
  });
}

/**
 * Whether the legacy auto-open effect should no-op: a committed nested route
 * target already governs focus, or there is nothing to auto-open yet.
 */
function shouldSuppressLegacyAutoOpen(args: {
  readonly nestedFocusEnabled: boolean;
  readonly nestedRouteTarget: NestedFocusTarget | null;
  readonly focusArtifactId: string | undefined;
  readonly recordCount: number;
}): boolean {
  const {
    nestedFocusEnabled,
    nestedRouteTarget,
    focusArtifactId,
    recordCount,
  } = args;
  if (nestedFocusEnabled && nestedRouteTarget !== null) {
    return true;
  }
  if (recordCount === 0 && focusArtifactId === undefined) {
    return true;
  }
  return false;
}

/**
 * Whether the route-sync effect should defer canonicalizing the current
 * canvas focus into the route because a legacy (`focusArtifactId` /
 * `focusThreadId`) deep link is still pending activation.
 */
function shouldDeferToLegacyArtifactFocus(args: {
  readonly focusArtifactId: string | undefined;
  readonly focusThreadId: string | undefined;
  readonly activeArtifactId: string | null;
}): boolean {
  const { focusArtifactId, focusThreadId, activeArtifactId } = args;
  if (focusArtifactId === undefined && focusThreadId === undefined) {
    return false;
  }
  if (focusArtifactId === undefined) {
    return true;
  }
  if (activeArtifactId !== focusArtifactId) {
    return true;
  }
  return false;
}

function isNestedRouteTargetApplied(
  routeTarget: NestedFocusTarget | null,
  currentTarget: NestedFocusTarget | null,
): boolean {
  if (routeTarget === null) return false;
  if (currentTarget === null) return false;
  if (routeTarget.tileInstanceId === undefined) {
    return currentTarget.paneId === routeTarget.paneId;
  }
  return areNestedFocusTargetsEqual(currentTarget, routeTarget);
}

function focusNestedRouteTarget(target: NestedFocusTarget): void {
  const element =
    target.tileInstanceId === undefined
      ? findActivePaneElement(target.paneId)
      : findSelectedTileElement(target.tileInstanceId);
  if (element === null) {
    return;
  }
  // The pane / tab container is an ancestor of the tile's editing surface, and
  // this effect re-runs on every canvas mutation (a title rename, for one). If
  // focus already lives inside the target, moving it up to the container would
  // blur that deeper element - ejecting a user mid-type from the artifact body.
  // Only pull focus up when it is currently elsewhere, i.e. a genuine
  // pane/tab switch that this restore is meant to service.
  if (element.contains(document.activeElement)) {
    return;
  }
  element.focus({ preventScroll: true });
}

function findActivePaneElement(paneId: string): HTMLElement | null {
  const elements = document.querySelectorAll<HTMLElement>(
    "[data-group-id][data-active='true']",
  );
  return (
    [...elements].find(
      (element) => element.getAttribute("data-group-id") === paneId,
    ) ?? null
  );
}

function findSelectedTileElement(tileInstanceId: string): HTMLElement | null {
  const elements = document.querySelectorAll<HTMLElement>(
    "[data-tab-instance-id][data-selected='true']",
  );
  return (
    [...elements].find(
      (element) =>
        element.getAttribute("data-tab-instance-id") === tileInstanceId,
    ) ?? null
  );
}
