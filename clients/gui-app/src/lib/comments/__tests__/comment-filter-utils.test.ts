import "../../../../__tests__/test-browser-apis";
import { describe, expect, it } from "vitest";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import {
  countOpenThreads,
  filterThreadsByStatus,
  sortThreadsByDocumentOrder,
  type AnchorPositionMap,
} from "@/lib/comments/comment-filter-utils";

function makeThread(
  id: string,
  resolved: boolean,
  createdAt: number,
): CommentThreadWire {
  return {
    threadId: id,
    resolved,
    createdAt,
    comments: [],
    data: {
      quotedText: "snippet",
      createdByUserId: "user-1",
      createdByHandle: "user1",
    },
  };
}

function makeAnchors(
  entries: ReadonlyArray<readonly [string, number]>,
): AnchorPositionMap {
  return { positions: new Map(entries) };
}

describe("filterThreadsByStatus", () => {
  const open = makeThread("t-open", false, 100);
  const resolved = makeThread("t-resolved", true, 200);

  it("'open' tab keeps only unresolved threads", () => {
    expect(filterThreadsByStatus([open, resolved], "open")).toEqual([open]);
  });

  it("'resolved' tab keeps only resolved threads", () => {
    expect(filterThreadsByStatus([open, resolved], "resolved")).toEqual([
      resolved,
    ]);
  });

  it("'all' tab keeps everything", () => {
    expect(filterThreadsByStatus([open, resolved], "all")).toEqual([
      open,
      resolved,
    ]);
  });
});

describe("sortThreadsByDocumentOrder", () => {
  it("sorts threads by their anchor position ascending", () => {
    const threads = [
      makeThread("t-late", false, 1),
      makeThread("t-early", false, 2),
      makeThread("t-mid", false, 3),
    ];
    const anchors = makeAnchors([
      ["t-early", 5],
      ["t-mid", 20],
      ["t-late", 99],
    ]);
    const sorted = sortThreadsByDocumentOrder(threads, anchors).map(
      (t) => t.thread.threadId,
    );
    expect(sorted).toEqual(["t-early", "t-mid", "t-late"]);
  });

  it("sinks orphans (anchor missing) below anchored threads", () => {
    const threads = [
      makeThread("t-orphan-old", false, 100),
      makeThread("t-anchored", false, 200),
      makeThread("t-orphan-new", false, 300),
    ];
    const anchors = makeAnchors([["t-anchored", 50]]);
    const sorted = sortThreadsByDocumentOrder(threads, anchors);
    expect(sorted.map((t) => t.thread.threadId)).toEqual([
      "t-anchored",
      "t-orphan-old",
      "t-orphan-new",
    ]);
    expect(sorted[0].anchorPosition).toBe(50);
    expect(sorted[1].anchorPosition).toBeNull();
  });

  it("breaks ties between two orphans by createdAt", () => {
    const threads = [
      makeThread("t-newer", false, 200),
      makeThread("t-older", false, 50),
    ];
    const anchors = makeAnchors([]);
    const sorted = sortThreadsByDocumentOrder(threads, anchors).map(
      (t) => t.thread.threadId,
    );
    expect(sorted).toEqual(["t-older", "t-newer"]);
  });
});

describe("countOpenThreads", () => {
  it("counts only unresolved threads", () => {
    const threads = [
      makeThread("a", false, 1),
      makeThread("b", true, 2),
      makeThread("c", false, 3),
      makeThread("d", true, 4),
    ];
    expect(countOpenThreads(threads)).toBe(2);
  });

  it("returns zero for an empty thread list", () => {
    expect(countOpenThreads([])).toBe(0);
  });
});
