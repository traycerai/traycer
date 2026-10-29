import type {
  BotMemory,
  BotMemoryEntry,
  BotMemoryTagUsage,
} from "@traycer/protocol/host/bot/schemas";

/** The tag of the entries every bot of the environment reads. */
const SHARED_TAG = "all";

/**
 * The bot's memory as its pane lists it (Tracy Bots T87): its own entries,
 * then the shared ones it did not also tag for itself, each newest-confirmed
 * first, and only the entries whose text holds `query` (any case).
 */
export function memorySections(
  memory: BotMemory,
  botId: string,
  query: string,
): {
  readonly own: readonly BotMemoryEntry[];
  readonly shared: readonly BotMemoryEntry[];
} {
  const needle = query.trim().toLocaleLowerCase();
  const found = memory.entries
    .filter(
      (entry) =>
        needle.length === 0 || entry.text.toLocaleLowerCase().includes(needle),
    )
    .sort(newestConfirmedFirst);
  return {
    own: found.filter((entry) => entry.tags.includes(botId)),
    shared: found.filter(
      (entry) => !entry.tags.includes(botId) && entry.tags.includes(SHARED_TAG),
    ),
  };
}

/** When the entry last held: its confirmation, else its writing. */
function heldAt(entry: BotMemoryEntry): number | null {
  return entry.confirmedAt ?? entry.at;
}

/** Newest-confirmed first; an entry no time dates last; id the tie-break. */
function newestConfirmedFirst(a: BotMemoryEntry, b: BotMemoryEntry): number {
  const aAt = heldAt(a);
  const bAt = heldAt(b);
  if (aAt !== bAt) {
    if (aAt === null) return 1;
    if (bAt === null) return -1;
    return bAt - aAt;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * Whether the entry was confirmed after it was written. An entry whose
 * confirmation is its writing reads "never confirmed since".
 */
export function confirmedSinceWritten(entry: BotMemoryEntry): boolean {
  return (
    entry.confirmedAt !== null &&
    entry.at !== null &&
    entry.confirmedAt > entry.at
  );
}

/**
 * Roughly how many entries of the size the bot keeps fit under its ceiling:
 * the "about 40" of "7 of about 40". `null` with nothing kept to measure by.
 */
export function aboutCapacity(usage: BotMemoryTagUsage): number | null {
  if (usage.entries === 0 || usage.chars === 0) return null;
  return Math.max(
    usage.entries,
    Math.round((usage.entries * usage.ceiling) / usage.chars),
  );
}

/** How full the tag is, from 0 to 1. */
export function fillOf(usage: BotMemoryTagUsage): number {
  return Math.min(1, usage.chars / usage.ceiling);
}

/**
 * What the pane has seen change while it was open: the entries written since
 * (`New`), each with when the entry it took the place of was written, if one
 * went in the same stretch (`replaces an entry from <date>`).
 */
export interface MemoryMarks {
  /** The entries of the last reading, by id. */
  readonly seen: ReadonlyMap<string, BotMemoryEntry>;
  /** New entries, by id: the replaced entry's write time, `null` for none. */
  readonly added: ReadonlyMap<string, number | null>;
  /** Entries gone since, not yet paired with a new one. */
  readonly removed: ReadonlyArray<BotMemoryEntry>;
}

/** The marks of a pane that has read `entries` first: nothing new yet. */
export function initialMemoryMarks(
  entries: readonly BotMemoryEntry[],
): MemoryMarks {
  return {
    seen: new Map(entries.map((entry) => [entry.id, entry])),
    added: new Map(),
    removed: [],
  };
}

/**
 * The marks after the pane reads `entries`. An entry gone and an entry
 * written that share a tag pair up, in whichever order they arrive, as one
 * replacing the other: the bot changes a memory by removing it and writing
 * the new one.
 */
export function nextMemoryMarks(
  marks: MemoryMarks,
  entries: readonly BotMemoryEntry[],
): MemoryMarks {
  const current = new Map(entries.map((entry) => [entry.id, entry]));
  const added = new Map(marks.added);
  const removed = [...marks.removed];
  for (const [id, entry] of marks.seen) {
    if (current.has(id)) continue;
    added.delete(id);
    const unpaired = [...added].find(
      ([addedId, replaced]) =>
        replaced === null && sharesTag(current.get(addedId), entry),
    );
    if (unpaired === undefined) removed.push(entry);
    else added.set(unpaired[0], entry.at);
  }
  for (const entry of entries) {
    if (marks.seen.has(entry.id)) continue;
    const index = removed.findIndex((gone) => sharesTag(entry, gone));
    const replaced = index < 0 ? null : (removed.splice(index, 1)[0] ?? null);
    added.set(entry.id, replaced?.at ?? null);
  }
  return { seen: current, added, removed };
}

function sharesTag(
  entry: BotMemoryEntry | undefined,
  other: BotMemoryEntry,
): boolean {
  return (
    entry !== undefined && entry.tags.some((tag) => other.tags.includes(tag))
  );
}
