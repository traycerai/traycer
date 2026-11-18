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
export const TOP_LEVEL_FILLABLE_TARGET = "top-level-fillable-slot";
export const TOP_LEVEL_STRIP_PAIR_TARGET = "top-level-strip-pair";

export interface TopLevelFillableTarget {
  readonly kind: typeof TOP_LEVEL_FILLABLE_TARGET;
  readonly splitId: string;
  readonly side: SplitSideName;
}

/**
 * Dropping a tab onto the middle of another tab in the strip pairs the two into
 * a split. Unlike an edge target this carries no side and does not require the
 * target to be the active item - the whole point of the gesture is to combine
 * with a tab you are not currently looking at.
 */
export interface TopLevelStripPairTarget {
  readonly kind: typeof TOP_LEVEL_STRIP_PAIR_TARGET;
  readonly targetRef: TabRef;
}

export type TopLevelTabDropTarget =
  | TopLevelFillableTarget
  | TopLevelStripPairTarget;

export interface ValidatedTopLevelTabDrop {
  readonly source: TabRef;
  readonly target: TopLevelTabDropTarget;
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

/** A group member can reorder its group but may never pair or fill a slot. */
export function resolveUnpairedHeaderSource(
  headerTab: HeaderTabDragData,
  layout: PersistedTabStripLayout,
): TabRef | null {
  const ref: TabRef = { kind: headerTab.tabKind, id: headerTab.tabId };
  const item = findStripItemForRef(layout, ref);
  return item?.kind === "tab" && item.id === headerTab.stripItemId ? ref : null;
}

/**
 * One live guard shared by hover and drop commit. A droppable's serialized
 * data is only hit geometry: it must never authorize a mutation after
 * selection, locks, compatibility, or the command ledger have changed.
 */
export function resolveValidatedTopLevelTabDrop(
  headerTab: HeaderTabDragData,
  target: TopLevelTabDropTarget,
  layout: PersistedTabStripLayout,
): ValidatedTopLevelTabDrop | null {
  const ledger = getTabCommandLedger();
  if (ledger.suppressionDepth > 0) return null;
  const source = resolveUnpairedHeaderSource(headerTab, layout);
  if (source === null || !isEligibleUnlocked(source)) return null;
  const sourceKey = tabRefKey(source);
  if (
    ledger.reservedAdditions.has(sourceKey) ||
    ledger.pendingRemovals.has(sourceKey)
  ) {
    return null;
  }
  if (target.kind === TOP_LEVEL_STRIP_PAIR_TARGET) {
    if (!canMutateTabSplits()) return null;
    return stripPairTargetIsLive(source, target, layout)
      ? { source, target }
      : null;
  }
  return fillableTargetIsLive(target, layout) ? { source, target } : null;
}

/**
 * Both tabs must still be ungrouped strip items: pairing consumes two whole
 * strip entries, so a target that has since joined a group (or is the source
 * itself) can no longer take part.
 */
function stripPairTargetIsLive(
  source: TabRef,
  target: TopLevelStripPairTarget,
  layout: PersistedTabStripLayout,
): boolean {
  if (
    refsMatch(source, target.targetRef) ||
    !isEligibleUnlocked(target.targetRef)
  ) {
    return false;
  }
  // A ref that has joined a group resolves to its `split` item, so this single
  // check covers both "target vanished" and "target is no longer ungrouped".
  return findStripItemForRef(layout, target.targetRef)?.kind === "tab";
}

/**
 * The strip tab a pair gesture over `stripIndex` would combine with, or null
 * when that position is not an ungrouped tab. Resolved from the live layout
 * rather than carried in the drag payload, so a strip that changed mid-drag
 * cannot authorize a pair against a stale ref.
 */
export function stripPairTargetForIndex(
  stripIndex: number,
  layout: PersistedTabStripLayout,
): TopLevelStripPairTarget | null {
  const item = layout.items.at(stripIndex);
  if (item === undefined || item.kind !== "tab") return null;
  return { kind: TOP_LEVEL_STRIP_PAIR_TARGET, targetRef: item.ref };
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

function readSide(value: unknown): SplitSideName | null {
  return value === "left" || value === "right" ? value : null;
}
