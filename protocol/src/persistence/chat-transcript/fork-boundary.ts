import type { AssistantMessage } from "@traycer/protocol/persistence/epic/messages";
import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";

/**
 * # The chat's fork boundary
 *
 * "Which assistant message would a fork of this chat cut at" - the value the
 * composer's switch-host gesture anchors on ("fork the chat as it stands").
 *
 * ## Why this is a whole-transcript derivation rather than a skeleton field
 *
 * The renderer answers this by scanning `renderedMessages` backwards for the
 * first row that is an assistant, has `completedAt`, has no `runState`, and
 * carries a non-transient `persistentMessageId`. A windowed client holds only a
 * window of rows, so it cannot run that scan - which is why the answer travels
 * as one scalar on the transcript-derived payload, beside `latestAssistantUsage`
 * and `pinnedTodo`.
 *
 * The plan originally put `completedAt`/`runState`/`persistentMessageId` on
 * every skeleton entry so the scan could run over the skeleton instead. That
 * was three per-row fields, and two of them the host cannot honestly fill: the
 * VALUE of `completedAt` comes from the renderer's turn-lifecycle fold, so a
 * host that shipped the persisted timestamp under that name would be shipping a
 * subtly different number to anything that later read it for display.
 *
 * What makes the scalar cheap is that fork eligibility never reads those
 * values, only their nullness - and their nullness is not the fold:
 *
 * - `completedAt` is stamped by `withTurnCompletion`, which returns early
 *   unless `turnComplete`, and `turnComplete` is exactly
 *   `activeTurnId !== turnKey`. The fold decides WHICH instant is stamped, never
 *   WHETHER one is.
 * - `runState` is `turnComplete ? null : activeRunState` - the same gate.
 * - `persistentMessageId` is the turn accumulator's `messageId`.
 *
 * So "is this turn forkable" reduces to "is this turn not the active turn", and
 * the host is the authority on the active turn - it is the host that emits
 * `activeTurn` on the stream in the first place. No fold, no per-row fields.
 *
 * ## Why it is shared code
 *
 * Same reason as `row-order.ts`: the host computes this for a windowed client
 * while the renderer keeps computing it for itself against legacy peers (the
 * full-materialized fallback mode), and a user must not see the boundary move
 * when the same chat is opened against a different host version. Two
 * implementations that agree by inspection drift; one is checked by the
 * equivalence test that runs this against the renderer's own scan.
 */

/**
 * The turn a record belongs to.
 *
 * Records written before `turnId` existed fall back to their timestamp, which
 * makes each such record its own turn. Mirrors `assistantTurnKey` in
 * `rendered-messages.ts`, which imports this rather than restating it.
 */
export function assistantTurnKey(message: AssistantMessage): string {
  return message.turnId ?? `ts:${message.timestamp}`;
}

/**
 * The most recent completed assistant turn's persisted message id, or `null`
 * when the chat has none - the agent has never replied, or its only assistant
 * turn is the one running right now.
 *
 * ## Why this reads ROWS and not the records
 *
 * The renderer answers this with TWO different orders, and an earlier version
 * of this function took one array and tried to serve both:
 *
 * - **Which turn** is the last assistant row in DISPLAY order - the renderer
 *   scans `renderedMessages`, which it has already sorted with
 *   `compareCanonicalRowOrder`.
 * - **Which record id** within that turn is the last contributing record in
 *   PROJECTION order - the turn accumulator's `existing.messageId =
 *   message.messageId`, last write wins over the raw array walk.
 *
 * Those orders are the same until they are not. `upsertEntry` appends an
 * unseen record at the TAIL, so a checkpoint restore re-adds an older record
 * at the end of the array while its `timestamp` - and therefore its display
 * position - stays historical. Passing projection order then picks the wrong
 * TURN; passing canonical order picks the wrong RECORD ID inside a multi-record
 * turn. One array cannot satisfy both, which is what the cold review found.
 *
 * A projected row already carries both, because `projectTranscriptRows` returns
 * rows sorted into canonical order while each `assistant-slice` source carries
 * its turn's `messageIds` in raw WALK order - the same walk the renderer's
 * accumulator runs. So the scan below reads display order from the array and
 * projection order from `messageIds`, and cannot drift from the renderer
 * without the ordinal space drifting too.
 *
 * ## Why the steer-only and stopped cases need no parameters
 *
 * They are decided by which rows exist, which the projection has already
 * settled:
 *
 * - A turn whose blocks are ALL steers plans only steer entries, so it
 *   contributes no `assistant-slice` row and is skipped here - matching the
 *   renderer, where `withTurnCompletion` finds no assistant row to stamp.
 * - A turn with no blocks still plans ONE empty slice, so it IS a boundary.
 * - A STOPPED steer-only turn gets a synthesized trailing slice
 *   (`assistantTurnNeedsTrailingRow`) precisely so the stop marker has
 *   somewhere to land, so it is a boundary again - without this function
 *   needing to be told which turns were stopped.
 *
 * @param rows The projected transcript rows from `projectTranscriptRows`, in
 * canonical order. Scanned backwards.
 * @param activeTurnId The turn in flight, or `null` when the chat is idle. The
 * live turn is never a fork boundary: forking there would cut at a turn the
 * user is still watching.
 */
export function latestForkableAssistantMessageId(
  rows: readonly TranscriptRowDescriptor[],
  activeTurnId: string | null,
): string | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const source = rows[index].source;
    if (source.kind !== "assistant-slice") continue;
    if (source.turnKey === activeTurnId) continue;
    // Walk order, so the last entry is the record the renderer's accumulator
    // ended up holding. Empty only if a turn were projected with no records at
    // all, which the accumulator cannot produce - guarded rather than indexed
    // blindly, because reading `[-1]` here would return `undefined` as an id.
    const lastContributingId = source.messageIds.at(-1);
    if (lastContributingId === undefined) continue;
    return lastContributingId;
  }
  return null;
}
