import { z } from "zod";

import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import { readMetadataNumber, readMetadataString } from "@traycer/protocol/persistence/chat-transcript/event-metadata";

/**
 * # The setup interruption the composer restores a draft from
 *
 * A setup failure or cancellation the composer can put a draft back from, and
 * the rule for finding it. Shared code because three parties must agree: the
 * renderer computing it for itself against a legacy peer, the host deriving it
 * for a windowed client, and the publisher writing the same answer into a
 * published head.
 *
 * ## Why the HOST derives it at all
 *
 * The event it comes from OCCUPIES NO ORDINAL. `partitionSetupCardWindows`
 * skips a path-less `setup.failed` deliberately - it can neither name a
 * workspace nor drive a retry, so it forms no card - and the host and the
 * renderer agree about that by sharing the same partition. What neither
 * noticed is that this selection reads the SAME event straight off the full
 * array, for a purpose that has nothing to do with rows.
 *
 * A row-less event is in no row's record set, so `sliceTranscriptTail` never
 * includes it and `loadRange` - addressed by ordinal - can never ask for it. On
 * the windowed line it is not "evicted and refetchable", it is unreachable
 * outright, and the composer would silently stop restoring drafts after a setup
 * failure. So it ships as what it always was: chat-level aux state.
 *
 * The general rule this settles: **an event the client reads but no row renders
 * must ride the snapshot.** Ordinals address rows; anything outside that space
 * needs its own carriage.
 *
 * ## Why the SELECTION is here rather than restated per consumer
 *
 * It was restated per consumer for exactly one round, and that is the pattern
 * this directory exists to stop: `eventMaterializesTranscriptRow` shipped with
 * a copy of its condition in the renderer that disagreed on the empty string.
 * A rule two parties can disagree about does not get two implementations, even
 * when both are small and both are correct today.
 */

export const restorableSetupInterruptionSchema = z.object({
  eventType: z.enum(["setup.failed", "setup.cancelled"]),
  /**
   * The event's own id, and the only field here that is not read for display.
   *
   * The composer-restore driver dedupes on it: a stale snapshot, or a
   * `setup.failed` echoed across a reconnect, must not re-restore a draft the
   * user may have edited since. Without it a windowed client has no stable key
   * for that guard - the interruption arrives as a value on every snapshot, so
   * "have I already acted on this one" is otherwise unanswerable.
   */
  eventId: z.string(),
  /** `null` for the generic path-less failure - the case that has no card. */
  workspacePath: z.string().nullable(),
  terminalSessionId: z.string().nullable(),
  setupExitCode: z.number().nullable(),
  clientActionId: z.string().nullable(),
  /** Never null: an interruption with no triggering send is not restorable. */
  messageId: z.string(),
});
export type RestorableSetupInterruption = z.infer<
  typeof restorableSetupInterruptionSchema
>;

const RESTORABLE_SETUP_INTERRUPTION_EVENT_TYPES: ReadonlySet<
  ChatEvent["type"]
> = new Set(["setup.failed", "setup.cancelled"]);

const RESTORE_CLEARING_EVENT_TYPES: ReadonlySet<ChatEvent["type"]> = new Set([
  "setup.running",
  "setup.succeeded",
  "setup.cancelled",
]);

const RESTORE_CLEARING_EVENT_TYPES_WITHOUT_CANCELLED: ReadonlySet<
  ChatEvent["type"]
> = new Set(["setup.running", "setup.succeeded"]);

function hasSubsequentRestoreClearingEvent(
  events: readonly ChatEvent[],
  fromIndex: number,
  workspacePath: string | null,
  candidateType: ChatEvent["type"],
): boolean {
  // A `setup.cancelled` is not cleared by another `setup.cancelled`: a repeat
  // describes the same interruption the first one already owns.
  const matchTypes =
    candidateType === "setup.cancelled"
      ? RESTORE_CLEARING_EVENT_TYPES_WITHOUT_CANCELLED
      : RESTORE_CLEARING_EVENT_TYPES;
  for (let index = fromIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (
      matchTypes.has(event.type) &&
      readMetadataString(event, "workspacePath") === workspacePath
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The most recent setup interruption carrying a `messageId` (the gating-path
 * emission) and not cleared by a later retry or success for the same workspace.
 *
 * The orchestrator's binding-change observer also emits a transition-only twin
 * of the same lifecycle transition with `messageId: null`. That event is fine
 * for a banner but is not restorable - there is no triggering send to put
 * back - so selecting strictly the latest setup event would let the twin hide
 * the gating one whenever it arrived later. Entries with no `messageId` are
 * skipped, which keeps the gating event discoverable regardless of arrival
 * order.
 *
 * `null` when there is no restorable interruption, which is the ordinary case.
 */
export function selectRestorableSetupInterruption(
  events: readonly ChatEvent[],
): RestorableSetupInterruption | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!RESTORABLE_SETUP_INTERRUPTION_EVENT_TYPES.has(event.type)) continue;
    if (event.messageId === null) continue;
    const workspacePath = readMetadataString(event, "workspacePath");
    if (
      hasSubsequentRestoreClearingEvent(
        events,
        index,
        workspacePath,
        event.type,
      )
    ) {
      continue;
    }
    return {
      // Narrowed by the set membership above; restated as a literal because
      // `ChatEvent["type"]` is wider than the two this shape admits.
      eventType:
        event.type === "setup.cancelled" ? "setup.cancelled" : "setup.failed",
      eventId: event.eventId,
      workspacePath,
      terminalSessionId: readMetadataString(event, "terminalSessionId"),
      setupExitCode: readMetadataNumber(event, "setupExitCode"),
      clientActionId: event.clientActionId,
      messageId: event.messageId,
    };
  }
  return null;
}
