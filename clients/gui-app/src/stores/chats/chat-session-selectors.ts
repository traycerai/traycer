import {
  selectRestorableSetupInterruption as protocolSelectRestorableSetupInterruption,
  type RestorableSetupInterruption,
} from "@traycer/protocol/persistence/chat-transcript/setup-interruption";
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

export type { RestorableSetupInterruption };

/**
 * Most recent setup interruption carrying a `messageId` (the gating-path
 * emission) and not cleared by a later retry/success for the same workspace.
 * Drives composer restore for setup failures and stop-during-setup
 * cancellations.
 *
 * A STORE-SHAPED adapter over the shared derivation, not a second copy of it.
 * The rule itself lives in
 * `@traycer/protocol/persistence/chat-transcript/setup-interruption`, because
 * on the windowed `chat.subscribe` line the HOST computes this answer and ships
 * it on the snapshot: the event it comes from occupies no ordinal, so a
 * windowed client can never fetch it and could not run this scan even if it
 * wanted to. Two implementations of one rule is what that module's doc exists
 * to prevent - see the empty-string disagreement it cites.
 *
 * This wrapper keeps the call sites' `(state)` shape so the store's own tests
 * and `useChatSetupFailureRestoreDriver` read the same way they always have.
 */
export function selectRestorableSetupInterruption(
  state: Pick<ChatSessionState, "events" | "transcriptDerived">,
): RestorableSetupInterruption | null {
  // On the windowed line the host has ALREADY answered this, and the scan below
  // could not answer it at any amount of hydration: the event occupies no
  // ordinal, so it is in no row's record set and `state.events` never receives
  // it. This is the one consumer in the sweep with no client-side repair.
  //
  // `transcriptDerived !== null` IS the line check, and the reason this is not
  // a `??` chain: `restorableSetupInterruption: null` INSIDE a derived payload
  // is a real answer - "nothing to restore", the ordinary case - not a missing
  // one. Falling through to the scan on it would re-run, on every ordinary
  // chat, precisely the scan that cannot see the event.
  if (state.transcriptDerived !== null) {
    return state.transcriptDerived.restorableSetupInterruption;
  }
  return protocolSelectRestorableSetupInterruption(state.events);
}
