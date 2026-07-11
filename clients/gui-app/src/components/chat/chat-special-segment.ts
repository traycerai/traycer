import type { MessageSegment } from "@/stores/composer/chat-store";

// A synthesized row whose single segment is a setup-card / forked-chat-link
// renders that segment directly - its own card and its own find anchor -
// instead of a normal message body. Both the renderer
// (renderSingleSpecialSegment in chat-message.tsx) and the find projection
// (chatFindUnitsForMessage in chat-find-projection.ts) key off this shape, so it
// lives in one place to keep them from drifting.
export function singleSpecialSegment(
  segments: ReadonlyArray<MessageSegment>,
): MessageSegment | null {
  if (segments.length !== 1) return null;
  const segment = segments[0];
  if (segment.kind === "setup-card" || segment.kind === "forked-chat-link") {
    return segment;
  }
  return null;
}
