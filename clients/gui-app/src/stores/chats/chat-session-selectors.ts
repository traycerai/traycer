import {
  foldRestorableSetupInterruption,
  selectRestorableSetupInterruption as protocolSelectRestorableSetupInterruption,
  type RestorableSetupInterruption,
} from "@traycer/protocol/persistence/chat-transcript/setup-interruption";
import {
  isWindowedTranscript,
  type ChatSessionState,
} from "@/stores/chats/chat-session-store";

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
  state: Pick<
    ChatSessionState,
    "events" | "transcriptDerived" | "transcriptWindow"
  >,
): RestorableSetupInterruption | null {
  // On the windowed line the host has ALREADY answered this over the whole
  // event log, and the scan below could not: a path-less interruption occupies
  // no ordinal, so it is in no row's record set, and `loadRange` - addressed by
  // ordinal - can never ask for it. Anything the client has not been PUSHED it
  // will never obtain.
  //
  // But the host's answer is a snapshot, not a subscription. The event does
  // reach `state.events` when it is appended live - `onEventAppended` ->
  // `takeLiveRecords` -> `appendLiveRecords` seats a record with no ordinal in
  // `window.liveEvents`, and `hydratedRecords` publishes it - so a failure that
  // happens mid-session is visible to this client and simply absent from a
  // derived value computed before it existed. Hence a FOLD: the host's answer
  // is the baseline, and the live appends since are applied over it.
  //
  // Folded over `window.liveEvents` and deliberately NOT over `state.events`.
  // On this line that array also holds HYDRATED events, whose clearing
  // successors may never have been fetched - so scanning it would resurrect an
  // interruption the host already knows a retry cleared, and restore a draft
  // the user never lost. The live-append list is post-snapshot by construction.
  //
  // Not a `??` chain either: `restorableSetupInterruption: null` INSIDE a
  // derived payload is a real answer - "nothing to restore", the ordinary case
  // - not a missing one. Falling through to the whole-array scan on it would
  // re-run, on every ordinary chat, precisely the scan that cannot see the
  // event.
  if (isWindowedTranscript(state)) {
    return foldRestorableSetupInterruption({
      baseline: state.transcriptDerived.restorableSetupInterruption,
      laterEvents: state.transcriptWindow.liveEvents,
    });
  }
  return protocolSelectRestorableSetupInterruption(state.events);
}
