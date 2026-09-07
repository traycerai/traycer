import type {
  ImageResolutionEntry,
  Message,
} from "@traycer/protocol/persistence/epic/messages";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";

/**
 * blocksVersion is blocks-only, so imageResolutions need this write-stream order.
 * Sequence never resets; a content match must be unique or there is no stamp.
 */
const MAX_WITNESS_OCCURRENCES = 512;

interface WitnessOccurrence {
  readonly key: string;
  readonly seq: number;
  readonly entry: ImageResolutionEntry;
}

/** Client-local, per-copy metadata - stamps follow the OBJECT, not the id. */
interface HeldCopyEvidence {
  /** Applied/inferred witness sequence per `canonicalSource`. 0 = none. */
  readonly stamps: Map<string, number>;
  /** Where in the store's event order this copy was captured (seated). */
  readonly capturedAt: number;
}

function occurrenceKey(messageId: string, canonicalSource: string): string {
  return `${messageId}\u0000${canonicalSource}`;
}

/**
 * Content equality for one entry, `canonicalSource` excluded - that is the entry's KEY, not its
 * content.
 */
export function imageResolutionEntriesEqual(
  left: ImageResolutionEntry,
  right: ImageResolutionEntry,
): boolean {
  return (
    left.state === right.state &&
    left.attachmentHash === right.attachmentHash &&
    left.mediaType === right.mediaType &&
    left.width === right.width &&
    left.height === right.height &&
    left.source === right.source
  );
}

export interface ImageWitnessStore {
  /**
   * Record one witnessed `image_resolution.updated` write. Returns the sequence to stamp rewritten
   * copies with.
   */
  readonly record: (messageId: string, entry: ImageResolutionEntry) => number;
  /**
   * The served side's inferred stamp for one entry: its unique content match among this
   * record+source's retained occurrences.
   */
  readonly servedStamp: (
    messageId: string,
    entry: ImageResolutionEntry,
  ) => number | null;
  /** The held copy's stamp for one source. 0 = no rule-2 evidence. */
  readonly heldStamp: (copy: Message, canonicalSource: string) => number;
  /**
   * Stamp every held copy of `messageId` in the window with an applied witness's exact sequence -
   * called after `rewriteWindowMessage`, which rewrites the live copy and the record ledger's single
   */
  readonly stampRewrittenCopies: (
    window: TranscriptWindow,
    messageId: string,
    canonicalSource: string,
    seq: number,
  ) => void;
  /** Carry a copy's evidence across a client-local rewrite. */
  readonly carryRewrittenCopy: (previous: Message, next: Message) => void;
  /**
   * Seat-time stamping for a copy that just arrived by serve: per-source unique content match
   * (nothing on no match or an ambiguous one), plus the capture moment for rule 3's lineage
   */
  readonly stampSeatedCopy: (copy: Message) => void;
  /** The copy's capture moment; 0 for an object this store never saw seat. */
  readonly capturedAt: (copy: Message) => number;
  /**
   * Per-record reset on an authoritative snapshot serve: clears the record's occurrences and moves
   * its lineage floor.
   */
  readonly resetServedRecord: (messageId: string) => void;
  /**
   * Superset evidence (rule 3) predating this moment is directionless: the later of the record's
   * last snapshot-served reset and the store-wide rebuild invalidation.
   */
  readonly lineageFloor: (messageId: string) => number;
  /**
   * Rebuild authority invalidates ALL lineage evidence - entries cleared, counter untouched. Safe
   * only because the rebuild supersede guarantees no pre-rebuild-framed answer ever seats afterward.
   */
  readonly invalidateAll: () => void;
  /** Sources whose oldest occurrences the global bound evicted. Diagnostics. */
  readonly truncatedSources: () => ReadonlySet<string>;
}

