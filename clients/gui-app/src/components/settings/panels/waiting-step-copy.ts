import type { ProviderLoginStartCopy } from "@/components/providers/provider-login-start";
import type { ProviderProfileLoginFlowCodePastePhase } from "./use-provider-profile-login-flow";

export interface WaitingStepCopy {
  readonly title: string;
  /** `null` when the header alone says everything worth saying (e.g. while
   *  verifying a submitted code) - callers should render no guidance line. */
  readonly guidance: string | null;
}

/**
 * Shared header/guidance copy for the waiting step's phase (statefulness
 * fixup): both the add-profile dialog/Settings reauth panel's full step and
 * the in-chat banner's compact row derive their title text from this, so a
 * provider's real exchange-verification window ("verifying") always reads
 * the same way instead of leaving the generic "waiting for browser sign-in"
 * header showing while the paste field sits locked with nothing left to do
 * in the browser.
 */
export function waitingStepCopy(args: {
  readonly phase: ProviderProfileLoginFlowCodePastePhase;
  readonly queuePending: boolean;
  /**
   * What to say instead of "Opening the sign-in page…" while `queuePending`,
   * when the start is taking longer than a moment (the flow's
   * `startingCopy`). Null for the ordinary start, and for a caller that is
   * already past it.
   */
  readonly startingCopy: ProviderLoginStartCopy | null;
  readonly cancelRequested: boolean;
  readonly deviceCode: boolean;
}): WaitingStepCopy {
  if (args.cancelRequested) {
    return {
      title: "Cancelling sign-in",
      guidance:
        "Waiting for the sign-in attempt to start so it can be cancelled safely.",
    };
  }
  if (args.queuePending) {
    return (
      args.startingCopy ?? {
        title: "Opening the sign-in page…",
        guidance: "This should only take a moment.",
      }
    );
  }
  if (args.phase === "submitting") {
    return { title: "Sending the code…", guidance: null };
  }
  if (args.phase === "verifying") {
    return {
      title: "Checking approval…",
      guidance: null,
    };
  }
  if (args.deviceCode) {
    return {
      title: "Approve sign-in in your browser",
      guidance:
        "Open the page, enter this code, then return here. We'll continue automatically after you approve.",
    };
  }
  return {
    title: "Approve sign-in in your browser",
    guidance:
      "We opened the sign-in page in your browser. We'll continue automatically after you approve.",
  };
}
