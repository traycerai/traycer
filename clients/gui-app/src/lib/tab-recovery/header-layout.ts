import { z } from "zod";
import {
  createLayoutItem,
  findStripItemForRef,
  flattenStripItemRefs,
  reorderStripItem,
  tabRefKey,
  type CanSplitRef,
  type PersistedTabStripLayout,
  type SplitStripItem,
} from "@/stores/tabs/layout";
import {
  tabCustomizationSchema,
  tabGroupSchema,
  type TabCustomization,
  type TabGroup,
} from "@/stores/tabs/tab-groups";
import { isRegisteredTabKind } from "@/stores/tabs/registry";
import type { TabRef } from "@/stores/tabs/types";

const refSchema = z.object({
  kind: z.custom<TabRef["kind"]>(
    (kind) => typeof kind === "string" && isRegisteredTabKind(kind),
  ),
  id: z.string(),
});
const sideSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tab"), ref: refSchema }),
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("unavailable"),
    previousRef: refSchema,
    label: z.string(),
  }),
]);
export const closedHeaderPlacementSchema = z.object({
  split: z
    .object({
      kind: z.literal("split"),
      id: z.string(),
      left: sideSchema,
      right: sideSchema,
      focusedSide: z.enum(["left", "right"]),
      routeBackingSide: z.enum(["left", "right"]),
      leftRatio: z.number().gt(0).lt(1),
    })
    .optional(),
  customization: tabCustomizationSchema.optional(),
  group: tabGroupSchema.optional(),
});
export interface ClosedHeaderPlacement {
  readonly split?: SplitStripItem;
  readonly customization?: TabCustomization;
  readonly group?: TabGroup;
}
export interface ClosedHeaderLocation {
  readonly index: number;
  readonly placement?: ClosedHeaderPlacement;
}
export interface HeaderLayoutRecovery extends ClosedHeaderLocation {
  readonly ref: TabRef;
}

/** Capture only this tab's presentation; content remains owned by its store. */
export function captureHeaderLocation(
  layout: PersistedTabStripLayout,
  ref: TabRef,
  fallbackIndex: number,
): ClosedHeaderLocation {
  const item = findStripItemForRef(layout, ref);
  if (item === null) return { index: fallbackIndex };
  const customization = layout.customizations?.[tabRefKey(ref)];
  const groupId = customization?.groupId ?? null;
  const group = groupId === null ? undefined : layout.groups?.[groupId];
  const placement: ClosedHeaderPlacement = {
    ...(item.kind === "split" ? { split: item } : {}),
    ...(customization === undefined ? {} : { customization }),
    ...(group === undefined ? {} : { group }),
  };
  return {
    index: layout.items.indexOf(item),
    ...(Object.keys(placement).length === 0 ? {} : { placement }),
  };
}

function restoreCustomization(
  layout: PersistedTabStripLayout,
  item: HeaderLayoutRecovery,
): PersistedTabStripLayout {
  const customization = item.placement?.customization;
  if (customization === undefined) return layout;
  const group = item.placement?.group;
  const groupId = customization.groupId;
  return {
    ...layout,
    customizations: {
      ...layout.customizations,
      [tabRefKey(item.ref)]: customization,
    },
    // An existing group's current name/color/collapse state always wins.
    groups:
      groupId !== null &&
      group !== undefined &&
      layout.groups?.[groupId] === undefined
        ? { ...layout.groups, [groupId]: group }
        : layout.groups,
  };
}

function restoreSplit(
  layout: PersistedTabStripLayout,
  recovery: HeaderLayoutRecovery,
  canSplitRef: CanSplitRef,
): PersistedTabStripLayout {
  const split = recovery.placement?.split;
  if (split === undefined) return layout;
  const refs = flattenStripItemRefs(split);
  if (!refs.some((ref) => tabRefKey(ref) === tabRefKey(recovery.ref)))
    return layout;
  if (refs.some((ref) => !canSplitRef(ref))) return layout;
  // A reused split or a peer paired elsewhere belongs to the user's newer layout.
  if (layout.items.some((item) => item.id === split.id)) return layout;
  const members = refs.map((ref) => findStripItemForRef(layout, ref));
  if (members.some((item) => item?.kind !== "tab")) return layout;
  const groupId = recovery.placement?.customization?.groupId ?? null;
  if (
    refs.some(
      (ref) =>
        (layout.customizations?.[tabRefKey(ref)]?.groupId ?? null) !== groupId,
    )
  )
    return layout;
  const memberIds = new Set(
    members.flatMap((item) => (item === null ? [] : [item.id])),
  );
  const insertionIndex = layout.items.findIndex((item) =>
    memberIds.has(item.id),
  );
  const retained = layout.items.filter((item) => !memberIds.has(item.id));
  return {
    ...layout,
    items: [
      ...retained.slice(0, insertionIndex),
      split,
      ...retained.slice(insertionIndex),
    ],
    activeItemId:
      layout.activeItemId !== null && memberIds.has(layout.activeItemId)
        ? split.id
        : layout.activeItemId,
  };
}

/** Restore the closed items together, so each original split occupies one slot. */
export function restoreHeaderLayout(
  current: PersistedTabStripLayout,
  items: readonly HeaderLayoutRecovery[],
  canSplitRef: CanSplitRef,
): PersistedTabStripLayout {
  const additions = items.filter(
    (item) => findStripItemForRef(current, item.ref) === null,
  );
  let layout = current;
  for (const item of additions.toSorted((a, b) => a.index - b.index)) {
    layout = restoreCustomization(createLayoutItem(layout, item.ref), item);
  }
  for (const item of additions)
    layout = restoreSplit(layout, item, canSplitRef);
  const placedIds = new Set<string>();
  for (const item of additions.toSorted((a, b) => a.index - b.index)) {
    const placed = findStripItemForRef(layout, item.ref);
    if (placed === null || placedIds.has(placed.id)) continue;
    placedIds.add(placed.id);
    // A surviving partner may have moved since close; restore beside it without
    // undoing that move. Entirely recovered items use their original positions.
    if (
      placed.kind === "split" &&
      flattenStripItemRefs(placed).some(
        (ref) => findStripItemForRef(current, ref) !== null,
      )
    )
      continue;
    const from = layout.items.indexOf(placed);
    layout = reorderStripItem(layout, {
      itemId: placed.id,
      targetIndex: from < item.index ? item.index + 1 : item.index,
    });
  }
  return layout;
}
