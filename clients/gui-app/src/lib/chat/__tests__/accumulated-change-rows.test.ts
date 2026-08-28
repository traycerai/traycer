import { describe, expect, it } from "vitest";
import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatAccumulatedFileChangeSummary } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  accumulatedChangeRows,
  hostAccumulatedChangeRows,
  rowFromAccumulatedChange,
  rowFromAccumulatedChangeSummary,
  undeliveredHostChangeCount,
  accumulatedSummarySetComplete,
} from "@/lib/chat/accumulated-change-rows";
import type {
  ChatMessage,
  ChatMessageRunState,
  FileChangeSegment,
  MessageSegment,
} from "@/stores/composer/chat-store";

describe("accumulatedChangeRows", () => {
  it("emits the client's own row for an active-turn file no host version names", () => {
    // The host recomputes its accumulated set at turn boundaries, so a file the
    // running turn just created is not in it. The client's row stands in until
    // the recompute lands, carrying the per-edit magnitude so the panel moves.
    const changes = accumulatedChangeRows(
      [
        assistantMessage({
          id: "assistant:turn-1",
          runState: "running",
          segments: [
            fileChangeSegment({
              id: "change-1",
              filePath: "/repo/src/app.ts",
              beforeHash: "a".repeat(64),
              afterHash: "b".repeat(64),
              additions: 1,
              deletions: 1,
            }),
          ],
        }),
      ],
      [],
      "turn-1",
    );

    expect(changes).toEqual([
      {
        filePath: "/repo/src/app.ts",
        operation: "edit",
        diffSource: "snapshot",
        reason: "snapshot",
        undoable: true,
        artifact: null,
        // Summed from the merged segment (here one edit, +1/-1) so the panel
        // shows a live `+/-` before the host recomputes at turn end.
        counts: { additions: 1, deletions: 1 },
        hasContents: true,
        // No host version names this file yet, so there is nothing to quote in
        // a contents request - the segment tile is what opens its diff, and
        // `liveDiff` is the address it opens on.
        digest: null,
        liveDiff: {
          sourceBlockIds: ["change-1"],
          beforeHash: "a".repeat(64),
          afterHash: "b".repeat(64),
        },
      },
    ]);
  });

  it("prefers the host row when present during an active turn", () => {
    // The host's row is authoritative and used wholesale. Mid-turn its counts
    // are one turn stale, which is deliberate: a stale number that means the
    // same thing as every other row beats a per-edit number that does not.
    const changes = accumulatedChangeRows(
      [
        assistantMessage({
          id: "assistant:turn-2",
          runState: "running",
          segments: [
            fileChangeSegment({
              id: "change-2",
              filePath: "/repo/src/app.ts",
              beforeHash: "c".repeat(64),
              afterHash: "d".repeat(64),
              additions: 1,
              deletions: 1,
            }),
          ],
        }),
      ],
      [
        rowFromAccumulatedChangeSummary(
          summary({
            filePath: "/repo/src/app.ts",
            counts: { additions: 9, deletions: 9 },
          }),
        ),
      ],
      "turn-2",
    );

    // The host's counts, not the segment's +1/-1, and the host's digest with
    // them - which is what lets the row's diff be fetched at all.
    expect(changes).toMatchObject([
      {
        filePath: "/repo/src/app.ts",
        counts: { additions: 9, deletions: 9 },
        digest: "digest-1",
      },
    ]);
  });

  it("suppresses an active-turn net no-op (equal endpoints) with no host row", () => {
    // Edited back to the original within the turn ⇒ equal content-addressed
    // endpoints ⇒ nothing to show.
    const changes = accumulatedChangeRows(
      [
        assistantMessage({
          id: "assistant:turn-3",
          runState: "running",
          segments: [
            fileChangeSegment({
              id: "change-3",
              filePath: "/repo/src/app.ts",
              beforeHash: "e".repeat(64),
              afterHash: "e".repeat(64),
              additions: 1,
              deletions: 1,
            }),
          ],
        }),
      ],
      [],
      "turn-3",
    );

    expect(changes).toEqual([]);
  });

  it("sums per-edit streaming counts across multiple active-turn edits of the same file", () => {
    // The same file is edited twice this turn; the placeholder's
    // `streamingCounts` is the SUM of both edits' additions/deletions, so the
    // pinned panel's `+/-` grows on every edit instead of snapping at turn end.
    // Distinct before/after hashes (a→b, b→c) keep the merged endpoints
    // unequal so the row is not suppressed as a net no-op.
    const changes = accumulatedChangeRows(
      [
        assistantMessage({
          id: "assistant:turn-4",
          runState: "running",
          segments: [
            fileChangeSegment({
              id: "change-4a",
              filePath: "/repo/src/app.ts",
              beforeHash: "a".repeat(64),
              afterHash: "b".repeat(64),
              additions: 3,
              deletions: 1,
            }),
            fileChangeSegment({
              id: "change-4b",
              filePath: "/repo/src/app.ts",
              beforeHash: "b".repeat(64),
              afterHash: "c".repeat(64),
              additions: 2,
              deletions: 4,
            }),
          ],
        }),
      ],
      [],
      "turn-4",
    );

    expect(changes).toMatchObject([
      { filePath: "/repo/src/app.ts", counts: { additions: 5, deletions: 5 } },
    ]);
  });

  describe("what decides the order", () => {
    it("keeps the host's order when the hydrated rows disagree with it", () => {
      // The panel's order is first-touched across the WHOLE chat, and the
      // host's list is exactly that. On the windowed line the rendered rows are
      // the hydrated tail, so deriving the order from them put a file the
      // recent turns touched ahead of one first touched in unhydrated history.
      //
      // Here the host says `old.ts` was touched first; the only hydrated
      // message mentions `recent.ts` first. The host wins.
      const changes = accumulatedChangeRows(
        [
          assistantMessage({
            id: "assistant:turn-5",
            runState: null,
            segments: [
              fileChangeSegment({
                id: "change-5a",
                filePath: "/repo/src/recent.ts",
                beforeHash: "a".repeat(64),
                afterHash: "b".repeat(64),
                additions: 1,
                deletions: 0,
              }),
              fileChangeSegment({
                id: "change-5b",
                filePath: "/repo/src/old.ts",
                beforeHash: "c".repeat(64),
                afterHash: "d".repeat(64),
                additions: 1,
                deletions: 0,
              }),
            ],
          }),
        ],
        [
          rowFromAccumulatedChangeSummary(
            summary({ filePath: "/repo/src/old.ts", counts: null }),
          ),
          rowFromAccumulatedChangeSummary(
            summary({ filePath: "/repo/src/recent.ts", counts: null }),
          ),
        ],
        null,
      );

      expect(changes.map((row) => row.filePath)).toEqual([
        "/repo/src/old.ts",
        "/repo/src/recent.ts",
      ]);
    });

    it("appends an active-turn file the host has no row for", () => {
      // A path no host row names has not been touched by any completed turn,
      // so the running turn is its first toucher and it sorts last - after
      // every file the host knows, whether or not any of them are hydrated.
      const changes = accumulatedChangeRows(
        [
          assistantMessage({
            id: "assistant:turn-6",
            runState: "running",
            segments: [
              fileChangeSegment({
                id: "change-6",
                filePath: "/repo/src/brand-new.ts",
                beforeHash: null,
                afterHash: "f".repeat(64),
                additions: 7,
                deletions: 0,
              }),
            ],
          }),
        ],
        [
          rowFromAccumulatedChangeSummary(
            summary({ filePath: "/repo/src/first.ts", counts: null }),
          ),
          rowFromAccumulatedChangeSummary(
            summary({ filePath: "/repo/src/second.ts", counts: null }),
          ),
        ],
        "turn-6",
      );

      expect(changes.map((row) => row.filePath)).toEqual([
        "/repo/src/first.ts",
        "/repo/src/second.ts",
        "/repo/src/brand-new.ts",
      ]);
    });

    it("keeps a host row in place even when the active turn re-touches it", () => {
      // The host's row wins wholesale where one exists, and that includes its
      // POSITION: an active-turn edit to a long-known file must not lift it to
      // the front of the panel.
      const changes = accumulatedChangeRows(
        [
          assistantMessage({
            id: "assistant:turn-7",
            runState: "running",
            segments: [
              fileChangeSegment({
                id: "change-7",
                filePath: "/repo/src/second.ts",
                beforeHash: "a".repeat(64),
                afterHash: "b".repeat(64),
                additions: 2,
                deletions: 0,
              }),
            ],
          }),
        ],
        [
          rowFromAccumulatedChangeSummary(
            summary({ filePath: "/repo/src/first.ts", counts: null }),
          ),
          rowFromAccumulatedChangeSummary(
            summary({ filePath: "/repo/src/second.ts", counts: null }),
          ),
        ],
        "turn-7",
      );

      expect(changes.map((row) => row.filePath)).toEqual([
        "/repo/src/first.ts",
        "/repo/src/second.ts",
      ]);
    });
  });
});

