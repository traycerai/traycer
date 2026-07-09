import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";

export interface NestedFocusTarget {
  readonly paneId: string;
  readonly tileInstanceId: string | undefined;
}

export interface NestedFocusSearchPatch {
  readonly focusPaneId: string | undefined;
  readonly focusTileInstanceId: string | undefined;
}

function normalizeNestedFocusSearchValue(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseNestedFocusTargetFromSearch(
  search: Readonly<Record<string, unknown>>,
): NestedFocusTarget | null {
  const paneId = normalizeNestedFocusSearchValue(search.focusPaneId);
  if (paneId === undefined) return null;
  return {
    paneId,
    tileInstanceId: normalizeNestedFocusSearchValue(search.focusTileInstanceId),
  };
}

export function getCurrentNestedFocusTarget(
  canvas: EpicCanvasState,
): NestedFocusTarget | null {
  if (canvas.activePaneId === null) return null;
  const pane = findPaneById(canvas.root, canvas.activePaneId);
  if (pane === null) return null;

  const explicitTabId =
    pane.activeTabId !== null &&
    pane.tabInstanceIds.includes(pane.activeTabId) &&
    canvas.tilesByInstanceId[pane.activeTabId] !== undefined
      ? pane.activeTabId
      : undefined;
  const firstTabId = pane.tabInstanceIds.find(
    (instanceId) => canvas.tilesByInstanceId[instanceId] !== undefined,
  );

  return {
    paneId: pane.id,
    tileInstanceId: explicitTabId ?? firstTabId,
  };
}

export function resolveNestedFocusTarget(
  canvas: EpicCanvasState,
  target: NestedFocusTarget,
): NestedFocusTarget | null {
  const pane = findPaneById(canvas.root, target.paneId);
  if (pane === null) return null;
  if (target.tileInstanceId === undefined) return target;
  if (!pane.tabInstanceIds.includes(target.tileInstanceId)) return null;
  if (canvas.tilesByInstanceId[target.tileInstanceId] === undefined) {
    return null;
  }
  return target;
}

export function isNestedFocusTargetValid(
  canvas: EpicCanvasState,
  target: NestedFocusTarget,
): boolean {
  return resolveNestedFocusTarget(canvas, target) !== null;
}

export function areNestedFocusTargetsEqual(
  left: NestedFocusTarget | null,
  right: NestedFocusTarget | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.paneId === right.paneId && left.tileInstanceId === right.tileInstanceId
  );
}

export function buildNestedFocusSearchPatch(
  target: NestedFocusTarget | null,
): NestedFocusSearchPatch {
  return {
    focusPaneId: target?.paneId,
    focusTileInstanceId: target?.tileInstanceId,
  };
}

export function parseNestedFocusTargetFromHref(
  href: string,
): NestedFocusTarget | null {
  const queryStart = href.indexOf("?");
  if (queryStart === -1) return null;
  const hashStart = href.indexOf("#", queryStart);
  const query =
    hashStart === -1
      ? href.slice(queryStart + 1)
      : href.slice(queryStart + 1, hashStart);
  const params = new URLSearchParams(query);
  return parseNestedFocusTargetFromSearch({
    focusPaneId: params.get("focusPaneId") ?? undefined,
    focusTileInstanceId: params.get("focusTileInstanceId") ?? undefined,
  });
}
