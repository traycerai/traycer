import type { HeaderTabKind } from "@/stores/tabs/registry";
import type { SystemTab, TabRef } from "@/stores/tabs/types";

export type SplitSideName = "left" | "right";

export type SplitSide =
  | { readonly kind: "tab"; readonly ref: TabRef }
  | { readonly kind: "empty" }
  | {
      readonly kind: "unavailable";
      readonly previousRef: TabRef;
      readonly label: string;
    };

export interface TabStripItem {
  readonly kind: "tab";
  readonly id: string;
  readonly ref: TabRef;
}

export interface SplitStripItem {
  readonly kind: "split";
  readonly id: string;
  readonly left: SplitSide;
  readonly right: SplitSide;
  readonly focusedSide: SplitSideName;
  readonly routeBackingSide: SplitSideName;
  readonly leftRatio: number;
}

export type StripItem = TabStripItem | SplitStripItem;

export interface PersistedTabStripLayout {
  readonly version: 2;
  readonly items: ReadonlyArray<StripItem>;
  readonly activeItemId: string | null;
  readonly systemTabs: SystemTabs;
}

export interface SystemTabs {
  readonly history: SystemTab | null;
  readonly settings: SystemTab | null;
}

export interface PairLayoutArgs {
  readonly left: TabRef;
  readonly right: TabRef;
  readonly splitId: string;
  readonly leftRatio: number;
}

export interface CreateEmptySplitArgs {
  readonly ref: TabRef;
  readonly splitId: string;
  readonly populatedSide: SplitSideName;
  readonly focusedSide: SplitSideName;
  readonly leftRatio: number;
}

export interface ReplaceFillableSideArgs {
  readonly splitId: string;
  readonly side: SplitSideName;
  readonly ref: TabRef;
}

export interface ResizeSplitArgs {
  readonly splitId: string;
  readonly leftRatio: number;
}

export interface SplitSideArgs {
  readonly splitId: string;
  readonly side: SplitSideName;
}

export interface ReplaceRefArgs {
  readonly previous: TabRef;
  readonly next: TabRef;
}

export interface ReorderItemArgs {
  readonly itemId: string;
  readonly targetIndex: number;
}

export type IsKnownTabKind = (kind: string) => kind is HeaderTabKind;
export type CanSplitRef = (ref: TabRef) => boolean;

export const DEFAULT_LEFT_RATIO = 0.5;

