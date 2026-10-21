import type { MarkdownArtifactKind } from "@traycer/protocol/common/registry";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";

export type CommentArtifactKind = MarkdownArtifactKind | "html" | "canvas";

export function isCommentArtifactKind(
  type: unknown,
): type is CommentArtifactKind {
  return (
    type === "spec" ||
    type === "ticket" ||
    type === "story" ||
    type === "review" ||
    type === "html" ||
    type === "canvas"
  );
}

export function commentArtifactKindFor(
  type: EpicNodeKind,
): CommentArtifactKind | null {
  return isCommentArtifactKind(type) ? type : null;
}
