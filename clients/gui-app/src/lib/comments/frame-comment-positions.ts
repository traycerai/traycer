import { commentAnchorStatus, locateElement } from "@traycer/html-source";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import type { AnchorPositionMap } from "./comment-filter-utils";

export interface FrameCommentDocument {
  readonly path: string;
  readonly text: string | null;
}
export function frameCommentStatus(
  source: string,
  thread: CommentThreadWire,
): "present" | "missing" {
  const data = thread.data;
  if (data.anchorKind === "artifact")
    return commentAnchorStatus(source, { kind: "artifact" });
  if (data.elementId === undefined) return "missing";
  if (data.anchorKind === "element")
    return commentAnchorStatus(source, {
      kind: "element",
      elementId: data.elementId,
    });
  if (data.anchorKind === "text")
    return commentAnchorStatus(source, {
      kind: "text",
      elementId: data.elementId,
      quotedText: data.quotedText ?? "",
    });
  return "missing";
}
export function deriveFrameCommentPositions(
  threads: readonly CommentThreadWire[],
  boards: readonly FrameCommentDocument[],
): AnchorPositionMap {
  const positions = new Map<string, number>();
  const byPath = new Map(
    boards.map((board, index) => [board.path, { board, index }]),
  );
  for (const thread of threads) {
    if (thread.data.anchorKind === "artifact") {
      positions.set(thread.threadId, 0);
      continue;
    }
    const entry =
      thread.data.artboard === undefined
        ? undefined
        : byPath.get(thread.data.artboard);
    if (entry === undefined) continue;
    const { board, index } = entry;
    if (
      board.text === null ||
      thread.data.elementId === undefined ||
      frameCommentStatus(board.text, thread) !== "present"
    )
      continue;
    const located = locateElement(board.text, {
      kind: "tid",
      tid: thread.data.elementId,
    });
    if (located.ok && located.element.startTag !== null)
      positions.set(
        thread.threadId,
        index * 10_000_000 + located.element.startTag.start,
      );
  }
  return { positions };
}
