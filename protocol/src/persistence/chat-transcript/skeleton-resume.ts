import { z } from "zod";

import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import {
  finishContentFingerprint,
  pushContentFingerprint,
  startContentFingerprint,
} from "@traycer/protocol/utils/text/digest";

/**
 * # Skeleton resume
 *
 * A windowed `chat.subscribe` bootstrap streams the chat's whole row skeleton,
 * which is ~1 MB for a 6-7k row chat. A client that re-subscribes to a chat it
 * already holds - a reconnect after the app was backgrounded, a switch back to
 * a chat whose socket was closed - already has every row of that skeleton but
 * the few the chat grew by. This module lets it say so.
 *
 * The client describes the skeleton it holds as one digest per
 * {@link SKELETON_RESUME_BLOCK_SIZE}-row block from ordinal 0, and sends that
 * on the open request (a few hundred bytes). The host reads its own skeleton
 * in order as it would to stream it, compares block by block, and withholds
 * every leading block whose digest matches. The stream then starts at the
 * first block that differs - or at the partial block past the last one the
 * client described - and its first chunk names how many rows the client is to
 * keep (`retainedRows` on the `skeletonChunk` frame).
 *
 * ## Why the digests are comparable across connections
 *
 * `row-skeleton.ts` says a `bodyDigest` "is only ever compared against the
 * previous value for the same ordinal on the same connection". A resume claim
 * compares one connection's entries against another's, and the rule is relaxed
 * here deliberately. It holds for two reasons:
 *
 * - **Every digest here is content-derived.** A block digest is computed over
 *   every field of every entry (`canonicalEntry` below, with a compile-time
 *   guard against a field it forgets), and an entry's fields are themselves
 *   derived from the rows' content, not from connection or session state. Two
 *   connections serving the same content produce the same digests.
 * - **Every way the two sides can disagree fails safe.** A digest that differs
 *   from the host's costs the blocks from there on being streamed, which is
 *   exactly what happens without a claim. When the host changes how it derives
 *   `bodyDigest` (it did on 10 September 2026), every block the client
 *   describes stops matching and the resume degrades to a full stream. When
 *   this module changes how it derives a BLOCK digest, it bumps
 *   {@link SKELETON_RESUME_DERIVATION} and a host on another derivation ignores
 *   the claim. A published copy disagreeing with the live host does the same.
 *
 * The one unsafe outcome is two different blocks producing the same digest, so
 * the client keeps an entry the host has since changed. That is the same
 * failure a colliding `bodyDigest` already has on one connection - the client
 * keeps a body it should have dropped - and it rests on the same two-lane
 * fingerprint (`utils/text/digest.ts`). Nothing here trusts a digest more than
 * the same-connection comparison already does.
 *
 * ## What a resumed stream does not change
 *
 * Withholding an entry whose content equals what the client holds is
 * equivalent to sending it, and nothing else about the stream moves: the host
 * compares the entries it would have sent at the moment it would have sent
 * them, so every revision logged after the stream started still goes out after
 * its final chunk, exactly as for a full stream.
 */

/**
 * The block digest's derivation. Bump it whenever {@link skeletonResumeBlockDigest}
 * would produce a different value for the same entries - a field added, the
 * encoding changed - so a peer on the other derivation ignores the claim
 * rather than comparing numbers that cannot match.
 */
export const SKELETON_RESUME_DERIVATION = 1;

/**
 * Rows per digest. Large enough that a 20k-row chat's claim is ~80 digests
 * (about 1 KB on the open request), small enough that the rows past the last
 * matching block - the ones the client never described, plus a block that
 * changed - are a small fraction of a skeleton.
 */
export const SKELETON_RESUME_BLOCK_SIZE = 256;

/**
 * The most blocks one claim may describe: 262k rows. A claim over a longer
 * skeleton describes its first {@link SKELETON_RESUME_MAX_BLOCKS} blocks and
 * lets the rest stream.
 */
export const SKELETON_RESUME_MAX_BLOCKS = 1024;

/**
 * The open request's resume claim.
 *
 * `derivation` and `blockSize` are plain numbers rather than literals so a
 * claim from a later client still parses on this host; {@link acceptsSkeletonResume}
 * is what decides whether this host can compare it.
 */
export const chatSkeletonResumeSchema = lazySchema(() =>
  z.object({
    derivation: z.number().int().positive(),
    blockSize: z.number().int().positive(),
    /**
     * One digest per block, from ordinal 0, of the skeleton the client holds.
     * Only whole blocks: a partial last block is the likeliest to change, and
     * it costs at most one block of stream to leave out.
     */
    blockDigests: z
      .array(z.string().min(1).max(32))
      .max(SKELETON_RESUME_MAX_BLOCKS),
  }),
);
export type ChatSkeletonResume = z.infer<typeof chatSkeletonResumeSchema>;

/** Whether this side derives digests the way the claim was derived. */
export function acceptsSkeletonResume(claim: ChatSkeletonResume): boolean {
  return (
    claim.derivation === SKELETON_RESUME_DERIVATION &&
    claim.blockSize === SKELETON_RESUME_BLOCK_SIZE &&
    claim.blockDigests.length > 0
  );
}

/**
 * Every field of a usage record, in a fixed order.
 *
 * The mapped type is the drift guard: a field added to `tokenUsageSchema` and
 * not listed here fails to compile, where a hand-written key list would stop
 * digesting it silently - and an unhashed field is one whose change a matching
 * block would hide. Absent folds to `null`, which no present value encodes as.
 */
function canonicalUsage(usage: TokenUsage): readonly unknown[] {
  const fields: { readonly [K in keyof Required<TokenUsage>]: unknown } = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? null,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
    contextTokens: usage.contextTokens ?? null,
    contextWindow: usage.contextWindow ?? null,
    contextBaselineTokens: usage.contextBaselineTokens ?? null,
    costUsd: usage.costUsd ?? null,
  };
  return Object.values(fields);
}

