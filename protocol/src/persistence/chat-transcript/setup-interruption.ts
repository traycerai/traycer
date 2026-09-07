import { z } from "zod";

import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import {
  readMetadataNumber,
  readMetadataString,
} from "@traycer/protocol/persistence/chat-transcript/event-metadata";

/**
 * A setup failure or cancellation the composer can put a draft back from, and the rule for finding it.
 * A row-less event is in no row's record set, so `sliceTranscriptTail` never includes it and `loadRange` - addressed by ordinal - can never ask for it.
 */

export const restorableSetupInterruptionSchema = z.object({
  eventType: z.enum(["setup.failed", "setup.cancelled"]),
  /**
   * The event's own id, and the only field here that is not read for display.
   * The composer-restore driver dedupes on it: a stale snapshot, or a `setup.failed` echoed across a reconnect, must not re-restore a draft the user may have edited since.
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
 * The most recent setup interruption carrying a `messageId` (the gating-path emission) and not cleared by a later retry or success for the same workspace.
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

/** The same answer, brought forward over events that arrived AFTER the one that produced `baseline`. */
export function foldRestorableSetupInterruption(input: {
  readonly baseline: RestorableSetupInterruption | null;
  readonly laterEvents: readonly ChatEvent[];
}): RestorableSetupInterruption | null {
  const { baseline, laterEvents } = input;
  const later = selectRestorableSetupInterruption(laterEvents);
  if (later !== null) return later;
  if (baseline === null) return null;
  // No later interruption, so the only question left is whether one of these events cleared the baseline.
  return hasSubsequentRestoreClearingEvent(
    laterEvents,
    -1,
    baseline.workspacePath,
    baseline.eventType,
  )
    ? null
    : baseline;
}
