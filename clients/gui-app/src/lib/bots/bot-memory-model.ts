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

/** How full the tag is, from 0 to 1. */
export function fillOf(usage: BotMemoryTagUsage): number {
  return Math.min(1, usage.chars / usage.ceiling);
}

/**
 * How full the tag is, in words, from the share of its ceiling it uses:
 * "nearly empty", "less than half full", "about half full", "more than half
 * full", "nearly full", or "over its limit". `null` with nothing kept.
 */
export function fullnessOf(usage: BotMemoryTagUsage): string | null {
  if (usage.entries === 0) return null;
  const share = usage.chars / usage.ceiling;
  // Copy bands, not limits: they split the bar into the readings a person
  // tells apart at a glance, with "nearly full" left before the limit.
  if (share > 1) return "over its limit";
  if (share >= 0.9) return "nearly full";
  if (share > 0.6) return "more than half full";
  if (share >= 0.4) return "about half full";
  if (share >= 0.1) return "less than half full";
  return "nearly empty";
}

/**
 * What the pane has seen arrive while it was open: the entries written since
 * it first read the memory, marked `New`.
 */
export interface MemoryMarks {
  /** The ids of the last reading. */
  readonly seen: ReadonlySet<string>;
  /** The ids of the entries written since, still kept. */
  readonly added: ReadonlySet<string>;
}

/** The marks of a pane that has read `entries` first: nothing new yet. */
export function initialMemoryMarks(
  entries: readonly BotMemoryEntry[],
): MemoryMarks {
  return { seen: new Set(entries.map((entry) => entry.id)), added: new Set() };
}

/** The marks after the pane reads `entries`. */
export function nextMemoryMarks(
  marks: MemoryMarks,
  entries: readonly BotMemoryEntry[],
): MemoryMarks {
  const seen = new Set(entries.map((entry) => entry.id));
  const added = new Set(
    [...seen].filter((id) => marks.added.has(id) || !marks.seen.has(id)),
  );
  return { seen, added };
}
