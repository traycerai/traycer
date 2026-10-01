import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";

// A synthesized row whose single segment is a setup-card / forked-chat-link /
// imported-chat-marker / auto-judge-unattended-denial / auto-judge-notice
// renders that segment
// directly - its own card and its own find anchor -
// instead of a normal message body. Both the renderer
// (renderSpecialSegment in chat-message.tsx) and the find projection
// (chatFindUnitsForMessage in chat-find-projection.ts) key off this shape, so it
// lives in one place to keep them from drifting.
export function singleSpecialSegment(
  segments: ReadonlyArray<MessageSegment>,
): MessageSegment | null {
  if (segments.length !== 1) return null;
  const segment = segments[0];
  if (
    segment.kind === "setup-card" ||
    segment.kind === "forked-chat-link" ||
    segment.kind === "imported-chat-marker" ||
    segment.kind === "auto-judge-unattended-denial" ||
    segment.kind === "auto-judge-notice"
  ) {
    return segment;
  }
  return null;
}

/**
 * A row the transcript deliberately draws nothing for: today only the legacy
 * auto-mode judge notice. Hosts no longer write it - the judge's reason rides
 * the approval card it escalated to, and a durable line that outlived its
 * condition read as a present fault long after the mode was switched - but
 * rows already on disk keep their ORDINAL, so the projection still produces
 * them and `useRenderedMessages` still enumerates them (the row-projection
 * equivalence suite holds it to the host's list, row for row).
 *
 * The one predicate both halves of "draw nothing" read:
 * {@link withholdUnpaintedRows}, which keeps the row out of the list, and
 * `ChatMessage`, which paints nothing for one that reaches it anyway.
 */
export function rowPaintsNothing(message: ChatMessageModel): boolean {
  return singleSpecialSegment(message.segments)?.kind === "auto-judge-notice";
}

/**
 * The rendered rows minus those that paint nothing - the renderer-policy
 * withholding `transcript-list-rows.ts` already honours for the pinned-todo
 * pass ("A hydrated row the renderer withheld is OMITTED, not placeholder'd").
 *
 * Withheld here rather than painted as an empty `ChatMessage`: the timeline
 * wraps every row it draws in its own padded frame, so a row that renders
 * `null` still leaves a blank band in the transcript. Omitting the model lets
 * the list suppress the ordinal instead, and the host's numbering of every
 * other row is untouched.
 *
 * Returns `messages` itself when nothing is withheld, so the memo chain it
 * feeds does not churn on every streamed token.
 */
export function withholdUnpaintedRows(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatMessageModel> {
  if (!messages.some(rowPaintsNothing)) return messages;
  return messages.filter((message) => !rowPaintsNothing(message));
}