export function createImageWitnessStore(): ImageWitnessStore {
  let seq = 0;
  /** Receipt order; oldest first, evicted first. */
  let occurrences: WitnessOccurrence[] = [];
  const heldEvidence = new WeakMap<Message, HeldCopyEvidence>();
  const resetFloors = new Map<string, number>();
  let invalidationFloor = 0;
  const truncated = new Set<string>();

  const occurrencesFor = (key: string): WitnessOccurrence[] =>
    occurrences.filter((occurrence) => occurrence.key === key);

  const uniqueMatch = (
    key: string,
    entry: ImageResolutionEntry,
  ): number | null => {
    let match: number | null = null;
    for (const occurrence of occurrencesFor(key)) {
      if (!imageResolutionEntriesEqual(occurrence.entry, entry)) continue;
      if (match !== null) return null;
      match = occurrence.seq;
    }
    return match;
  };

  const evidenceFor = (copy: Message): HeldCopyEvidence | undefined =>
    heldEvidence.get(copy);

  return {
    record: (messageId, entry) => {
      seq += 1;
      occurrences.push({
        key: occurrenceKey(messageId, entry.canonicalSource),
        seq,
        entry,
      });
      if (occurrences.length > MAX_WITNESS_OCCURRENCES) {
        const evicted = occurrences.shift();
        if (evicted !== undefined) {
          truncated.add(evicted.key);
        }
      }
      return seq;
    },
    servedStamp: (messageId, entry) =>
      uniqueMatch(occurrenceKey(messageId, entry.canonicalSource), entry),
    heldStamp: (copy, canonicalSource) =>
      evidenceFor(copy)?.stamps.get(canonicalSource) ?? 0,
    stampRewrittenCopies: (window, messageId, canonicalSource, applied) => {
      const stamp = (message: Message): void => {
        if (message.messageId !== messageId) return;
        const existing = heldEvidence.get(message);
        if (existing !== undefined) {
          existing.stamps.set(canonicalSource, applied);
          return;
        }
        heldEvidence.set(message, {
          stamps: new Map([[canonicalSource, applied]]),
          capturedAt: applied,
        });
      };
      for (const message of window.liveMessages) stamp(message);
      // The ledger holds the ONE span-referenced copy, fresh and stale tiers alike - the per-span walk
      // this replaced visited the same record once per holder.
      const entry = window.records.messages.get(messageId);
      if (entry !== undefined) stamp(entry.record);
    },
    carryRewrittenCopy: (previous, next) => {
      if (previous === next) return;
      const evidence = heldEvidence.get(previous);
      if (evidence === undefined) return;
      // A COPY of the stamps, not an alias: the discarded object can still be
      // read transiently, and the two must not share mutation from here on.
      heldEvidence.set(next, {
        stamps: new Map(evidence.stamps),
        capturedAt: evidence.capturedAt,
      });
    },
    stampSeatedCopy: (copy) => {
      if (heldEvidence.has(copy)) return;
      if (copy.role !== "assistant") return;
      seq += 1;
      const stamps = new Map<string, number>();
      for (const entry of copy.imageResolutions) {
        const match = uniqueMatch(
          occurrenceKey(copy.messageId, entry.canonicalSource),
          entry,
        );
        if (match !== null) stamps.set(entry.canonicalSource, match);
      }
      heldEvidence.set(copy, { stamps, capturedAt: seq });
    },
    capturedAt: (copy) => evidenceFor(copy)?.capturedAt ?? 0,
    resetServedRecord: (messageId) => {
      seq += 1;
      resetFloors.set(messageId, seq);
      const prefix = `${messageId}\u0000`;
      occurrences = occurrences.filter(
        (occurrence) => !occurrence.key.startsWith(prefix),
      );
    },
    lineageFloor: (messageId) =>
      Math.max(resetFloors.get(messageId) ?? 0, invalidationFloor),
    invalidateAll: () => {
      seq += 1;
      invalidationFloor = seq;
      occurrences = [];
      resetFloors.clear();
    },
    truncatedSources: () => truncated,
  };
}
