import { QUEUE_PAUSED_AFTER_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { MessageSegment } from "@/stores/composer/chat-store";

/**
 * Which error segment on a failed turn carries the manual recovery actions -
 * and therefore the only one that gets them.
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
 * ## Why this runs over the whole turn, in the store
 *
 * It used to run in `AssistantMessageBody` over that component's own activity
 * timeline. That was correct for a turn rendered as one row and WRONG for a
 * turn that splits: `planAssistantTurnRows` cuts a turn into a fresh assistant
 * slice at every steer, each slice is its own row with its own
 * `AssistantMessageBody`, and every one of them carries the same `turnId`. A
 * turn that failed with an extension error before a steer and its real
 * terminal after it therefore ran this walk TWICE, over two disjoint block
 * lists, and each walk dutifully returned an anchor - two Retry / Switch… /
 * Wait groups for one failed attempt, on a card whose entire premise is that a
 * transcript holding three failed attempts offers recovery once rather than
 * three times. The three clauses above are all about picking one block out of
 * the turn; run them over a fragment and they pick one block out of the
 * fragment, which is a different question with a plausible-looking answer.
 *
 * So the walk moved into `renderAssistantTurnRows`, which runs once per turn.
 * Note WHERE in that function, because it is not where you would guess and the
 * first version of this paragraph guessed wrong: the plan is applied first and
 * the rows are built, then `withManualRungAnchor` runs LAST - after
 * `withTurnCompletion` and the run-state pass - and reconstructs the ordered
 * whole-turn segment list from the finished rows via `assistantTurnSegments`.
 * Selection is still once per turn over the whole turn; it just happens on the
 * far side of the split rather than before it, so that the stamp is written by
 * one place and cannot be dropped by a pass added later.
 *
 * The chosen id rides the projection as `ChatMessage.manualRungAnchorId` and is
 * compared by `chat-stable-rows.ts` like any other row field.
 *
 * ## What moving it cost, and why the cost is nil
 *
 * The component's version walked the TIMELINE rather than the raw segments,
 * for a stated reason: an error the renderer never mounts cannot be an anchor.
 * This version walks segments, and the guarantee survives intact for two
 * independent reasons.
 *
 * First, an error segment is never folded away AND never dropped - two
 * separate questions, and the second is the one that would actually hurt.
 * `buildChatActivityTimeline` has exactly four dispositions per segment, and
 * an error can only reach the last:
 *
 * | Disposition | Gate | Reaches an error? |
 * | --- | --- | --- |
 * | dropped, no push | `shouldSuppressInlineSegment` - a STREAMING `interview`, or an `approval` with no decision | no, gated on `kind` |
 * | dropped, no push | `isSuppressedQuestionTool` - a `tool` whose name is a known interview display tool | no, gated on `kind` |
 * | folded into a group | `isActivitySegment` - tool, command, file_change, subagent, decided approval, reasoning | no, gated on `kind` |
 * | pushed standalone | everything else, as `{kind: "segment", id: segment.id}` | YES, always |
 *
 * So for the only kind this predicate can ever select, timeline item ids and
 * segment ids are the same set, and the two walks return the same id.
 *
 * That table is the thing to re-read if this ever misbehaves: adding an
 * error-kind case to either suppressor would let this name a segment the
 * renderer never mounts, and the symptom would be a failed turn with NO
 * recovery group rather than an error anyone could trace back to here.
 *
 * Second, the guarantee is now enforced where it belongs: the renderer matches
 * `item.id === manualRungAnchorId` against the items it is actually mounting,
 * so an anchor that reaches no row renders nothing anywhere. The old code
 * could only ever have hidden that by silently picking a different block,
 * which is the failure mode, not the protection.
 */
export function manualRungAnchorSegmentId(
  segments: ReadonlyArray<MessageSegment>,
): string | null {
  let lastWithFailure: string | null = null;
  let lastCandidate: string | null = null;
  for (const segment of segments) {
    if (segment.kind !== "error") continue;
    if (segment.code === QUEUE_PAUSED_AFTER_ERROR_CODE) continue;
    lastCandidate = segment.id;
    if (segment.failure !== null) lastWithFailure = segment.id;
  }
  return lastWithFailure ?? lastCandidate;
}
