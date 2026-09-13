import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type {
  ImageResolutionEntry,
  Message,
} from "@traycer/protocol/persistence/epic/messages";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import type { TranscriptRowContext } from "@traycer/protocol/persistence/chat-transcript/row-context";

import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";
import {
  finishContentFingerprint,
  pushContentFingerprint,
  startContentFingerprint,
} from "@traycer/protocol/utils/text/digest";

/**
 * Everything the transcript measures or fingerprints by ENCODING it.
 *
 * A whole record is the common case, but the skeleton deliberately fingerprints
 * two FRAGMENTS of one separately - an assistant slice is charged the blocks it
 * actually renders rather than its turn's whole records, and a turn's
 * `imageResolutions` array is absorbed without the blocks beside it (see
 * `build-skeleton.ts` for both reasons). They are listed here rather than
 * encoded through a second definition of "these bytes": one function deciding
 * what an encoding is, is the whole point of this module.
 */
export type FingerprintedRecord =
  | Message
  | ChatEvent
  | ContentBlock
  | readonly ImageResolutionEntry[];

/**
 * The encoding every measurement of a record is taken over.
 *
 * Exported so a caller that needs the STRING - the skeleton's body fingerprint
 * absorbs it - can take the length from the same encoding rather than
 * stringifying a second time, and, more importantly, rather than re-declaring
 * what "a record's bytes" means. Two definitions that agree by inspection is
 * the drift this module exists to prevent.
 */
export function encodeRecord(record: FingerprintedRecord): string {
  return JSON.stringify(record);
}

/**
 * What this record costs to ship: the byte length of its JSON encoding, which
 * is what a hydration response actually carries.
 *
 * Used for two different jobs, and they want the same number: the skeleton's
 * scroll-height hint, and the range reader's byte budget. Deriving them from
 * one function is what keeps a budget from being spent in units the hint did
 * not measure.
 *
 * The unmemoized answer, for a caller that holds no memo. A caller that does
 * wants {@link RecordFingerprintMemo.lookup}, whose `byteLength` is this number
 * computed from the same encoding as the digest beside it.
 */
export function recordByteLength(record: Message | ChatEvent): number {
  return utf8ByteLength(encodeRecord(record));
}

/**
 * Both answers a record is ever asked for, from ONE encoding pass.
 *
 * `byteLength` is exactly {@link recordByteLength}, and `digest` is a
 * fixed-width fingerprint of the same string. They travel together because the
 * encoding is the expensive part and the two callers - the skeleton's body
 * fingerprint and the range reader's byte budget - would otherwise stringify
 * the same record twice to produce two views of one string.
 *
 * The STRING is deliberately not carried. Retaining it for every record of a
 * live chat would be the transcript held in memory a second time, which is the
 * cost this whole path exists to remove.
 */
export interface RecordFingerprint {
  readonly digest: string;
  readonly byteLength: number;
}

/**
 * One record's fingerprint, computed from one {@link encodeRecord}.
 *
 * Fixed width by construction (see `finishContentFingerprint`), which is what
 * lets a row's digest COMBINE these rather than re-absorb the bytes they were
 * taken from - the difference between a row that costs its own size to
 * fingerprint and one that costs the number of records in it.
 */
export function fingerprintRecord(
  record: FingerprintedRecord,
): RecordFingerprint {
  const encoded = encodeRecord(record);
  const state = startContentFingerprint();
  pushContentFingerprint(state, encoded);
  return {
    digest: finishContentFingerprint(state),
    byteLength: utf8ByteLength(encoded),
  };
}

/**
 * Per-record fingerprints, remembered for as long as the record object lives.
 *
 * ## Why the RECORD is the key, and not the row
 *
 * Rows and records are many-to-many (`row-skeleton.ts`, "No record identity"):
 * one turn's records produce several rows, and one row folds several records.
 * A memo keyed on a row id would therefore miss whenever a row's record set
 * changed, and would need its own invalidation to be correct when it did not.
 *
 * Keyed on the record OBJECT it needs no invalidation at all. The producer's
 * fold is copy-on-write, so an unchanged record is the identical object on the
 * next rebuild and a changed one is a new object that was never in the map.
 * There is no state that can be stale: a wrong answer would require the same
 * object to encode differently, and these records are treated as frozen
 * everywhere that holds them.
 *
 * A `WeakMap`, so a record dropped by a prune or a compaction rewrite takes its
 * entry with it. The memo is a cache with no eviction policy of its own
 * precisely because it does not need one.
 *
 * ## Lifetime
 *
 * One per chat session, owned by whatever holds the projection it feeds - the
 * live host's transcript view cache. A producer that rebuilds ONCE per input
 * (the publisher writing a head's index section) has nothing to remember across
 * and passes `null` instead of allocating a map it will read empty.
 */
export class RecordFingerprintMemo {
  private readonly fingerprints = new WeakMap<
    FingerprintedRecord,
    RecordFingerprint
  >();

  /**
   * Row CONTEXT digests, in their own lane.
   *
   * A separate map because a context is not a record and is not fingerprinted
   * like one: `build-skeleton.ts` digests it field by field in a fixed order
   * rather than by encoding the object, so that two independent projection runs
   * that agree about a row agree about its digest whatever order their literals
   * built the keys in. What is shared with the lane above is only the KEYING
   * rule - identity, no invalidation - and the lifetime.
   */
  private readonly contexts = new WeakMap<TranscriptRowContext, string>();

  /** This record's fingerprint, computing it on the first ask. */
  lookup(record: FingerprintedRecord): RecordFingerprint {
    const remembered = this.fingerprints.get(record);
    if (remembered !== undefined) return remembered;
    const computed = fingerprintRecord(record);
    this.fingerprints.set(record, computed);
    return computed;
  }

  /**
   * This context's digest, computing it on the first ask.
   *
   * Takes the derivation as a parameter rather than importing it, because the
   * derivation is `build-skeleton.ts`'s - it carries a compile-time drift guard
   * against `transcriptRowContextSchema`, and that guard belongs beside the
   * skeleton the context is fingerprinted INTO, not in the module that only
   * remembers the answer.
   */
  lookupContext(
    context: TranscriptRowContext,
    compute: (context: TranscriptRowContext) => string,
  ): string {
    const remembered = this.contexts.get(context);
    if (remembered !== undefined) return remembered;
    const computed = compute(context);
    this.contexts.set(context, computed);
    return computed;
  }
}