describe("rowFromAccumulatedChange", () => {
  it("counts the contents it was handed", () => {
    expect(
      rowFromAccumulatedChange(
        accumulatedChange({
          filePath: "/repo/src/app.ts",
          beforeContent: "one\ntwo\n",
          afterContent: "one\nTWO\nthree\n",
        }),
      ),
    ).toMatchObject({
      counts: { additions: 2, deletions: 1 },
      hasContents: true,
      // Contents rode the snapshot on this line, so nothing needs fetching.
      digest: null,
    });
  });

  it("has nothing to count when the diff source is `none`", () => {
    // `null`, not `{0, 0}`: there is no before/after here at all, which the
    // panel renders as a bare row rather than as a zero-line diff.
    expect(
      rowFromAccumulatedChange({
        ...accumulatedChange({
          filePath: "/repo/NOTES",
          beforeContent: null,
          afterContent: null,
        }),
        diffSource: "none",
      }),
    ).toMatchObject({ counts: null, hasContents: false });
  });
});

describe("rowFromAccumulatedChangeSummary", () => {
  it("takes every decided field from the wire", () => {
    expect(
      rowFromAccumulatedChangeSummary(
        summary({
          filePath: "/repo/src/app.ts",
          counts: { additions: 4, deletions: 2 },
        }),
      ),
    ).toEqual({
      filePath: "/repo/src/app.ts",
      operation: "edit",
      diffSource: "snapshot",
      reason: "snapshot",
      undoable: true,
      artifact: null,
      counts: { additions: 4, deletions: 2 },
      hasContents: true,
      digest: "digest-1",
      // A summary always names a host version, so cumulative resolution
      // answers for it and there is no live address to fall back to.
      liveDiff: null,
    });
  });

  it("copies `hasContents` rather than re-deriving it from diffSource", () => {
    // The host owns that rule and is the one entitled to change it. A client
    // that re-derived would be a second implementation of it.
    expect(
      rowFromAccumulatedChangeSummary({
        ...summary({ filePath: "/repo/NOTES", counts: null }),
        hasContents: false,
      }),
    ).toMatchObject({ counts: null, hasContents: false });
  });
});

