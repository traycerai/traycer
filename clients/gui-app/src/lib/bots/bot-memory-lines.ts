import type { BotMemoryChange } from "@traycer/protocol/host/bot/schemas";

/**
 * What one line says of one memory (Tracy Bots T373): how many of the run's
 * changes to it added, rewrote and removed an entry, and the entries they
 * touched, each once, in the order the run first touched it.
 */
export interface BotMemoryLineGroup {
  readonly memory: BotMemoryChange["memory"];
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly entryIds: ReadonlyArray<string>;
}

/**
 * The changes made on one surface - the channel (`null`) or one thread, by
 * its stable thread id - oldest first, the id ordering changes made in the
 * same millisecond so every reader draws them alike.
 */
export function memoryChangesOn(
  changes: ReadonlyArray<BotMemoryChange>,
  threadId: string | null,
): ReadonlyArray<BotMemoryChange> {
  return changes
    .filter((change) => change.threadId === threadId)
    .sort((a, b) => a.at - b.at || compareIds(a.id, b.id));
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** One group per memory the run changed, in the order it first touched each. */
export function memoryLineGroupsOf(
  run: ReadonlyArray<BotMemoryChange>,
): ReadonlyArray<BotMemoryLineGroup> {
  const groups = new Map<
    BotMemoryChange["memory"],
    {
      added: number;
      updated: number;
      removed: number;
      readonly entryIds: Set<string>;
    }
  >();
  for (const change of run) {
    let group = groups.get(change.memory);
    if (group === undefined) {
      group = { added: 0, updated: 0, removed: 0, entryIds: new Set() };
      groups.set(change.memory, group);
    }
    if (change.action === "add") group.added += 1;
    else if (change.action === "update") group.updated += 1;
    else group.removed += 1;
    group.entryIds.add(change.entryId);
  }
  return [...groups].map(([memory, group]) => ({
    memory,
    added: group.added,
    updated: group.updated,
    removed: group.removed,
    entryIds: [...group.entryIds],
  }));
}

/** `1 added, 1 removed`: the non-zero counts, in that order. */
export function memoryLineCounts(group: BotMemoryLineGroup): string {
  return [
    group.added === 0 ? null : `${group.added} added`,
    group.updated === 0 ? null : `${group.updated} updated`,
    group.removed === 0 ? null : `${group.removed} removed`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/** The segment's text: `Tracy's memory · 1 added`, `Common memory · 1 updated`. */
export function memoryLineLabel(
  group: BotMemoryLineGroup,
  botTitle: string,
): string {
  const name =
    group.memory === "own" ? `${botTitle}'s memory` : "Common memory";
  return `${name} · ${memoryLineCounts(group)}`;
}

/** What the segment opens, for a screen reader. */
export function memoryLineAccessibleName(
  group: BotMemoryLineGroup,
  botTitle: string,
): string {
  const name =
    group.memory === "own" ? `${botTitle}'s memory` : "common memory";
  return `Open ${name}: ${memoryLineCounts(group)}`;
}

/** The pane's note for the entries a line names that are no longer there. */
export function memoryFocusGoneNote(count: number): string {
  return count === 1
    ? "1 entry this line names was removed and is no longer here."
    : `${count} entries this line names were removed and are no longer here.`;
}
