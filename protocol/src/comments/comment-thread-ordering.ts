import type { CommentThreadWire } from "@traycer/protocol/host";

export interface AnchorPositionMap {
  /** Document position of the first character of each thread's anchor mark. */
  readonly positions: ReadonlyMap<string, number>;
}

export interface AnchorPosResolvedThread {
  readonly thread: CommentThreadWire;
  readonly anchorPosition: number | null;
}

type ProseMirrorMarkLike = {
  readonly type: {
    readonly name: string;
  };
  readonly attrs: unknown;
};

type ProseMirrorNodeLike = {
  readonly marks: ReadonlyArray<ProseMirrorMarkLike>;
};

type ProseMirrorDocLike = {
  descendants(
    callback: (node: ProseMirrorNodeLike, pos: number) => boolean,
  ): void;
};

const THREAD_ANCHOR_MARK_NAME = "threadAnchor";

/**
 * Walk a ProseMirror doc once and collect the document position of every
 * `threadAnchor` mark. Earliest position wins when a thread spans multiple
 * text nodes.
 */
export function scanThreadAnchorsFromDoc(
  doc: ProseMirrorDocLike,
): AnchorPositionMap {
  const positions = new Map<string, number>();
  doc.descendants((node, pos) => {
    for (const mark of node.marks) {
      if (mark.type.name !== THREAD_ANCHOR_MARK_NAME) continue;
      const threadId = readThreadAnchorId(mark.attrs);
      if (threadId === null) continue;
      if (!positions.has(threadId)) {
        positions.set(threadId, pos);
      }
    }
    return true;
  });
  return { positions };
}

/**
 * Sort threads by document position; orphans (anchor missing) sink below
 * anchored threads in creation order.
 */
export function sortThreadsByDocumentOrder(
  threads: ReadonlyArray<CommentThreadWire>,
  anchors: AnchorPositionMap,
): ReadonlyArray<AnchorPosResolvedThread> {
  const decorated: AnchorPosResolvedThread[] = threads.map((thread) => {
    const pos = anchors.positions.get(thread.threadId);
    return {
      thread,
      anchorPosition: pos === undefined ? null : pos,
    };
  });
  decorated.sort(compareSortedThreads);
  return decorated;
}

function compareSortedThreads(
  a: AnchorPosResolvedThread,
  b: AnchorPosResolvedThread,
): number {
  if (a.anchorPosition === null && b.anchorPosition === null) {
    const createdAtComparison = a.thread.createdAt - b.thread.createdAt;
    if (createdAtComparison !== 0) return createdAtComparison;
    return a.thread.threadId.localeCompare(b.thread.threadId);
  }
  if (a.anchorPosition === null) return 1;
  if (b.anchorPosition === null) return -1;
  const anchorComparison = a.anchorPosition - b.anchorPosition;
  if (anchorComparison !== 0) return anchorComparison;
  return a.thread.threadId.localeCompare(b.thread.threadId);
}

function readThreadAnchorId(anchor: unknown): string | null {
  if (anchor === null || typeof anchor !== "object") return null;
  if (!("threadId" in anchor)) return null;
  const threadId = anchor.threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}
