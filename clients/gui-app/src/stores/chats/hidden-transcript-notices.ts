import { QUEUE_PAUSED_AFTER_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { LastFallbackOutcome } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderNoticeDetail } from "@traycer/protocol/persistence/epic/content-blocks";
import type { MessageSegment } from "@/stores/composer/chat-store";

/**
 * The transcript rows this client keeps off screen although a host writes
 * them, and the one place that says which.
 *
 * Every reader that draws, counts or speaks a row asks here: the timeline
 * (`AssistantMessageBody`), its elapsed footer, chat find
 * (`buildChatFindRows`) and the live announcer (`chat-announcements.ts`). A
 * row hidden by one of them and drawn, found or spoken by another is the
 * defect this module exists to rule out: a find hit with nothing painted to
 * highlight, a screen reader announcing a row nobody can see.
 *
 * Both rows are still WRITTEN, for the clients that predate this one (user
 * ruling, 2026-09-27: "All the previous clients must maintain the correct
 * support"). An older client draws them as it always has; this one says the
 * same thing elsewhere, or - after the user's own refusal - has nothing more
 * to say.
 */

/**
 * Whether the queue-pause notice (`QUEUE_PAUSED_AFTER_ERROR`) is hidden, given
 * whether this chat's negotiated `chat.subscribe` line carries the queue's
 * `pausedReason` (`1.18`; `ChatSessionState.queuePauseReasonProtocolSupported`).
 *
 * On such a line the Message Queue panel's pill says it ("Paused after an
 * error") and the notice would be a second copy. On an older line the host
 * sends no reason and the pill reads plain "Paused", while a row's own note is
 * either absent (a command or MCP delivery draws none) or stale (a pause keeps
 * a row's earlier reason, and a resume clears none) - so the notice is the one
 * place the user learns why the queue stopped, and it is drawn.
 *
 * `null` - no session, or one not yet `open` - hides. The newer host is the
 * common case, and a notice that appears once the line is known is a smaller
 * surprise than one that vanishes.
 *
 * Keyed on the LINE, never on the live `pausedReason`. That reason is cleared
 * the moment the user resumes or the queue drains, while the notice belongs to
 * a past turn: a rule reading the live value would bring every earlier turn's
 * notice back on the first resume.
 */
export function queuePausedNoticeHidden(
  queuePauseReasonProtocolSupported: boolean | null,
): boolean {
  return queuePauseReasonProtocolSupported !== false;
}

/** The `details` row a routing settlement stamps with its stable code. */
const SETTLEMENT_CODE_LABEL = "Code";

/**
 * The code a traversal settles with when the user refuses it ("Don't switch",
 * "Don't wait"): the host's `fallbackSettlementCode("cancelled_by_user")`.
 */
const USER_REFUSAL_SETTLEMENT_CODE = "FALLBACK_CANCELLED";

/**
 * The row test both carriers of the refusal share: a `Code` row whose value is
 * exactly the refusal's code.
 *
 * Exact equality on the label and the value, and on nothing a person reads. A
 * host older than this work writes EVERY settled notice without a receipt, so
 * a null receipt is not a refusal; the title and the `Cause` row are prose a
 * host may reword. The code is the settlement's stable identity - printed
 * under `Code` because a support report matches it - and a replayed settle
 * reproduces it exactly.
 */
function carriesUserRefusalCode(
  details: ReadonlyArray<ProviderNoticeDetail>,
): boolean {
  return details.some(
    (detail) =>
      detail.label === SETTLEMENT_CODE_LABEL &&
      detail.value === USER_REFUSAL_SETTLEMENT_CODE,
  );
}

/**
 * Whether `segment` is the notice a routing settlement writes after the user's
 * own refusal.
 *
 * Hidden on every host (ruling, 2026-09-27): after a refusal this client shows
 * the failed turn's card with its actions and nothing else about routing. A
 * host older than this client writes the notice too, so on such a host this is
 * a change against main, by that ruling. It never becomes the settled card
 * either way: it carries no receipt (`routingSettledNoticeSegmentId`).
 */
export function isRoutingCancellationNotice(segment: MessageSegment): boolean {
  return (
    segment.kind === "provider_notice" &&
    segment.noticeKind === "fallback_settled" &&
    carriesUserRefusalCode(segment.details)
  );
}

/**
 * The same refusal on the host's last-outcome slot (`lastFallbackOutcome`),
 * which the host fills from the notice it just wrote, `details` row for row.
 * The slot is the notice's second carrier, so it is read by the same rule.
 */
export function isRoutingCancellationOutcome(
  outcome: LastFallbackOutcome,
): boolean {
  return outcome.kind === "settled" && carriesUserRefusalCode(outcome.details);
}

/**
 * Whether the transcript draws nothing for `segment` - so it is neither
 * counted by find nor the segment that ends its row for the elapsed footer.
 */
export function transcriptSegmentHidden(
  segment: MessageSegment,
  queuePauseReasonProtocolSupported: boolean | null,
): boolean {
  if (segment.kind === "error") {
    return (
      segment.code === QUEUE_PAUSED_AFTER_ERROR_CODE &&
      queuePausedNoticeHidden(queuePauseReasonProtocolSupported)
    );
  }
  return isRoutingCancellationNotice(segment);
}

/**
 * `segments` without the ones the transcript hides - the SAME array when it
 * hides none, which is almost always, so a memoized reader keyed on it keeps
 * its identity.
 *
 * Applied BEFORE the activity timeline is built, by the renderer and by find
 * alike: a hidden row then mounts no block anchor (an empty anchor still took
 * a flex gap), and both group exactly the same list.
 */
export function segmentsShownInTranscript(
  segments: ReadonlyArray<MessageSegment>,
  queuePauseReasonProtocolSupported: boolean | null,
): ReadonlyArray<MessageSegment> {
  const hidden = (segment: MessageSegment) =>
    transcriptSegmentHidden(segment, queuePauseReasonProtocolSupported);
  if (!segments.some(hidden)) return segments;
  return segments.filter((segment) => !hidden(segment));
}