describe("hostAccumulatedChangeRows", () => {
  const change = accumulatedChange({
    filePath: "/repo/inline.ts",
    beforeContent: "a\n",
    afterContent: "b\n",
  });
  const wire = summary({
    filePath: "/repo/summarized.ts",
    counts: { additions: 1, deletions: 0 },
  });

  it("reads the summaries on the windowed line", () => {
    expect(
      hostAccumulatedChangeRows({
        windowed: true,
        changes: [],
        summaries: [wire],
      }).map((row) => row.filePath),
    ).toEqual(["/repo/summarized.ts"]);
  });

  it("reads the inline changes on the pre-windowed line", () => {
    expect(
      hostAccumulatedChangeRows({
        windowed: false,
        changes: [change],
        summaries: [],
      }).map((row) => row.filePath),
    ).toEqual(["/repo/inline.ts"]);
  });

  /**
   * The tempting wrong implementation is "whichever array is non-empty". It
   * agrees with this one everywhere except the state that matters: a chat that
   * has touched no files is empty on BOTH lines, so emptiness can never be the
   * discriminator - and on the windowed line it would then read the array that
   * is empty by construction and show a panel with nothing in it.
   */
  it("follows the line even when the line's own array is empty", () => {
    expect(
      hostAccumulatedChangeRows({
        windowed: true,
        changes: [change],
        summaries: [],
      }),
    ).toEqual([]);
  });
});

describe("undeliveredHostChangeCount", () => {
  it("is the shortfall while the summary chunks are still arriving", () => {
    expect(
      undeliveredHostChangeCount({
        windowed: true,
        hostChangeCount: 12,
        deliveredSummaryCount: 5,
      }),
    ).toBe(7);
  });

  it("is zero once every summary has landed", () => {
    expect(
      undeliveredHostChangeCount({
        windowed: true,
        hostChangeCount: 12,
        deliveredSummaryCount: 12,
      }),
    ).toBe(0);
  });

  /**
   * The snapshot's count and the chunks are two frames, so a client can hold
   * summaries from a newer set than the count it last read. A negative
   * shortfall would then subtract rows from the header.
   */
  it("never goes negative when more summaries arrived than were counted", () => {
    expect(
      undeliveredHostChangeCount({
        windowed: true,
        hostChangeCount: 3,
        deliveredSummaryCount: 5,
      }),
    ).toBe(0);
  });

  it("is zero on the pre-windowed line, where the set rides the snapshot", () => {
    // `accumulatedFileChangeCount` is 0 off the windowed line while the list
    // itself is whole, so reading it there would report a shortfall backwards.
    expect(
      undeliveredHostChangeCount({
        windowed: false,
        hostChangeCount: 0,
        deliveredSummaryCount: 0,
      }),
    ).toBe(0);
  });
});