export function tabRefKey(ref: TabRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function tabItemId(ref: TabRef): string {
  return `tab:${tabRefKey(ref)}`;
}

export function splitItemId(id: string): string {
  const normalized = id.length === 0 ? "split" : id;
  return normalized.startsWith("tab:") ? `split:${normalized}` : normalized;
}

export function emptySystemTabs(): SystemTabs {
  return { history: null, settings: null };
}

export function emptyTabStripLayout(): PersistedTabStripLayout {
  return {
    version: 2,
    items: [],
    activeItemId: null,
    systemTabs: emptySystemTabs(),
  };
}

export function flattenStripItemRefs(item: StripItem): ReadonlyArray<TabRef> {
  if (item.kind === "tab") return [item.ref];
  return [item.left, item.right].flatMap((side) =>
    side.kind === "tab" ? [side.ref] : [],
  );
}

export function flattenLayoutRefs(
  layout: PersistedTabStripLayout,
): ReadonlyArray<TabRef> {
  return layout.items.flatMap(flattenStripItemRefs);
}

export function findStripItemForRef(
  layout: PersistedTabStripLayout,
  ref: TabRef,
): StripItem | null {
  return (
    layout.items.find((item) =>
      flattenStripItemRefs(item).some((entry) => refsEqual(entry, ref)),
    ) ?? null
  );
}

export function createLayoutItem(
  layout: PersistedTabStripLayout,
  ref: TabRef,
): PersistedTabStripLayout {
  if (findStripItemForRef(layout, ref) !== null) return layout;
  const item: TabStripItem = { kind: "tab", id: tabItemId(ref), ref };
  return {
    ...layout,
    items: [...layout.items, item],
    activeItemId: item.id,
  };
}

export function pairLayoutRefs(
  layout: PersistedTabStripLayout,
  args: PairLayoutArgs,
  canSplitRef: CanSplitRef,
): PersistedTabStripLayout {
  if (!canSplitRef(args.left) || !canSplitRef(args.right)) return layout;
  if (refsEqual(args.left, args.right)) return layout;
  const leftIndex = findFlatItemIndex(layout.items, args.left);
  const rightIndex = findFlatItemIndex(layout.items, args.right);
  if (leftIndex === -1 || rightIndex === -1) return layout;
  const split: SplitStripItem = {
    kind: "split",
    id: availableSplitItemId(layout, args.splitId),
    left: { kind: "tab", ref: args.left },
    right: { kind: "tab", ref: args.right },
    focusedSide: "right",
    routeBackingSide: "right",
    leftRatio: validRatio(args.leftRatio) ? args.leftRatio : DEFAULT_LEFT_RATIO,
  };
  const insertionIndex = Math.min(leftIndex, rightIndex);
  const retained = layout.items.filter(
    (item) =>
      item !== layout.items[leftIndex] && item !== layout.items[rightIndex],
  );
  return {
    ...layout,
    items: [
      ...retained.slice(0, insertionIndex),
      split,
      ...retained.slice(insertionIndex),
    ],
    activeItemId: split.id,
  };
}

export function createEmptySplit(
  layout: PersistedTabStripLayout,
  args: CreateEmptySplitArgs,
  canSplitRef: CanSplitRef,
): PersistedTabStripLayout {
  if (!canSplitRef(args.ref)) return layout;
  const itemIndex = findFlatItemIndex(layout.items, args.ref);
  if (itemIndex === -1) return layout;
  const populated: SplitSide = { kind: "tab", ref: args.ref };
  const split: SplitStripItem = {
    kind: "split",
    id: availableSplitItemId(layout, args.splitId),
    left: args.populatedSide === "left" ? populated : { kind: "empty" },
    right: args.populatedSide === "right" ? populated : { kind: "empty" },
    focusedSide: args.focusedSide,
    routeBackingSide: args.populatedSide,
    leftRatio: validRatio(args.leftRatio) ? args.leftRatio : DEFAULT_LEFT_RATIO,
  };
  return {
    ...layout,
    items: layout.items.map((item, index) =>
      index === itemIndex ? split : item,
    ),
    activeItemId: split.id,
  };
}

export function replaceFillableSide(
  layout: PersistedTabStripLayout,
  args: ReplaceFillableSideArgs,
  canSplitRef: CanSplitRef,
): PersistedTabStripLayout {
  if (!canSplitRef(args.ref)) return layout;
  if (findStripItemForRef(layout, args.ref) !== null) return layout;
  const item = findSplitById(layout.items, args.splitId);
  if (item === null) return layout;
  const currentSide = sideAt(item, args.side);
  if (currentSide.kind === "tab") return layout;
  const nextSide: SplitSide = { kind: "tab", ref: args.ref };
  const nextItem: SplitStripItem = {
    ...item,
    left: args.side === "left" ? nextSide : item.left,
    right: args.side === "right" ? nextSide : item.right,
    routeBackingSide:
      item.focusedSide === args.side ? args.side : item.routeBackingSide,
  };
  return replaceItem(layout, nextItem);
}

export function focusLayoutRef(
  layout: PersistedTabStripLayout,
  ref: TabRef,
): PersistedTabStripLayout {
  const item = findStripItemForRef(layout, ref);
  if (item === null) return layout;
  if (item.kind === "tab") return { ...layout, activeItemId: item.id };
  const side = refsEqual(item.left.kind === "tab" ? item.left.ref : null, ref)
    ? "left"
    : "right";
  return focusSplitSide(layout, { splitId: item.id, side });
}

export function focusSplitSide(
  layout: PersistedTabStripLayout,
  args: SplitSideArgs,
): PersistedTabStripLayout {
  const item = findSplitById(layout.items, args.splitId);
  if (item === null) return layout;
  const side = sideAt(item, args.side);
  const next: SplitStripItem = {
    ...item,
    focusedSide: args.side,
    routeBackingSide: side.kind === "tab" ? args.side : item.routeBackingSide,
  };
  return { ...replaceItem(layout, next), activeItemId: item.id };
}

export function resizeSplit(
  layout: PersistedTabStripLayout,
  args: ResizeSplitArgs,
): PersistedTabStripLayout {
  if (!validRatio(args.leftRatio)) return layout;
  const item = findSplitById(layout.items, args.splitId);
  if (item === null || item.leftRatio === args.leftRatio) return layout;
  return replaceItem(layout, { ...item, leftRatio: args.leftRatio });
}

export function swapSplitSides(
  layout: PersistedTabStripLayout,
  splitId: string,
): PersistedTabStripLayout {
  const item = findSplitById(layout.items, splitId);
  if (item === null) return layout;
  return replaceItem(layout, {
    ...item,
    left: item.right,
    right: item.left,
    focusedSide: oppositeSide(item.focusedSide),
    routeBackingSide: oppositeSide(item.routeBackingSide),
    leftRatio: 1 - item.leftRatio,
  });
}

export function separateSplit(
  layout: PersistedTabStripLayout,
  splitId: string,
): PersistedTabStripLayout {
  const item = findSplitById(layout.items, splitId);
  if (item === null) return layout;
  const itemIndex = layout.items.indexOf(item);
  const members = flattenStripItemRefs(item).map<TabStripItem>((ref) => ({
    kind: "tab",
    id: tabItemId(ref),
    ref,
  }));
  const focused = sideAt(item, item.focusedSide);
  const activeRef = focused.kind === "tab" ? focused.ref : backingRef(item);
  const items = [
    ...layout.items.slice(0, itemIndex),
    ...members,
    ...layout.items.slice(itemIndex + 1),
  ];
  return {
    ...layout,
    items,
    activeItemId:
      layout.activeItemId === item.id && activeRef !== null
        ? tabItemId(activeRef)
        : layout.activeItemId,
  };
}

export function replaceLayoutRef(
  layout: PersistedTabStripLayout,
  args: ReplaceRefArgs,
): PersistedTabStripLayout {
  if (refsEqual(args.previous, args.next)) return layout;
  if (findStripItemForRef(layout, args.next) !== null) return layout;
  const item = findStripItemForRef(layout, args.previous);
  if (item === null) return layout;
  if (item.kind === "tab") {
    const next: TabStripItem = {
      kind: "tab",
      id: tabItemId(args.next),
      ref: args.next,
    };
    const activeItemId =
      layout.activeItemId === item.id ? next.id : layout.activeItemId;
    return {
      ...layout,
      items: layout.items.map((entry) => (entry.id === item.id ? next : entry)),
      activeItemId,
    };
  }
  const left = replaceSideRef(item.left, args.previous, args.next);
  const right = replaceSideRef(item.right, args.previous, args.next);
  return replaceItem(layout, { ...item, left, right });
}

export function removeLayoutRef(
  layout: PersistedTabStripLayout,
  ref: TabRef,
): PersistedTabStripLayout {
  const itemIndex = layout.items.findIndex((item) =>
    flattenStripItemRefs(item).some((entry) => refsEqual(entry, ref)),
  );
  if (itemIndex === -1) return layout;
  const item = layout.items[itemIndex];
  if (item.kind === "tab") {
    const items = layout.items.filter((_entry, index) => index !== itemIndex);
    const activeItemId =
      layout.activeItemId === item.id
        ? neighboringItemId(items, itemIndex)
        : layout.activeItemId;
    return {
      ...layout,
      items,
      activeItemId,
    };
  }
  const survivor = flattenStripItemRefs(item).find(
    (entry) => !refsEqual(entry, ref),
  );
  const items =
    survivor === undefined
      ? layout.items.filter((_entry, index) => index !== itemIndex)
      : replaceItemAtIndex(layout.items, itemIndex, survivor);
  let nextActiveId = layout.activeItemId;
  if (layout.activeItemId === item.id) {
    nextActiveId =
      survivor === undefined
        ? neighboringItemId(items, itemIndex)
        : tabItemId(survivor);
  }
  return { ...layout, items, activeItemId: nextActiveId };
}

export function reorderStripItem(
  layout: PersistedTabStripLayout,
  args: ReorderItemArgs,
): PersistedTabStripLayout {
  const exactItemIndex = layout.items.findIndex(
    (item) => item.id === args.itemId,
  );
  const requestedSplit =
    exactItemIndex === -1 ? findSplitById(layout.items, args.itemId) : null;
  const from =
    requestedSplit === null
      ? exactItemIndex
      : layout.items.indexOf(requestedSplit);
  if (from === -1) return layout;
  const target = Math.max(0, Math.min(args.targetIndex, layout.items.length));
  const insertion = from < target ? target - 1 : target;
  if (from === insertion) return layout;
  const item = layout.items[from];
  const without = layout.items.filter((_entry, index) => index !== from);
  return {
    ...layout,
    items: [...without.slice(0, insertion), item, ...without.slice(insertion)],
  };
}

/**
 * Deterministically repairs every persisted-layout invariant. Call at
 * hydration and after each transaction commit; the reducer entry points are
 * deliberately pure so a coordinator can preflight them without a store.
 */
export function repairLayout(
  layout: PersistedTabStripLayout,
  isKnownTabKind: IsKnownTabKind,
): PersistedTabStripLayout {
  const context: RepairContext = {
    seenRefs: new Set<string>(),
    usedIds: new Set<string>(),
    repairedItemIdByOriginalId: new Map<string, string>(),
    isKnownTabKind,
  };
  const items = layout.items.reduce<ReadonlyArray<StripItem>>(
    (repaired, item, index) => {
      const next = repairStripItem(item, index, context);
      return next === null ? repaired : [...repaired, next];
    },
    [],
  );
  const systemTabs = repairSystemTabs(layout.systemTabs);
  const remappedActiveItemId =
    layout.activeItemId === null
      ? undefined
      : context.repairedItemIdByOriginalId.get(layout.activeItemId);
  const activeItemId =
    remappedActiveItemId !== undefined &&
    items.some((item) => item.id === remappedActiveItemId)
      ? remappedActiveItemId
      : firstItemId(items);
  const withSystemRefs: PersistedTabStripLayout = {
    version: 2,
    items,
    activeItemId,
    systemTabs,
  };
  const missingSystemRefs = flattenLayoutRefs(withSystemRefs).filter(
    (ref) =>
      (ref.kind === "history" && systemTabs.history === null) ||
      (ref.kind === "settings" && systemTabs.settings === null),
  );
  const withoutMissingSystemRefs = missingSystemRefs.reduce(
    removeLayoutRef,
    withSystemRefs,
  );
  return {
    ...withoutMissingSystemRefs,
    activeItemId:
      withoutMissingSystemRefs.items.length === 0
        ? null
        : withoutMissingSystemRefs.activeItemId,
  };
}

interface RepairContext {
  readonly seenRefs: Set<string>;
  readonly usedIds: Set<string>;
  readonly repairedItemIdByOriginalId: Map<string, string>;
  readonly isKnownTabKind: IsKnownTabKind;
}

function repairStripItem(
  item: StripItem,
  index: number,
  context: RepairContext,
): StripItem | null {
  if (item.kind === "tab") {
    if (
      !validRef(item.ref, context.isKnownTabKind) ||
      context.seenRefs.has(tabRefKey(item.ref))
    ) {
      return null;
    }
    context.seenRefs.add(tabRefKey(item.ref));
    const id = uniqueItemId(
      tabItemId(item.ref),
      item.kind,
      index,
      context.usedIds,
    );
    recordRepairedItemId(context, item.id, id);
    return { kind: "tab", id, ref: item.ref };
  }
  const left = repairSplitSide(
    item.left,
    context.seenRefs,
    context.isKnownTabKind,
  );
  const right = repairSplitSide(
    item.right,
    context.seenRefs,
    context.isKnownTabKind,
  );
  if (!hasPopulatedSide(left) && !hasPopulatedSide(right)) return null;
  const id = uniqueItemId(
    splitItemId(item.id),
    item.kind,
    index,
    context.usedIds,
  );
  recordRepairedItemId(context, item.id, id);
  return {
    kind: "split",
    id,
    left,
    right,
    focusedSide: item.focusedSide,
    routeBackingSide: repairedRouteBackingSide(
      item.routeBackingSide,
      left,
      right,
    ),
    leftRatio: validRatio(item.leftRatio) ? item.leftRatio : DEFAULT_LEFT_RATIO,
  };
}

function findFlatItemIndex(
  items: ReadonlyArray<StripItem>,
  ref: TabRef,
): number {
  return items.findIndex(
    (item) => item.kind === "tab" && refsEqual(item.ref, ref),
  );
}

function availableSplitItemId(
  layout: PersistedTabStripLayout,
  requestedId: string,
): string {
  return uniqueItemId(
    splitItemId(requestedId),
    "split",
    layout.items.length,
    new Set(layout.items.map((item) => item.id)),
  );
}

function findSplitById(
  items: ReadonlyArray<StripItem>,
  splitId: string,
): SplitStripItem | null {
  return (
    items.find(
      (item): item is SplitStripItem =>
        item.kind === "split" && item.id === splitItemId(splitId),
    ) ?? null
  );
}

function recordRepairedItemId(
  context: RepairContext,
  originalId: string,
  repairedId: string,
): void {
  if (!context.repairedItemIdByOriginalId.has(originalId)) {
    context.repairedItemIdByOriginalId.set(originalId, repairedId);
  }
}

function replaceItem(
  layout: PersistedTabStripLayout,
  replacement: StripItem,
): PersistedTabStripLayout {
  return {
    ...layout,
    items: layout.items.map((item) =>
      item.id === replacement.id ? replacement : item,
    ),
  };
}

function replaceItemAtIndex(
  items: ReadonlyArray<StripItem>,
  targetIndex: number,
  ref: TabRef,
): ReadonlyArray<StripItem> {
  const replacement: TabStripItem = { kind: "tab", id: tabItemId(ref), ref };
  return items.map((item, index) =>
    index === targetIndex ? replacement : item,
  );
}

function neighboringItemId(
  items: ReadonlyArray<StripItem>,
  formerIndex: number,
): string | null {
  const left = formerIndex === 0 ? undefined : items.at(formerIndex - 1);
  if (left !== undefined) return left.id;
  const right = items.at(formerIndex);
  return right === undefined ? null : right.id;
}

function firstItemId(items: ReadonlyArray<StripItem>): string | null {
  const first = items.at(0);
  return first === undefined ? null : first.id;
}

function sideAt(item: SplitStripItem, side: SplitSideName): SplitSide {
  return side === "left" ? item.left : item.right;
}

function backingRef(item: SplitStripItem): TabRef | null {
  const side = sideAt(item, item.routeBackingSide);
  return side.kind === "tab" ? side.ref : null;
}

function oppositeSide(side: SplitSideName): SplitSideName {
  return side === "left" ? "right" : "left";
}

function refsEqual(a: TabRef | null, b: TabRef | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.id === b.id;
}

function replaceSideRef(
  side: SplitSide,
  previous: TabRef,
  next: TabRef,
): SplitSide {
  return side.kind === "tab" && refsEqual(side.ref, previous)
    ? { kind: "tab", ref: next }
    : side;
}

function validRatio(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1;
}

function validRef(ref: TabRef, isKnownTabKind: IsKnownTabKind): boolean {
  if (!isKnownTabKind(ref.kind) || ref.id.length === 0) return false;
  if (ref.kind === "history") return ref.id === "history";
  if (ref.kind === "settings") return ref.id === "settings";
  return true;
}

function repairSplitSide(
  side: SplitSide,
  seenRefs: Set<string>,
  isKnownTabKind: IsKnownTabKind,
): SplitSide {
  if (side.kind === "empty") return side;
  if (side.kind === "unavailable") {
    return validRef(side.previousRef, isKnownTabKind)
      ? {
          kind: "unavailable",
          previousRef: side.previousRef,
          label: side.label.length === 0 ? "Unavailable tab" : side.label,
        }
      : { kind: "empty" };
  }
  if (
    !validRef(side.ref, isKnownTabKind) ||
    seenRefs.has(tabRefKey(side.ref))
  ) {
    return { kind: "empty" };
  }
  seenRefs.add(tabRefKey(side.ref));
  return side;
}

function hasPopulatedSide(side: SplitSide): boolean {
  return side.kind === "tab";
}

function repairedRouteBackingSide(
  routeBackingSide: SplitSideName,
  left: SplitSide,
  right: SplitSide,
): SplitSideName {
  if (routeBackingSide === "left" && left.kind === "tab") return "left";
  if (routeBackingSide === "right" && right.kind === "tab") return "right";
  return left.kind === "tab" ? "left" : "right";
}

function uniqueItemId(
  candidate: string,
  kind: StripItem["kind"],
  index: number,
  usedIds: Set<string>,
): string {
  const base = candidate.length > 0 ? candidate : `${kind}-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function repairSystemTabs(systemTabs: SystemTabs): SystemTabs {
  return {
    history:
      systemTabs.history !== null && systemTabs.history.kind === "history"
        ? { ...systemTabs.history, id: "history", kind: "history" }
        : null,
    settings:
      systemTabs.settings !== null && systemTabs.settings.kind === "settings"
        ? { ...systemTabs.settings, id: "settings", kind: "settings" }
        : null,
  };
}
