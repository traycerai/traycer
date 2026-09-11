import { z } from "zod";
import {
  findStripItemForRef,
  flattenStripItemRefs,
  tabRefKey,
  type PersistedTabStripLayout,
  type StripItem,
} from "./layout";
import type { TabRef } from "./types";

export const TAB_COLORS = [
  { name: "Gray", value: "#c4c7c5" },
  { name: "Blue", value: "#8ab4f8" },
  { name: "Red", value: "#f28b82" },
  { name: "Yellow", value: "#fdd663" },
  { name: "Green", value: "#81c995" },
  { name: "Pink", value: "#ff8bcb" },
  { name: "Purple", value: "#c58af9" },
  { name: "Cyan", value: "#78d9ec" },
  { name: "Orange", value: "#fcad70" },
] as const;

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const customizationSchema = z.object({
  color: colorSchema.nullable(),
  icon: z.string().max(32).nullable(),
  groupId: z.string().max(128).nullable(),
});
const groupSchema = z.object({
  name: z.string().max(80),
  color: colorSchema,
  collapsed: z.boolean(),
});
export type TabCustomization = z.infer<typeof customizationSchema>;
export type TabGroup = z.infer<typeof groupSchema>;
export type TabCustomizations = Readonly<Record<string, TabCustomization>>;
export type TabGroups = Readonly<Record<string, TabGroup>>;
export const DEFAULT_TAB_CUSTOMIZATION: TabCustomization = {
  color: null,
  icon: null,
  groupId: null,
};

export function parseTabCustomizations(value: unknown): TabCustomizations {
  const parsed = z.record(z.string(), customizationSchema).safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function parseTabGroups(value: unknown): TabGroups {
  const parsed = z.record(z.string(), groupSchema).safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function stripItemGroupId(
  item: StripItem,
  customizations: TabCustomizations | undefined,
): string | null {
  const ref = flattenStripItemRefs(item).at(0);
  return ref === undefined
    ? null
    : (customizations?.[tabRefKey(ref)]?.groupId ?? null);
}

export function setLayoutTabGroup(
  layout: PersistedTabStripLayout,
  ref: TabRef,
  groupId: string | null,
): PersistedTabStripLayout {
  if (groupId !== null && layout.groups?.[groupId] === undefined) return layout;
  const item = findStripItemForRef(layout, ref);
  if (item === null) return layout;
  const customizations = { ...layout.customizations };
  for (const member of flattenStripItemRefs(item)) {
    const key = tabRefKey(member);
    customizations[key] = {
      ...(customizations[key] ?? DEFAULT_TAB_CUSTOMIZATION),
      groupId,
    };
  }
  const group = groupId === null ? undefined : layout.groups?.[groupId];
  return {
    ...layout,
    customizations,
    groups:
      groupId !== null && group !== undefined
        ? { ...layout.groups, [groupId]: { ...group, collapsed: false } }
        : layout.groups,
  };
}

export function inheritTabGroup(
  layout: PersistedTabStripLayout,
  sourceRef: TabRef,
  targetRef: TabRef,
): PersistedTabStripLayout {
  const source =
    layout.customizations?.[tabRefKey(sourceRef)] ?? DEFAULT_TAB_CUSTOMIZATION;
  const key = tabRefKey(targetRef);
  const target = layout.customizations?.[key] ?? DEFAULT_TAB_CUSTOMIZATION;
  if (source.groupId === target.groupId) return layout;
  return {
    ...layout,
    customizations: {
      ...layout.customizations,
      [key]: { ...target, groupId: source.groupId },
    },
  };
}

/** Keep group membership consistent across closes, splits and restores. */
export function repairTabGroups(
  layout: PersistedTabStripLayout,
): PersistedTabStripLayout {
  if (layout.customizations === undefined && layout.groups === undefined)
    return layout;
  const customizations: Record<string, TabCustomization> = {};
  const groups: Record<string, TabGroup> = {};
  for (const item of layout.items) {
    collectItemCustomizations(item, layout, customizations, groups);
  }
  const groupItems = new Map<string, StripItem[]>();
  for (const item of layout.items) {
    const groupId = stripItemGroupId(item, customizations);
    if (groupId === null) continue;
    const members = groupItems.get(groupId);
    if (members === undefined) groupItems.set(groupId, [item]);
    else members.push(item);
  }
  const items: StripItem[] = [];
  const emittedGroups = new Set<string>();
  for (const item of layout.items) {
    const groupId = stripItemGroupId(item, customizations);
    if (groupId === null) {
      items.push(item);
    } else if (!emittedGroups.has(groupId)) {
      emittedGroups.add(groupId);
      items.push(...(groupItems.get(groupId) ?? []));
    }
  }
  return { ...layout, items, customizations, groups };
}

function collectItemCustomizations(
  item: StripItem,
  layout: PersistedTabStripLayout,
  customizations: Record<string, TabCustomization>,
  groups: Record<string, TabGroup>,
): void {
  const refs = flattenStripItemRefs(item);
  const groupId = stripItemGroupId(item, layout.customizations);
  const group = groupId === null ? undefined : layout.groups?.[groupId];
  if (groupId !== null && group !== undefined) groups[groupId] = group;
  for (const ref of refs) {
    const key = tabRefKey(ref);
    const existing = layout.customizations?.[key];
    if (existing !== undefined || group !== undefined) {
      const current = existing ?? DEFAULT_TAB_CUSTOMIZATION;
      customizations[key] = {
        ...current,
        groupId: group === undefined ? null : groupId,
      };
    }
  }
}
