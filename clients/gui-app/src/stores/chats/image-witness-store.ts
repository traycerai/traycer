import type { ImageResolutionEntry } from "@traycer/protocol/persistence/epic/messages";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";
import {
  retainedValueSize,
  type RetainedValueSize,
} from "@/stores/replica-memory/retained-value-size";

import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";

/**
 * # Witnessed image-resolution writes: the evidence rule 2 compares
 *
 * `blocksVersion` is blocks-only, so two copies of a settled record that
 * differ in `imageResolutions` tie on version and the comparison is
 * DIRECTIONLESS - "different" is not "newer". This store turns the client's
 * own observation of the host's write stream into direction: every
 * `image_resolution.updated` frame is recorded here in receipt order under a
 * store-local monotonic sequence, and two copies whose contents both appear
 * in that stream are ordered by where they appear.
 *
 * A witness is evidence about the SOURCE's write stream, not about the
 * client's holdings - it is recorded even when the client holds no copy of
 * the record (the rewrite is skipped, never the recording), which is exactly
 * what stamps a later first hydration correctly.
 *
 * ## Stamps are exact on apply, inferred on seat - and an inference must be
 * unique
 *
 * A copy rewritten in place by `rewriteWindowMessage` is stamped with the
 * applied witness's own sequence: exact. A copy arriving by serve is stamped
 * by CONTENT MATCH against the recorded occurrences - and a match is honest
 * only when it is unique. Content at two or more retained occurrences for a
 * source yields NO stamp: a flapping watcher can repeat content
 * (W1(X), W2(Y), W3(X)), and matching "the newest occurrence" would fabricate
 * "served is later" for a slice that predates the repeat - worse than
 * silence, because a fabricated verdict on one source breaks cross-source
 * dominance and suppresses a correct superset verdict elsewhere.
 *
 * ## The sequence counter is monotonic for the store's life and NEVER resets
 *
 * Invalidation and per-record resets clear ENTRIES only; a held stamp from a
 * cleared era can never yield a verdict on its own, because the verdict needs
 * the SERVED side too and that side matches against the occurrences - cleared
 * means no match, no match means silence. A restarting counter would let a
 * pre-invalidation stamp compare equal to a post-invalidation witness - a
 * fabricated cross-boundary verdict, the exact thing the lineage boundary
 * exists to prevent. The same counter also stamps
 * capture and reset moments, so "captured before or after the record's last
 * authoritative replacement" is a plain comparison (see
 * {@link ImageWitnessStore.lineageFloor}).
 *
 * ## Bounded globally, truncation observable
 *
 * The store is bounded as a whole (oldest occurrence evicted first), never as
 * a short per-source list - a 4-per-source bound flips verdicts silently at
 * the fifth write, and fails hardest exactly where write volume is highest.
 * Sized to comfortably outlive the interval a witness must survive: the
 * cross-lane skew window of the oldest outstanding bulk answer (in-flight
 * ranges x the writes a flapping watcher can emit meanwhile), with an order
 * of magnitude to spare. Truncation is recorded per source for observability
 * only - it distinguishes "silent because truncated" from "silent because
 * never witnessed" in diagnostics; it never routes around silence with a
 * guess.
 */