function assistantMessage(input: {
  readonly id: string;
  readonly runState: ChatMessageRunState | null;
  readonly segments: ReadonlyArray<MessageSegment>;
}): ChatMessage {
  return {
    id: input.id,
    role: "assistant",
    content: "",
    segments: input.segments,
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: input.runState,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function fileChangeSegment(input: {
  readonly id: string;
  readonly filePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly additions: number;
  readonly deletions: number;
}): FileChangeSegment {
  return {
    id: input.id,
    kind: "file_change",
    filePath: input.filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
    additions: input.additions,
    deletions: input.deletions,
    sourceBlockIds: [input.id],
    reason: "snapshot",
    isStreaming: false,
    endState: null,
    parentId: null,
  };
}

function accumulatedChange(input: {
  readonly filePath: string;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
}): ChatAccumulatedFileChange {
  return {
    filePath: input.filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeContent: input.beforeContent,
    afterContent: input.afterContent,
    reason: "snapshot",
    undoable: true,
  };
}

function summary(input: {
  readonly filePath: string;
  readonly counts: {
    readonly additions: number;
    readonly deletions: number;
  } | null;
}): ChatAccumulatedFileChangeSummary {
  return {
    filePath: input.filePath,
    operation: "edit",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    hasContents: true,
    digest: "digest-1",
    counts: input.counts,
  };
}

describe("accumulatedSummarySetComplete", () => {
  it("is INCOMPLETE after a rebuild until a chunk of the new generation lands", () => {
    // The case a length comparison structurally cannot see. A rebuild retains
    // the previous stream's array on purpose, so between the generation reset
    // and the first replacement chunk those entries - and their digests - are
    // the OLD generation's. When the replacement's authoritative total happens
    // to equal the retained length, "delivered === authoritative" is true over
    // entries this generation never sent.
    //
    // Certain rather than incidental whenever the whole set fits one chunk and
    // that chunk is the one dropped: there is no later chunk to expose the gap.
    expect(
      accumulatedSummarySetComplete({
        windowed: true,
        hostChangeCount: 3,
        deliveredSummaryCount: 3, // lengths agree, and mean nothing
        generationSeated: false,
      }),
    ).toBe(false);
  });

  it("is complete once this generation has delivered and the counts agree", () => {
    expect(
      accumulatedSummarySetComplete({
        windowed: true,
        hostChangeCount: 3,
        deliveredSummaryCount: 3,
        generationSeated: true,
      }),
    ).toBe(true);
  });

  it("still reports a genuine shortfall as incomplete", () => {
    expect(
      accumulatedSummarySetComplete({
        windowed: true,
        hostChangeCount: 5,
        deliveredSummaryCount: 3,
        generationSeated: true,
      }),
    ).toBe(false);
  });

  it("is complete on an EMPTY set even before a chunk arrives", () => {
    // The bound. A host with nothing accumulated streams no chunks at all, so
    // gating on a chunk that will never come would hold every consumer of an
    // empty set open forever.
    expect(
      accumulatedSummarySetComplete({
        windowed: true,
        hostChangeCount: 0,
        deliveredSummaryCount: 0,
        generationSeated: false,
      }),
    ).toBe(true);
  });

  it("is complete on the legacy line, which has no stream", () => {
    expect(
      accumulatedSummarySetComplete({
        windowed: false,
        hostChangeCount: 4,
        deliveredSummaryCount: 0,
        generationSeated: false,
      }),
    ).toBe(true);
  });

  it("is INCOMPLETE on an overshoot, which is the case the clamp erases", () => {
    // The whole reason this is a separate question from
    // `undeliveredHostChangeCount`. A revert LOWERS the host count while the
    // client keeps the previous generation's array until a replacement chunk
    // starting at index 0 lands - so a dropped first chunk leaves more
    // summaries than the count claims. Under a shortfall-only reading that
    // clamps to `0` and every gate calls it finished, leaving reverted paths
    // and stale digests in the panel for the rest of the connection.
    expect(
      accumulatedSummarySetComplete({
        windowed: true,
        hostChangeCount: 2,
        deliveredSummaryCount: 5,
        generationSeated: true,
      }),
    ).toBe(false);
    // And the sibling still answers `0` for it - the two disagreeing here is
    // the point, not a drift between them.
    expect(
      undeliveredHostChangeCount({
        windowed: true,
        hostChangeCount: 2,
        deliveredSummaryCount: 5,
      }),
    ).toBe(0);
  });
});
