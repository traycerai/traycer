import { describe, expect, it } from "vitest";
import {
  rowSkeletonEntrySchema,
  type RowSkeletonEntry,
} from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  SKELETON_RESUME_BLOCK_SIZE,
  SKELETON_RESUME_DERIVATION,
  SKELETON_RESUME_MAX_BLOCKS,
  SkeletonResumeMatcher,
  acceptsSkeletonResume,
  buildSkeletonResumeOffer,
  chatSkeletonResumeSchema,
  skeletonResumeBlockDigest,
  type ChatSkeletonResume,
  type SkeletonResumeSettlement,
} from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";
import {
  tokenUsageSchema,
  type TokenUsage,
} from "@traycer/protocol/persistence/epic/foundation";

const BLOCK = SKELETON_RESUME_BLOCK_SIZE;

function entry(ordinal: number, digest: string): RowSkeletonEntry {
  return ordinal % 2 === 0
    ? {
        rowId: `user-${ordinal}`,
        createdAt: 1_000 + ordinal,
        role: "user",
        byteLength: 40 + ordinal,
        bodyDigest: digest,
        preview: `message ${ordinal}`,
      }
    : {
        rowId: `assistant-${ordinal}`,
        createdAt: 1_000 + ordinal,
        role: "assistant",
        byteLength: 900 + ordinal,
        bodyDigest: digest,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
}

function skeleton(rowCount: number): RowSkeletonEntry[] {
  return Array.from({ length: rowCount }, (_, ordinal) =>
    entry(ordinal, `d${ordinal}`),
  );
}

function claimFor(entries: readonly RowSkeletonEntry[]): ChatSkeletonResume {
  const offer = buildSkeletonResumeOffer(entries, entries.length);
  if (offer === null) throw new Error("expected an offer");
  return offer.claim;
}

/** Feed the host's skeleton to a matcher in slices, as the host reads it. */
function feed(
  claim: ChatSkeletonResume,
  hostSkeleton: readonly RowSkeletonEntry[],
  sliceSize: number,
): { settlement: SkeletonResumeSettlement; readThrough: number } {
  const matcher = new SkeletonResumeMatcher(claim);
  for (let from = 0; from < hostSkeleton.length; from += sliceSize) {
    const slice = hostSkeleton.slice(from, from + sliceSize);
    const reachedEnd = from + slice.length >= hostSkeleton.length;
    const settlement = matcher.push(slice, reachedEnd);
    if (settlement !== null) {
      return { settlement, readThrough: from + slice.length };
    }
  }
  throw new Error("the matcher never settled");
}

describe("buildSkeletonResumeOffer", () => {
  it("describes whole blocks only, and keeps the entries it describes", () => {
    const held = skeleton(3 * BLOCK + 17);
    const offer = buildSkeletonResumeOffer(held, held.length);
    expect(offer?.claim).toEqual({
      derivation: SKELETON_RESUME_DERIVATION,
      blockSize: BLOCK,
      blockDigests: [
        skeletonResumeBlockDigest(held.slice(0, BLOCK)),
        skeletonResumeBlockDigest(held.slice(BLOCK, 2 * BLOCK)),
        skeletonResumeBlockDigest(held.slice(2 * BLOCK, 3 * BLOCK)),
      ],
    });
    expect(offer?.entries).toEqual(held.slice(0, 3 * BLOCK));
    expect(chatSkeletonResumeSchema.parse(offer?.claim)).toEqual(offer?.claim);
  });

  it("stops at the first hole - a row the client does not hold is not its to describe", () => {
    const held: (RowSkeletonEntry | undefined)[] = skeleton(3 * BLOCK);
    held[BLOCK + 5] = undefined;
    const offer = buildSkeletonResumeOffer(held, held.length);
    expect(offer?.claim.blockDigests).toHaveLength(1);
    expect(offer?.entries).toHaveLength(BLOCK);
  });

  it("offers nothing below one whole block, or past the row count", () => {
    expect(buildSkeletonResumeOffer(skeleton(BLOCK - 1), BLOCK - 1)).toBe(null);
    // Entries past `rowCount` are leftovers the window has not bounded yet.
    expect(buildSkeletonResumeOffer(skeleton(2 * BLOCK), BLOCK - 1)).toBe(null);
  });

  it("caps the claim at SKELETON_RESUME_MAX_BLOCKS", () => {
    const rows = (SKELETON_RESUME_MAX_BLOCKS + 2) * BLOCK;
    const offer = buildSkeletonResumeOffer(skeleton(rows), rows);
    expect(offer?.claim.blockDigests).toHaveLength(SKELETON_RESUME_MAX_BLOCKS);
    expect(chatSkeletonResumeSchema.safeParse(offer?.claim).success).toBe(true);
  });
});

describe("SkeletonResumeMatcher", () => {
  it("withholds every described block when the host grew by a few rows, whatever the slice size", () => {
    const held = skeleton(4 * BLOCK + 30);
    const host = skeleton(4 * BLOCK + 95);
    for (const sliceSize of [1, 100, BLOCK, 700, host.length]) {
      const { settlement, readThrough } = feed(claimFor(held), host, sliceSize);
      expect(settlement.retainedRows).toBe(4 * BLOCK);
      // Everything read past the retained prefix goes out, in order; the
      // caller streams whatever it has not read yet itself.
      expect(settlement.entries).toEqual(
        host.slice(4 * BLOCK, Math.max(readThrough, 4 * BLOCK)),
      );
    }
  });

  it("streams from the first block that differs", () => {
    const held = skeleton(5 * BLOCK);
    const host = skeleton(5 * BLOCK);
    // An in-place update in block 2: a finished streaming row, say.
    host[2 * BLOCK + 9] = entry(2 * BLOCK + 9, "rewritten");
    const { settlement, readThrough } = feed(claimFor(held), host, 300);
    expect(settlement.retainedRows).toBe(2 * BLOCK);
    expect(settlement.entries).toEqual(host.slice(2 * BLOCK, readThrough));
  });

  it("retains nothing when the first block already differs", () => {
    const held = skeleton(2 * BLOCK);
    const host = skeleton(2 * BLOCK);
    host[0] = entry(0, "other");
    const { settlement, readThrough } = feed(claimFor(held), host, 64);
    expect(settlement.retainedRows).toBe(0);
    expect(settlement.entries).toEqual(host.slice(0, readThrough));
  });

  it("settles at the end of a host skeleton shorter than the claim", () => {
    const held = skeleton(4 * BLOCK);
    const host = skeleton(2 * BLOCK + 40);
    const { settlement } = feed(claimFor(held), host, 100);
    expect(settlement.retainedRows).toBe(2 * BLOCK);
    expect(settlement.entries).toEqual(host.slice(2 * BLOCK));
  });

  it("settles with nothing to send when the host holds exactly the described rows", () => {
    const held = skeleton(3 * BLOCK);
    const { settlement } = feed(claimFor(held), skeleton(3 * BLOCK), BLOCK);
    expect(settlement).toEqual({ retainedRows: 3 * BLOCK, entries: [] });
  });

  it("refuses a push after settling", () => {
    const matcher = new SkeletonResumeMatcher(claimFor(skeleton(BLOCK)));
    expect(matcher.push(skeleton(BLOCK), true)).not.toBe(null);
    expect(() => matcher.push([], true)).toThrow();
  });
});

/**
 * The resume compares one connection's digests against another's, which
 * `row-skeleton.ts` otherwise rules out ("only ever compared ... on the same
 * connection"). These pin the two properties `skeleton-resume.ts` argues make
 * that sound: equal content digests equal across sources, and every way the
 * sources can disagree fails SAFE - toward streaming, never toward keeping.
 */
describe("cross-connection digests fail safe", () => {
  it("hashes the host's constructed entries and the client's parsed copies alike", () => {
    const host: RowSkeletonEntry[] = [
      {
        usage: {
          costUsd: 0.25,
          totalTokens: 30,
          outputTokens: 20,
          inputTokens: 10,
        },
        bodyDigest: "b1",
        byteLength: 12,
        role: "assistant",
        createdAt: 5,
        rowId: "assistant-1",
      },
      ...skeleton(BLOCK - 1),
    ];
    // What the client holds: the same entries after the wire and zod, with
    // the schema's key order rather than the host's.
    const client = host.map((value) =>
      rowSkeletonEntrySchema.parse(JSON.parse(JSON.stringify(value))),
    );
    expect(Object.keys(client[0])).not.toEqual(Object.keys(host[0]));
    expect(skeletonResumeBlockDigest(client)).toBe(
      skeletonResumeBlockDigest(host),
    );
  });

  it("a host that derives bodyDigest differently matches no block, and streams everything", () => {
    const held = skeleton(3 * BLOCK);
    // The same rows, the same order, a new digest derivation.
    const host = held.map((value) => ({
      ...value,
      bodyDigest: `v2-${value.bodyDigest}`,
    }));
    const { settlement } = feed(claimFor(held), host, 200);
    expect(settlement.retainedRows).toBe(0);
  });

  it("every field of an entry, and of its usage, moves the block digest", () => {
    const full: RowSkeletonEntry = {
      rowId: "row",
      createdAt: 1,
      role: "assistant",
      byteLength: 2,
      bodyDigest: "digest",
      preview: "preview",
      sentByAgent: true,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 5,
        contextTokens: 6,
        contextWindow: 7,
        contextBaselineTokens: 8,
        costUsd: 9,
      },
    };
    const usage = full.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    const base = skeletonResumeBlockDigest([full]);
    // One variant per field, keyed so a field missing from this table fails to
    // compile, and checked against the SCHEMAS at runtime - so a field added to
    // either and not digested fails here. The compile-time guard in
    // `canonicalEntry` is the first line of defense; this is the second, and
    // checks that each field actually moves the digest.
    const entryVariants: {
      readonly [K in keyof Required<RowSkeletonEntry>]: RowSkeletonEntry;
    } = {
      rowId: { ...full, rowId: "other" },
      createdAt: { ...full, createdAt: 2 },
      role: { ...full, role: "user" },
      byteLength: { ...full, byteLength: 3 },
      bodyDigest: { ...full, bodyDigest: "other" },
      preview: { ...full, preview: undefined },
      sentByAgent: { ...full, sentByAgent: undefined },
      usage: { ...full, usage: undefined },
    };
    const usageVariants: {
      readonly [K in keyof Required<TokenUsage>]: TokenUsage;
    } = {
      inputTokens: { ...usage, inputTokens: 99 },
      outputTokens: { ...usage, outputTokens: 99 },
      totalTokens: { ...usage, totalTokens: 99 },
      cacheReadInputTokens: { ...usage, cacheReadInputTokens: undefined },
      cacheCreationInputTokens: {
        ...usage,
        cacheCreationInputTokens: undefined,
      },
      contextTokens: { ...usage, contextTokens: undefined },
      contextWindow: { ...usage, contextWindow: undefined },
      contextBaselineTokens: { ...usage, contextBaselineTokens: undefined },
      costUsd: { ...usage, costUsd: undefined },
    };
    expect(Object.keys(rowSkeletonEntrySchema.shape).sort()).toEqual(
      Object.keys(entryVariants).sort(),
    );
    expect(Object.keys(tokenUsageSchema.shape).sort()).toEqual(
      Object.keys(usageVariants).sort(),
    );
    for (const [key, changed] of Object.entries(entryVariants)) {
      expect(skeletonResumeBlockDigest([changed]), key).not.toBe(base);
    }
    for (const [key, changedUsage] of Object.entries(usageVariants)) {
      expect(
        skeletonResumeBlockDigest([{ ...full, usage: changedUsage }]),
        key,
      ).not.toBe(base);
    }
  });

  it("a host on another derivation, or another block size, ignores the claim", () => {
    const claim = claimFor(skeleton(BLOCK));
    expect(acceptsSkeletonResume(claim)).toBe(true);
    expect(
      acceptsSkeletonResume({
        ...claim,
        derivation: SKELETON_RESUME_DERIVATION + 1,
      }),
    ).toBe(false);
    expect(acceptsSkeletonResume({ ...claim, blockSize: BLOCK * 2 })).toBe(
      false,
    );
    expect(acceptsSkeletonResume({ ...claim, blockDigests: [] })).toBe(false);
    // A later client's claim still PARSES on this host - it is ignored, not
    // refused, so the subscribe itself never fails over it.
    expect(
      chatSkeletonResumeSchema.safeParse({
        ...claim,
        derivation: SKELETON_RESUME_DERIVATION + 1,
      }).success,
    ).toBe(true);
  });
});
