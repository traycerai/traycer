/**
 * Pure helpers for organizing palette items into the groups the
 * renderer draws. No React; unit-testable in isolation.
 */
import type {
  CommandGroupId,
  CommandItem,
  CommandScope,
} from "@/lib/commands/types";

export interface CommandGroupBucket {
  readonly id: CommandGroupId;
  readonly label: string;
  readonly items: ReadonlyArray<CommandItem>;
}

const GROUP_LABELS: Readonly<Record<CommandGroupId, string>> = {
  pinned: "Pinned",
  recents: "Recent",
  suggested: "Suggested",
  actions: "Actions",
  navigation: "Navigation",
  epics: "Tasks",
  theme: "Theme",
  help: "Help",
  open: "Open into pane",
};

const DEFAULT_GROUP_ORDER: ReadonlyArray<CommandGroupId> = [
  "suggested",
  "epics",
  "actions",
  "navigation",
  "theme",
  "help",
];

/**
 * Partition items into their declared groups, drop empty groups,
 * and sort each group's items alphabetically by label. Returns the
 * groups in `DEFAULT_GROUP_ORDER`; `pinned` and `recents` are
 * composed separately by the renderer so they always appear on top.
 */
export function bucketItems(
  items: ReadonlyArray<CommandItem>,
): ReadonlyArray<CommandGroupBucket> {
  const byGroup = new Map<CommandGroupId, Array<CommandItem>>();
  for (const item of items) {
    const list = byGroup.get(item.group);
    if (list === undefined) {
      byGroup.set(item.group, [item]);
    } else {
      list.push(item);
    }
  }

  const buckets: Array<CommandGroupBucket> = [];
  for (const id of DEFAULT_GROUP_ORDER) {
    const list = byGroup.get(id);
    if (list === undefined || list.length === 0) continue;
    const sorted = list.toSorted((a, b) => a.label.localeCompare(b.label));
    buckets.push({ id, label: GROUP_LABELS[id], items: sorted });
  }
  return buckets;
}

/**
 * Build the recents group from a list of item ids + the current
 * item pool. Unknown ids (e.g. a source that no longer emits the
 * item) are silently pruned so stale ids never surface an empty
 * row.
 */
export function buildRecentsBucket(
  recentIds: ReadonlyArray<string>,
  pool: ReadonlyArray<CommandItem>,
): CommandGroupBucket | null {
  if (recentIds.length === 0) return null;
  const byId = new Map(pool.map((item) => [item.id, item]));
  const resolved: Array<CommandItem> = [];
  for (const id of recentIds) {
    const item = byId.get(id);
    if (item !== undefined) resolved.push(item);
  }
  if (resolved.length === 0) return null;
  return { id: "recents", label: GROUP_LABELS.recents, items: resolved };
}

/**
 * Build the pinned group. Pinned ids preserve user-defined order
 * rather than re-sorting alphabetically.
 */
export function buildPinnedBucket(
  pinnedIds: ReadonlyArray<string>,
  pool: ReadonlyArray<CommandItem>,
): CommandGroupBucket | null {
  if (pinnedIds.length === 0) return null;
  const byId = new Map(pool.map((item) => [item.id, item]));
  const resolved: Array<CommandItem> = [];
  for (const id of pinnedIds) {
    const item = byId.get(id);
    if (item !== undefined) resolved.push(item);
  }
  if (resolved.length === 0) return null;
  return { id: "pinned", label: GROUP_LABELS.pinned, items: resolved };
}

/**
 * Filter a pool down to items whose scope matches `activeScope`.
 * `null` scope means "everything" and is the normal default.
 */
export function filterByScope(
  items: ReadonlyArray<CommandItem>,
  activeScope: CommandScope | null,
): ReadonlyArray<CommandItem> {
  if (activeScope === null) return items;
  return items.filter((item) => item.scope === activeScope);
}
