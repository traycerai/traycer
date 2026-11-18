import { log } from "../app/logger";
import type { QuitDecision } from "../../ipc-contracts/app-lifecycle-types";

// What main does with the renderer's answer to the quit intercept. Extracted
// from the inline `before-quit` handler for the same reason
// `runUpdateInstallQuitSequence` was (see `update-install-quit.ts`): the
// contract is which decisions quit and which do not, and inline in an
// Electron-heavy closure that is not directly assertable.
//
// The extraction is also the fix's enforcement. This used to be
//
//   .then((decision) => { log.info("...", { decision }); authorizeQuitAfterFlush(); })
//
// where `decision` reached nothing but a log line - correct only while every
// decision meant "quit". `userCancelled` made that false, and widening the
// union would not have broken a `.then` that never branched: the user's "do
// not quit" would have quit and discarded their unsynced edits. A `switch`
// with a `never` arm turns the next member into a compile error here instead.

export interface QuitDecisionDeps {
  /** Flush shell state and let the quit proceed. */
  readonly authorizeQuitAfterFlush: () => void;
  /**
   * Abandon the quit and leave the app running.
   *
   * In production this is `quitState.resetQuitting()` and nothing else, which
   * matches both the update arm's `stayOpen` and this arm's own failure path.
   * The `before-quit` handler has already called `preventDefault()` and closed
   * no window, so there is nothing else to undo - and unlike the update arm
   * there is no first-pass flag left set that would let the NEXT quit take a
   * shortcut past the interception.
   */
  readonly stayOpen: () => void;
}

export function applyQuitDecision(
  decision: QuitDecision,
  deps: QuitDecisionDeps,
): void {
  switch (decision) {
    case "proceed":
    case "userConfirmedDiscard":
      log.info("[desktop] quit decision resolved", { decision });
      deps.authorizeQuitAfterFlush();
      return;
    case "userCancelled":
      log.info("[desktop] quit declined by the user - staying alive");
      deps.stayOpen();
      return;
    default:
      // Thrown, not swallowed: the caller's `.catch` already stays alive on a
      // failed decision, which is the safe direction for an answer nothing
      // here understood. Returning instead would leave main waiting for ever.
      throw unhandledQuitDecision(decision);
  }
}

/**
 * The `never` parameter is what makes a new {@link QuitDecision} member a build
 * failure at the switch above rather than a silent fall-through to "quit".
 */
function unhandledQuitDecision(decision: never): Error {
  return new Error(`unhandled quit decision: ${String(decision)}`);
}
