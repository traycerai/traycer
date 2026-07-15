import type { MessageSegment } from "@/stores/composer/chat-store";

/**
 * Plain-text reply of a finished turn: the visible answer is the `text`
 * segments, joined with blank lines. Reasoning, tool calls, and file-change
 * blocks are intentionally excluded so "copy reply" yields the prose the
 * assistant actually addressed to the user. Shared between
 * `AssistantMessageBody` (per-row copy button) and `rendered-messages.ts`
 * (aggregates it across a whole turn's rows for the stopped-boundary
 * footer's copy control - see `ChatMessageStoppedInfo.turnReplyText`).
 */
export function collectAssistantReplyText(
  segments: ReadonlyArray<MessageSegment>,
): string {
  return segments
    .flatMap((segment) => (segment.kind === "text" ? [segment.markdown] : []))
    .join("\n\n")
    .trim();
}
