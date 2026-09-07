import { log } from "../app/logger";
import type { QuitDecision } from "../../ipc-contracts/app-lifecycle-types";

// `userCancelled` made that false, and widening the union would not have broken a `.then` that never branched: the user's "do not quit" would have quit and discarded their unsynced.

export interface QuitDecisionDeps {
  /** Flush shell state and let the quit proceed. */
  readonly authorizeQuitAfterFlush: () => void;
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

function unhandledQuitDecision(decision: never): Error {
  return new Error(`unhandled quit decision: ${String(decision)}`);
}
