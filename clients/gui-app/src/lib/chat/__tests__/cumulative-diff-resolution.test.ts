import { describe, expect, it } from "vitest";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import {
  fetchableAccumulatedChanges,
  mergeCumulativeDiffs,
} from "@/lib/chat/cumulative-diff-resolution";

function row(input: {
  readonly filePath: string;
  readonly digest: string | null;
  readonly hasContents?: boolean;
}): AccumulatedChangeRow {
  return {
    filePath: input.filePath,
    operation: "edit",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    artifact: null,
    counts: { additions: 1, deletions: 1 },
    hasContents: input.hasContents ?? true,
    digest: input.digest,
  };
}

describe("fetchableAccumulatedChanges", () => {
  it("asks for each path at the version its row names", () => {
    expect(
      fetchableAccumulatedChanges(
        ["/a.ts", "/b.ts"],
        [
          row({ filePath: "/a.ts", digest: "d-a" }),
          row({ filePath: "/b.ts", digest: "d-b" }),
        ],
      ),
    ).toEqual([
      { filePath: "/a.ts", digest: "d-a" },
      { filePath: "/b.ts", digest: "d-b" },
    ]);
  });

  it("does not ask for a path whose contents rode the snapshot", () => {
    // `digest: null` is the pre-windowed line. Fetching there would ask a host
    // for a version it never minted.
    expect(
      fetchableAccumulatedChanges(
        ["/a.ts"],
        [row({ filePath: "/a.ts", digest: null })],
      ),
    ).toEqual([]);
  });

  it("does not ask for a path with no before/after to fetch", () => {
    // `hasContents: false` would come back with nothing, and the tile would sit
    // in its loading state waiting for it.
    expect(
      fetchableAccumulatedChanges(
        ["/NOTES"],
        [row({ filePath: "/NOTES", digest: "d", hasContents: false })],
      ),
    ).toEqual([]);
  });

  it("does not ask for a path that has left the accumulated set", () => {
    // A bundle names its paths when it is opened; one reverted since has no
    // row, and asking would be asking about a change that no longer exists.
    expect(fetchableAccumulatedChanges(["/gone.ts"], [])).toEqual([]);
  });
});

describe("mergeCumulativeDiffs", () => {
  const fetchable = [{ filePath: "/a.ts", digest: "d-a" }];

  it("resolves inline alone when nothing needs fetching", () => {
    const inline = [
      { filePath: "/a.ts", beforeContent: "one\n", afterContent: "two\n" },
    ];
    expect(
      mergeCumulativeDiffs({
        filePaths: ["/a.ts"],
        inline,
        fetchable: [],
        fetches: [],
      }),
    ).toEqual({
      resolved: inline,
      isLoading: false,
      stale: false,
      failed: false,
    });
  });

  it("resolves a fetched body", () => {
    expect(
      mergeCumulativeDiffs({
        filePaths: ["/a.ts"],
        inline: [],
        fetchable,
        fetches: [
          {
            isLoading: false,
            isError: false,
            data: { stale: false, beforeContent: "x\n", afterContent: "y\n" },
          },
        ],
      }),
    ).toEqual({
      resolved: [
        { filePath: "/a.ts", beforeContent: "x\n", afterContent: "y\n" },
      ],
      isLoading: false,
      stale: false,
      failed: false,
    });
  });

  it("reports loading while a body is in flight", () => {
    expect(
      mergeCumulativeDiffs({
        filePaths: ["/a.ts"],
        inline: [],
        fetchable,
        fetches: [{ isLoading: true, isError: false, data: undefined }],
      }),
    ).toMatchObject({ resolved: [], isLoading: true });
  });

  /**
   * The digest race: the agent edited the file between render and open, so the
   * version asked for is gone. The host refuses rather than pairing newer
   * bodies with the metadata still on screen. It must NOT resolve to content.
   */
  it("resolves nothing for a superseded version, and says so", () => {
    expect(
      mergeCumulativeDiffs({
        filePaths: ["/a.ts"],
        inline: [],
        fetchable,
        fetches: [{ isLoading: false, isError: false, data: { stale: true } }],
      }),
    ).toEqual({ resolved: [], isLoading: false, stale: true, failed: false });
  });

  /**
   * A bundle renders its files in the order it was opened showing. Merging by
   * source would reorder them the moment one file's body arrived separately
   * from another's - which is every mixed set, and every partial load.
   */
  it("keeps the tile's order across a mixed inline/fetched set", () => {
    const result = mergeCumulativeDiffs({
      filePaths: ["/a.ts", "/b.ts", "/c.ts"],
      inline: [
        { filePath: "/c.ts", beforeContent: "c1\n", afterContent: "c2\n" },
      ],
      fetchable: [
        { filePath: "/a.ts", digest: "d-a" },
        { filePath: "/b.ts", digest: "d-b" },
      ],
      fetches: [
        {
          isLoading: false,
          isError: false,
          data: { stale: false, beforeContent: "a1\n", afterContent: "a2\n" },
        },
        {
          isLoading: false,
          isError: false,
          data: { stale: false, beforeContent: "b1\n", afterContent: "b2\n" },
        },
      ],
    });
    expect(result.resolved.map((entry) => entry.filePath)).toEqual([
      "/a.ts",
      "/b.ts",
      "/c.ts",
    ]);
  });

  it("drops a path that resolved from neither source", () => {
    const result = mergeCumulativeDiffs({
      filePaths: ["/a.ts", "/gone.ts"],
      inline: [],
      fetchable,
      fetches: [
        {
          isLoading: false,
          isError: false,
          data: { stale: false, beforeContent: "x\n", afterContent: "y\n" },
        },
      ],
    });
    expect(result.resolved.map((entry) => entry.filePath)).toEqual(["/a.ts"]);
  });
});