/**
 * One entry as the digest sees it: every field, in a fixed order, and nothing
 * that depends on how the object was built. A field-list rather than a
 * stringify of the object, because the host hashes entries it constructed and
 * the client hashes entries zod parsed, and the two need not agree on key
 * order. Same compile-time guard as {@link canonicalUsage}.
 */
function canonicalEntry(entry: RowSkeletonEntry): string {
  const fields: { readonly [K in keyof Required<RowSkeletonEntry>]: unknown } =
    {
      rowId: entry.rowId,
      createdAt: entry.createdAt,
      role: entry.role,
      byteLength: entry.byteLength,
      bodyDigest: entry.bodyDigest,
      preview: entry.preview ?? null,
      sentByAgent: entry.sentByAgent ?? null,
      usage: entry.usage === undefined ? null : canonicalUsage(entry.usage),
    };
  return JSON.stringify(Object.values(fields));
}

/**
 * The digest of one block of entries, in ordinal order.
 *
 * Each entry encodes as a JSON array, which delimits itself, so concatenating
 * them cannot make two different blocks encode alike.
 */
export function skeletonResumeBlockDigest(
  entries: readonly RowSkeletonEntry[],
): string {
  const state = startContentFingerprint();
  for (const entry of entries) {
    pushContentFingerprint(state, canonicalEntry(entry));
  }
  return finishContentFingerprint(state);
}

/** A claim, and the entries it describes, which the client keeps to expand the answer. */
export type SkeletonResumeOffer = {
  readonly claim: ChatSkeletonResume;
  /** Exactly `claim.blockDigests.length * claim.blockSize` entries, from ordinal 0. */
  readonly entries: readonly RowSkeletonEntry[];
};

/**
 * Describe the whole blocks of a skeleton from ordinal 0, or `null` when there
 * is not one whole block to describe.
 *
 * Stops at the first hole: a hole is a row the client does not hold, so the
 * block containing it is not the client's to describe.
 */
export function buildSkeletonResumeOffer(
  skeleton: readonly (RowSkeletonEntry | undefined)[],
  rowCount: number,
): SkeletonResumeOffer | null {
  const blockSize = SKELETON_RESUME_BLOCK_SIZE;
  const wholeBlocks = Math.min(
    Math.floor(Math.min(rowCount, skeleton.length) / blockSize),
    SKELETON_RESUME_MAX_BLOCKS,
  );
  const entries: RowSkeletonEntry[] = [];
  const blockDigests: string[] = [];
  for (let block = 0; block < wholeBlocks; block += 1) {
    const start = block * blockSize;
    const blockEntries: RowSkeletonEntry[] = [];
    for (let ordinal = start; ordinal < start + blockSize; ordinal += 1) {
      const entry = skeleton[ordinal];
      if (entry === undefined) break;
      blockEntries.push(entry);
    }
    if (blockEntries.length < blockSize) break;
    blockDigests.push(skeletonResumeBlockDigest(blockEntries));
    for (const entry of blockEntries) entries.push(entry);
  }
  if (blockDigests.length === 0) return null;
  return {
    claim: {
      derivation: SKELETON_RESUME_DERIVATION,
      blockSize,
      blockDigests,
    },
    entries,
  };
}

/**
 * Where a resumed stream settled: the client keeps its first `retainedRows`
 * rows, and the stream sends `entries` from ordinal `retainedRows` on.
 */
export type SkeletonResumeSettlement = {
  readonly retainedRows: number;
  readonly entries: readonly RowSkeletonEntry[];
};

/**
 * Compares a skeleton against a claim as the skeleton is read, in order, one
 * slice at a time - so the host never holds more of it than one block past what
 * it has already verified.
 *
 * {@link push} withholds entries while every whole block so far matches, and
 * settles at the first block that differs, once the claim runs out, or at the
 * end of the skeleton. After it settles, the caller streams the rest itself and
 * the matcher is spent.
 */
export class SkeletonResumeMatcher {
  private matchedBlocks = 0;
  private readonly pending: RowSkeletonEntry[] = [];
  private settled = false;

  constructor(private readonly claim: ChatSkeletonResume) {}

  /**
   * Feed the next entries of the skeleton, in ordinal order, starting at 0.
   *
   * `null` while every entry pushed so far is still withheld; otherwise the
   * settlement, returned once.
   */
  push(
    entries: readonly RowSkeletonEntry[],
    reachedEnd: boolean,
  ): SkeletonResumeSettlement | null {
    if (this.settled) {
      throw new Error("SkeletonResumeMatcher: push after settling");
    }
    // A loop rather than a spread: a slice can be thousands of entries, and a
    // spread passes each one as an argument.
    for (const entry of entries) this.pending.push(entry);
    const blockSize = this.claim.blockSize;
    let consumed = 0;
    let differed = false;
    while (
      this.pending.length - consumed >= blockSize &&
      this.matchedBlocks < this.claim.blockDigests.length
    ) {
      const block = this.pending.slice(consumed, consumed + blockSize);
      if (
        skeletonResumeBlockDigest(block) !==
        this.claim.blockDigests[this.matchedBlocks]
      ) {
        differed = true;
        break;
      }
      this.matchedBlocks += 1;
      consumed += blockSize;
    }
    this.pending.splice(0, consumed);
    const claimSpent = this.matchedBlocks === this.claim.blockDigests.length;
    if (!differed && !claimSpent && !reachedEnd) return null;
    this.settled = true;
    return {
      retainedRows: this.matchedBlocks * blockSize,
      entries: this.pending.splice(0),
    };
  }
}
