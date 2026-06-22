import type { ChatEvent } from "@traycer/protocol/persistence/epic/schemas";
import {
  readMetadataNumber,
  readMetadataString,
} from "@/lib/chat/event-metadata";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";

/**
 * Composer-facing projections of the worktree-aware chat event stream.
 *
 * Each selector returns the most recent matching event by array order. The
 * host writes events in append order, so the last entry of a given type wins
 * when the chain alternates (e.g. a `setup.running` retry supersedes an earlier
 * `setup.failed`). The in-transcript setup card derives its own per-lifecycle
 * view-model from the same stream (see `buildSetupCardRows`); these selectors
 * remain for the composer-restore and missing-worktree flows only.
 */

export interface RestorableSetupInterruptionSelection {
  readonly event: ChatEvent;
  readonly workspacePath: string | null;
  readonly terminalSessionId: string | null;
  readonly setupExitCode: number | null;
  readonly clientActionId: string | null;
  readonly messageId: string | null;
}

/**
 * Most recent setup interruption carrying a `messageId` (the gating-path
 * emission) and not cleared by a later retry/success for the same workspace.
 * Drives composer restore for setup failures and stop-during-setup
 * cancellations.
 *
 * The orchestrator's binding-change observer also emits a transition-only
 * setup event for the same lifecycle transition with
 * `messageId: null`. That event is fine for banners but is not
 * restorable: it has no triggering send to put back. Selecting strictly
 * the latest setup event would let a transition-only emission hide
 * the restorable one. This selector skips `messageId === null` entries
 * so the gating event remains discoverable regardless of arrival order.
 * A duplicate setup event does not clear restorable state, since it
 * represents the same interruption the gating event already owns.
 */
export function selectRestorableSetupInterruption(
  state: Pick<ChatSessionState, "events">,
): RestorableSetupInterruptionSelection | null {
  const events = state.events;
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
      event,
      workspacePath,
      terminalSessionId: readMetadataString(event, "terminalSessionId"),
      setupExitCode: readMetadataNumber(event, "setupExitCode"),
      clientActionId: event.clientActionId,
      messageId: event.messageId,
    };
  }
  return null;
}

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

function hasSubsequentEvent(
  events: ReadonlyArray<ChatEvent>,
  fromIndex: number,
  workspacePath: string | null,
  matchTypes: ReadonlySet<ChatEvent["type"]>,
): boolean {
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

const hasSubsequentRestoreClearingEvent = (
  events: ReadonlyArray<ChatEvent>,
  fromIndex: number,
  workspacePath: string | null,
  candidateType: ChatEvent["type"],
): boolean =>
  hasSubsequentEvent(
    events,
    fromIndex,
    workspacePath,
    candidateType === "setup.cancelled"
      ? RESTORE_CLEARING_EVENT_TYPES_WITHOUT_CANCELLED
      : RESTORE_CLEARING_EVENT_TYPES,
  );
