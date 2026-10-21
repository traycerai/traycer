import { describe, expect, it } from "vitest";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import {
  deriveFrameCommentPositions,
  frameCommentStatus,
} from "@/lib/comments/frame-comment-positions";

const BOARD = `<main data-tid="root"><h1 data-tid="title">Launch plan</h1><p data-tid="body">Ship it</p></main>`;

function frameThread(
  threadId: string,
  data: Partial<CommentThreadWire["data"]>,
): CommentThreadWire {
  return {
    threadId,
    resolved: false,
    createdAt: 1,
    comments: [],
    data: { createdByUserId: "user-1", ...data },
  };
}

describe("frameCommentStatus", () => {
  it("is present for an element that exists once", () => {
    const thread = frameThread("t", {
      anchorKind: "element",
      elementId: "title",
    });
    expect(frameCommentStatus(BOARD, thread)).toBe("present");
  });

  it("is missing for an element that was removed", () => {
    const thread = frameThread("t", {
      anchorKind: "element",
      elementId: "gone",
    });
    expect(frameCommentStatus(BOARD, thread)).toBe("missing");
  });

  it("is missing when the tid is duplicated", () => {
    const source = `<p data-tid="dup">a</p><p data-tid="dup">b</p>`;
    const thread = frameThread("t", {
      anchorKind: "element",
      elementId: "dup",
    });
    expect(frameCommentStatus(source, thread)).toBe("missing");
  });

  it("is missing for a text thread whose quote was removed", () => {
    const thread = frameThread("t", {
      anchorKind: "text",
      elementId: "title",
      quotedText: "Retire plan",
    });
    expect(frameCommentStatus(BOARD, thread)).toBe("missing");
  });

  it("is present for a text thread whose quote is still in the element", () => {
    const thread = frameThread("t", {
      anchorKind: "text",
      elementId: "title",
      quotedText: "Launch",
    });
    expect(frameCommentStatus(BOARD, thread)).toBe("present");
  });
});

describe("deriveFrameCommentPositions", () => {
  const boards = [
    { path: "index.html", text: BOARD },
    { path: "about.html", text: BOARD },
  ];

  it("pins an artifact thread at position 0", () => {
    const { positions } = deriveFrameCommentPositions(
      [frameThread("whole", { anchorKind: "artifact" })],
      boards,
    );
    expect(positions.get("whole")).toBe(0);
  });

  it("positions an element thread at its start tag in the board source", () => {
    const { positions } = deriveFrameCommentPositions(
      [
        frameThread("title", {
          anchorKind: "element",
          artboard: "index.html",
          elementId: "title",
        }),
      ],
      boards,
    );
    expect(positions.get("title")).toBe(BOARD.indexOf("<h1"));
  });

  it("orders a later board after every thread of an earlier one", () => {
    const { positions } = deriveFrameCommentPositions(
      [
        frameThread("late-board", {
          anchorKind: "element",
          artboard: "about.html",
          elementId: "root",
        }),
        frameThread("early-board", {
          anchorKind: "element",
          artboard: "index.html",
          elementId: "body",
        }),
      ],
      boards,
    );
    expect(positions.get("late-board")).toBeGreaterThan(
      positions.get("early-board") ?? Number.POSITIVE_INFINITY,
    );
  });

  it("leaves out threads whose element is missing or whose board is unknown", () => {
    const { positions } = deriveFrameCommentPositions(
      [
        frameThread("removed", {
          anchorKind: "element",
          artboard: "index.html",
          elementId: "gone",
        }),
        frameThread("no-board", {
          anchorKind: "element",
          artboard: "elsewhere.html",
          elementId: "title",
        }),
      ],
      boards,
    );
    expect(positions.size).toBe(0);
  });
});