const MAX_WITNESS_OCCURRENCES = 512;
// Diagnostic-only history must not outgrow the bounded witness stream itself.
const MAX_TRUNCATED_SOURCE_KEYS = MAX_WITNESS_OCCURRENCES;

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
 * Content equality for one entry, `canonicalSource` excluded - that is the
 * entry's KEY, not its content. The one definition the witness match and the
 * differing-sources computation both read, so "same content" cannot drift
 * between recording and comparing.
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
   * Record one witnessed `image_resolution.updated` write. Returns the
   * sequence to stamp rewritten copies with. Called for EVERY frame - held,
   * unheld, live-arm or unreachable-row alike.
   */
  readonly record: (messageId: string, entry: ImageResolutionEntry) => number;
  /**
   * The served side's inferred stamp for one entry: its unique content match
   * among this record+source's retained occurrences. `null` when unwitnessed
   * OR ambiguous - both are "no evidence", per the doc above.
   */
  readonly servedStamp: (
    messageId: string,
    entry: ImageResolutionEntry,
  ) => number | null;
  /** The held copy's stamp for one source. 0 = no rule-2 evidence. */
  readonly heldStamp: (copy: OpenMessage, canonicalSource: string) => number;
  /**
   * Stamp every held copy of `messageId` in the window with an applied
   * witness's exact sequence - called after `rewriteWindowMessage`, which
   * rewrites the live copy and the record ledger's single span-referenced
   * copy alike.
   */
  readonly stampRewrittenCopies: (
    window: TranscriptWindow,
    messageId: string,
    canonicalSource: string,
    seq: number,
  ) => void;
  /**
   * Carry a copy's evidence across a client-local rewrite. The next object
   * DESCENDS from the previous one - same capture lineage, same per-source
   * stamps - so the evidence follows it; without the carry, every rewrite
   * (an image apply to a multi-image record, a streaming block delta, a
   * steer remap) would strand the other sources' stamps and the capture
   * moment on the discarded object, and rule 2's cross-source dominance
   * would be unreachable for any record with two or more differing sources.
   * Absent evidence carries as absent.
   */
  readonly carryRewrittenCopy: (
    previous: OpenMessage,
    next: OpenMessage,
  ) => void;
  /**
   * Seat-time stamping for a copy that just arrived by serve: per-source
   * unique content match (nothing on no match or an ambiguous one), plus the
   * capture moment for rule 3's lineage boundary. Idempotent per object - a
   * held substitute that survived the seat keeps the stamps it already
   * carries.
   */
  readonly stampSeatedCopy: (copy: OpenMessage) => void;
  /** The copy's capture moment; 0 for an object this store never saw seat. */
  readonly capturedAt: (copy: OpenMessage) => number;
  /**
   * Per-record reset on an authoritative snapshot serve: clears the record's
   * occurrences and moves its lineage floor. NOT called for `updated` index
   * entries (an image write's own `updated` must leave its witness standing)
   * and NOT at range seats (they stamp instead).
   */
  readonly resetServedRecord: (messageId: string) => void;
  /**
   * Superset evidence (rule 3) predating this moment is directionless: the
   * later of the record's last snapshot-served reset and the store-wide
   * rebuild invalidation.
   */
  readonly lineageFloor: (messageId: string) => number;
  /**
   * Rebuild authority invalidates ALL lineage evidence - entries cleared,
   * counter untouched. Safe only because the rebuild supersede guarantees no
   * pre-rebuild-framed answer ever seats afterward.
   */
  readonly invalidateAll: () => void;
  /** Sources whose oldest occurrences the global bound evicted. Diagnostics. */
  readonly truncatedSources: () => ReadonlySet<string>;
  /** Incremental charge for the private occurrence, reset, and diagnostic tables. */
  readonly retainedSize: () => RetainedValueSize;
  readonly setRetainedSizeListener: (
    listener: ((size: RetainedValueSize) => void) | null,
  ) => void;
}

