import { useMemo } from "react";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { useFrameCommentThreads } from "@/hooks/comments/use-frame-comment-threads";
import { sortThreadsByDocumentOrder } from "@/lib/comments/comment-filter-utils";
import { useArtifactAnchorPositions } from "@/stores/comments/anchor-positions-store";

export interface OrderedFrameThread {
  readonly thread: CommentThreadWire;
  readonly number: number;
  readonly hasAnchor: boolean;
}

export function useOrderedFrameThreads(
  epicId: string,
  artifactId: string,
  artifactType: "canvas" | "html",
) {
  const threads = useFrameCommentThreads(epicId, artifactId, artifactType);
  const positions = useArtifactAnchorPositions(epicId, artifactId);
  return useMemo(
    () =>
      threads === null
        ? null
        : sortThreadsByDocumentOrder(threads, positions).map(
            ({ thread, anchorPosition }, index): OrderedFrameThread => ({
              thread,
              number: index + 1,
              hasAnchor:
                thread.data.anchorKind === "artifact" ||
                anchorPosition !== null,
            }),
          ),
    [threads, positions],
  );
}
