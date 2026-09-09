import { QUEUE_PAUSED_AFTER_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { ChatActivityTimelineItem } from "@/components/chat/chat-activity-groups";

/**
 * Which error row on a failed turn carries the manual recovery actions - and
 * therefore the only one that gets them.
 *
 * ## The problem this exists to solve
 *
 * A failed turn is not one error block. The host appends a second one whenever
 * queued messages were held ("N queued messages were held … Resume the queue to
 * send them"), and a Traycer-shipped provider extension can raise a
 * non-terminal error of its own before the provider run reaches its real
 * terminal. Every one of those blocks belongs to the same turn and therefore
 * used to receive the same `turnId` - so the card rendered a full
 * Retry / Switch… / Wait group under each of them, including under the
 * queue-pause notice, where pressing "Retry" retried the failed prompt instead
 * of resuming the queue the sentence directly above was talking about.
 *
 * Turn identity cannot separate them, because they genuinely share it. What
 * separates them is which block describes the ATTEMPT that failed.
 *
 * ## The predicate, and why each clause is load-bearing
 *
 * 1. The queue-pause notice is excluded by CODE. It is an error block by type
 *    only - a piece of queue bookkeeping - and it is the one block that is
 *    guaranteed to arrive AFTER the failure it accompanies, so any "last error
 *    wins" rule lands on it.
 * 2. Among what is left, the LAST block carrying a typed `failure` wins. A
 *    non-terminal extension error precedes the real terminal, so "last" picks
 *    the terminal one; and a typed failure is what the host's own manual-rung
 *    guard chain reads, so this is the block the offered rungs are about.
 * 3. If nothing carries one, the LAST remaining block wins. This clause is not
 *    defensive padding: the host omits `failure` from the durable record
 *    whenever the adapter emitted none, while `lastFailedAttempt` still gets a
 *    synthesized one - so a real failed turn can offer rungs with every block
 *    untyped, and a rule that stopped at clause 2 would DELETE a shipped
 *    affordance on exactly those turns.
 *
 * `null` when the turn has no error block the actions could belong to (a turn
 * whose only error is the queue-pause notice - the queue's own recovery is a
 * separate control and stays that way).
 *
 * Walks the TIMELINE rather than the raw segments because the timeline is what
 * reaches the renderer. That is not a distinction without a difference for
 * every kind - tool, command, file-change, subagent and reasoning segments are
 * folded into activity groups - but it is one this function does not have to
 * know about: an error the renderer never mounts cannot be an anchor.
 */
export function manualRungAnchorSegmentId(
  items: ReadonlyArray<ChatActivityTimelineItem>,
): string | null {
  let lastWithFailure: string | null = null;
  let lastCandidate: string | null = null;
  for (const item of items) {
    if (item.kind !== "segment") continue;
    const segment = item.segment;
    if (segment.kind !== "error") continue;
    if (segment.code === QUEUE_PAUSED_AFTER_ERROR_CODE) continue;
    lastCandidate = item.id;
    if (segment.failure !== null) lastWithFailure = item.id;
  }
  return lastWithFailure ?? lastCandidate;
}
