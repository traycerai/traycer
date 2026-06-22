import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";

/**
 * Map an `EpicNodeKind` to the comment-thread protocol's narrower
 * `EpicArtifactKind`. Returns `null` for kinds that don't accept comments
 * (chat) so callers can branch off `=== null` in one place.
 */
export function commentArtifactKindFor(
  type: EpicNodeKind,
): EpicArtifactKind | null {
  if (type === "spec") return "spec";
  if (type === "ticket") return "ticket";
  if (type === "story") return "story";
  if (type === "review") return "review";
  return null;
}