export function createImageWitnessStore(): ImageWitnessStore {
  let seq = 0;
  /** Receipt order; oldest first, evicted first. */
  let occurrences: WitnessOccurrence[] = [];
  let occurrenceSizes: RetainedValueSize[] = [];
  const heldEvidence = new WeakMap<OpenMessage, HeldCopyEvidence>();
  const resetFloors = new Map<string, number>();
  let invalidationFloor = 0;
  const truncated = new Set<string>();
  let rawBytes = 0;
  let estimatedHeapBytes = 0;
  let retainedSizeListener: ((size: RetainedValueSize) => void) | null = null;
  const retainedSize = (): RetainedValueSize => ({
    rawBytes,
    estimatedHeapBytes,
  });
  const notifySize = (): void => retainedSizeListener?.(retainedSize());
  const adjustOccurrence = (
    size: RetainedValueSize,
    direction: 1 | -1,
  ): void => {
    rawBytes += direction * (size.rawBytes + 1);
    estimatedHeapBytes += direction * (size.estimatedHeapBytes + 16);
  };
  const adjustKey = (key: string, direction: 1 | -1): void => {
    const size = retainedValueSize(key);
    rawBytes += direction * (size.rawBytes + 1);
    estimatedHeapBytes += direction * (size.estimatedHeapBytes + 48);
  };

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

  const evidenceFor = (copy: OpenMessage): HeldCopyEvidence | undefined =>
    heldEvidence.get(copy);

  return {
    record: (messageId, entry) => {
      seq += 1;
      const occurrence = {
        key: occurrenceKey(messageId, entry.canonicalSource),
        seq,
        entry,
      };
      occurrences.push(occurrence);
      const occurrenceSize = retainedValueSize(occurrence);
      occurrenceSizes.push(occurrenceSize);
      adjustOccurrence(occurrenceSize, 1);
      if (occurrences.length > MAX_WITNESS_OCCURRENCES) {
        const evicted = occurrences.shift();
        const evictedSize = occurrenceSizes.shift();
        if (evictedSize !== undefined) adjustOccurrence(evictedSize, -1);
        if (evicted !== undefined) {
          // Refresh recency when one source truncates again. This set is only
          // diagnostic evidence; no matching or ordering decision reads it.
          if (truncated.delete(evicted.key)) adjustKey(evicted.key, -1);
          truncated.add(evicted.key);
          adjustKey(evicted.key, 1);
          if (truncated.size > MAX_TRUNCATED_SOURCE_KEYS) {
            const oldest = truncated.values().next();
            if (!oldest.done && truncated.delete(oldest.value)) {
              adjustKey(oldest.value, -1);
            }
          }
        }
      }
      notifySize();
      return seq;
    },
    servedStamp: (messageId, entry) =>
      uniqueMatch(occurrenceKey(messageId, entry.canonicalSource), entry),
    heldStamp: (copy, canonicalSource) =>
      evidenceFor(copy)?.stamps.get(canonicalSource) ?? 0,
    stampRewrittenCopies: (window, messageId, canonicalSource, applied) => {
      const stamp = (message: OpenMessage): void => {
        if (message.messageId !== messageId) return;
        const existing = heldEvidence.get(message);
        if (existing !== undefined) {
          existing.stamps.set(canonicalSource, applied);
          return;
        }
        heldEvidence.set(message, {
          stamps: new Map([[canonicalSource, applied]]),
          // A rewritten copy descends from a copy captured earlier; when that
          // ancestry was not carried (no witness store on the rewrite path,
          // or a copy this store never saw seat), the write itself is the
          // freshest capture fact available.
          capturedAt: applied,
        });
      };
      for (const message of window.liveMessages) stamp(message);
      // The ledger holds the ONE span-referenced copy, fresh and stale tiers
      // alike - the per-span walk this replaced visited the same record once
      // per holder.
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
      if (!resetFloors.has(messageId)) adjustKey(messageId, 1);
      resetFloors.set(messageId, seq);
      const prefix = `${messageId}\u0000`;
      const kept: WitnessOccurrence[] = [];
      const keptSizes: RetainedValueSize[] = [];
      occurrences.forEach((occurrence, index) => {
        const size = occurrenceSizes[index];
        if (occurrence.key.startsWith(prefix)) {
          adjustOccurrence(size, -1);
        } else {
          kept.push(occurrence);
          keptSizes.push(size);
        }
      });
      occurrences = kept;
      occurrenceSizes = keptSizes;
      notifySize();
    },
    lineageFloor: (messageId) =>
      Math.max(resetFloors.get(messageId) ?? 0, invalidationFloor),
    invalidateAll: () => {
      seq += 1;
      invalidationFloor = seq;
      for (const size of occurrenceSizes) adjustOccurrence(size, -1);
      for (const key of resetFloors.keys()) adjustKey(key, -1);
      occurrences = [];
      occurrenceSizes = [];
      resetFloors.clear();
      notifySize();
    },
    truncatedSources: () => truncated,
    retainedSize,
    setRetainedSizeListener: (listener) => {
      retainedSizeListener = listener;
    },
  };
}
