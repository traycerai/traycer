import { isRecord } from "@/components/epic-canvas/dnd/dnd";
import type { HeaderTabDragData } from "@/components/layout/tabs/header-tab-dnd";
import {
  findStripItemForRef,
  tabRefKey,
  type PersistedTabStripLayout,
  type SplitSideName,
} from "@/stores/tabs/layout";
import { tabSurfaceDescriptor } from "@/stores/tabs/registry";
import { canMutateTabSplits } from "@/stores/tabs/tab-split-compatibility";
import { getTabCommandLedger } from "@/stores/tabs/tab-command-coordinator";
import { isTabStructurallyLocked } from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

/** These targets are intentionally outside the Epic-canvas DnD vocabulary. */
export const TOP_LEVEL_EDGE_SPLIT_TARGET = "top-level-edge-split";
export const TOP_LEVEL_FILLABLE_TARGET = "top-level-fillable-slot";

export interface TopLevelEdgeSplitTarget {
  readonly kind: typeof TOP_LEVEL_EDGE_SPLIT_TARGET;
  readonly targetRef: TabRef;
  readonly side: SplitSideName;
}

export interface TopLevelFillableTarget {
  readonly kind: typeof TOP_LEVEL_FILLABLE_TARGET;
  readonly splitId: string;
  readonly side: SplitSideName;
}

export type TopLevelTabDropTarget =
  TopLevelEdgeSplitTarget | TopLevelFillableTarget;

export interface ValidatedTopLevelTabDrop {
  readonly source: TabRef;
  readonly target: TopLevelTabDropTarget;
}

export function edgeSplitDropId(ref: TabRef, side: SplitSideName): string {
  return `top-level-edge:${ref.kind}:${ref.id}:${side}`;
}

export function fillableSlotDropId(
  splitId: string,
  side: SplitSideName,
): string {
  return `top-level-fillable:${splitId}:${side}`;
}

export function readTopLevelTabDropTarget(
  value: unknown,
): TopLevelTabDropTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === TOP_LEVEL_EDGE_SPLIT_TARGET) {
    const targetRef = readTabRef(value.targetRef);
    const side = readSide(value.side);
    return targetRef === null || side === null
      ? null
      : { kind: TOP_LEVEL_EDGE_SPLIT_TARGET, targetRef, side };
  }
  if (value.kind === TOP_LEVEL_FILLABLE_TARGET) {
    const side = readSide(value.side);
    return typeof value.splitId !== "string" ||
      value.splitId.length === 0 ||
      side === null
      ? null
      : { kind: TOP_LEVEL_FILLABLE_TARGET, splitId: value.splitId, side };
  }
  return null;
}

/** A group member can reorder its group but may never create an edge split. */
export function resolveUnpairedHeaderEdgeSource(
  headerTab: HeaderTabDragData,
  layout: PersistedTabStripLayout,
): TabRef | null {
  const ref: TabRef = { kind: headerTab.tabKind, id: headerTab.tabId };
  const item = findStripItemForRef(layout, ref);
  return item?.kind === "tab" && item.id === headerTab.stripItemId ? ref : null;
}

/**
 * One live guard shared by hover, dwell firing, and drop commit. A droppable's
 * serialized data is only hit geometry: it must never authorize a mutation
 * after selection, locks, compatibility, or the command ledger have changed.
 */
export function resolveValidatedTopLevelTabDrop(
  headerTab: HeaderTabDragData,
  target: TopLevelTabDropTarget,
  layout: PersistedTabStripLayout,
): ValidatedTopLevelTabDrop | null {
  if (!canMutateTabSplits()) return null;
  const ledger = getTabCommandLedger();
  if (ledger.suppressionDepth > 0) return null;
  const source = resolveUnpairedHeaderEdgeSource(headerTab, layout);
  if (source === null || !isEligibleUnlocked(source)) return null;
  const sourceKey = tabRefKey(source);
  if (
    ledger.reservedAdditions.has(sourceKey) ||
    ledger.pendingRemovals.has(sourceKey)
  ) {
    return null;
  }
  if (target.kind === TOP_LEVEL_EDGE_SPLIT_TARGET) {
    return edgeTargetIsLive(source, target, layout) ? { source, target } : null;
  }
  return fillableTargetIsLive(target, layout) ? { source, target } : null;
}

function edgeTargetIsLive(
  source: TabRef,
  target: TopLevelEdgeSplitTarget,
  layout: PersistedTabStripLayout,
): boolean {
  if (
    refsMatch(source, target.targetRef) ||
    layout.activeItemId === null ||
    !isEligibleUnlocked(target.targetRef)
  ) {
    return false;
  }
  const active = layout.items.find((item) => item.id === layout.activeItemId);
  const targetItem = findStripItemForRef(layout, target.targetRef);
  return (
    active?.kind === "tab" &&
    targetItem?.kind === "tab" &&
    active.id === targetItem.id &&
    refsMatch(active.ref, target.targetRef)
  );
}

function fillableTargetIsLive(
  target: TopLevelFillableTarget,
  layout: PersistedTabStripLayout,
): boolean {
  if (layout.activeItemId !== target.splitId) return false;
  const split = layout.items.find((item) => item.id === target.splitId);
  if (split?.kind !== "split") return false;
  const side = target.side === "left" ? split.left : split.right;
  return side.kind !== "tab";
}

function isEligibleUnlocked(ref: TabRef): boolean {
  return (
    !isTabStructurallyLocked(ref) &&
    tabSurfaceDescriptor(ref.kind).splitEligibility === "eligible"
  );
}

function refsMatch(left: TabRef, right: TabRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function readTabRef(value: unknown): TabRef | null {
  if (!isRecord(value)) return null;
  if (typeof value.kind !== "string" || typeof value.id !== "string") {
    return null;
  }
  if (
    value.kind !== "epic" &&
    value.kind !== "draft" &&
    value.kind !== "history" &&
    value.kind !== "settings"
  ) {
    return null;
  }
  if (value.id.length === 0) return null;
  return { kind: value.kind, id: value.id };
}

function readSide(value: unknown): SplitSideName | null {
  return value === "left" || value === "right" ? value : null;
}
