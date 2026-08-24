import type {
  AssistantMessage,
  Message,
} from "@traycer/protocol/persistence/epic/messages";

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
 * Whether a turn's blocks render at least one ASSISTANT row.
 *
 * Nearly every turn does, and a caller may reasonably wonder why this exists.
 * It is the one shape that does not: a turn whose blocks are ALL steers renders
 * only the nested user bubbles, so `withTurnCompletion` finds no assistant row
 * to stamp and the turn contributes no fork boundary at all. A turn with no
 * blocks does render one (an empty slice), so this is not simply "has blocks".
 *
 * The stopped case is the caller's, not this function's: a stopped steer-only
 * turn gets a synthesized trailing assistant row from
 * `attachRunStateToTrailingAssistantSlice` precisely so the stop marker has
 * somewhere to land, and that row IS a boundary.
 */
function turnRendersAssistantRow(
  blocks: ReadonlyArray<{ readonly type: string }>,
): boolean {
  if (blocks.length === 0) return true;
  return blocks.some((block) => block.type !== "steer");
}

/**
 * The most recent completed assistant turn's persisted message id, or `null`
 * when the chat has none - the agent has never replied, or its only assistant
 * turn is the one running right now.
 *
 * @param messages Persisted records in CANONICAL ORDER (`row-order.ts`).
 * Scanned backwards, which is sound because turns are sequential: a chat has at
 * most one turn in flight, so one turn's records never interleave with
 * another's, and the last assistant record in canonical order is therefore its
 * own turn's last record - the one whose `messageId` the renderer's accumulator
 * keeps (`existing.messageId = message.messageId`, last write wins).
 * @param activeTurnId The turn in flight, or `null` when the chat is idle. The
 * live turn is never a fork boundary: forking there would cut at a turn the
 * user is still watching.
 * @param stoppedTurnIds Turns with a `turn.stopped` event. Only consulted for
 * the steer-only shape above; pass an empty set to ignore it and accept that a
 * stopped steer-only turn resolves to the boundary before it.
 */
export function latestForkableAssistantMessageId(
  messages: readonly Message[],
  activeTurnId: string | null,
  stoppedTurnIds: ReadonlySet<string>,
): string | null {
  const blocksByTurnKey = new Map<string, { readonly type: string }[]>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const turnKey = assistantTurnKey(message);
    const blocks = blocksByTurnKey.get(turnKey);
    if (blocks === undefined) {
      blocksByTurnKey.set(turnKey, [...message.blocks]);
      continue;
    }
    blocks.push(...message.blocks);
  }

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const turnKey = assistantTurnKey(message);
    if (turnKey === activeTurnId) continue;
    const blocks = blocksByTurnKey.get(turnKey) ?? [];
    if (!turnRendersAssistantRow(blocks) && !stoppedTurnIds.has(turnKey)) {
      continue;
    }
    return message.messageId;
  }
  return null;
}
