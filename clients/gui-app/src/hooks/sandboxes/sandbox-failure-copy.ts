import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_BUSY,
  SANDBOX_REFUSAL_CODE_FROZEN,
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_PROVIDER_FAILED,
  SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE,
  SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED,
  SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT,
  SANDBOX_REFUSAL_CODE_VERB_NOT_AVAILABLE,
} from "@traycer/protocol/host/sandbox-control";
import { formatCredits } from "@/lib/sandboxes/sandbox-pricing";

/** `shape_not_offered`'s `reason`, in words. */
const SHAPE_REASON_COPY: Record<string, string> = {
  "os-not-offered": "That operating system isn't offered yet.",
  "region-not-offered": "That region isn't offered for this size.",
  "cpus-out-of-range": "That vCPU count is outside what's offered.",
  "memory-out-of-range": "That memory size is outside what's offered.",
  "memory-per-cpu-out-of-range":
    "That much memory per vCPU is outside what's offered.",
  "disk-out-of-range": "That disk size is outside what's offered.",
};

function insufficientCreditCopy(
  failure: Extract<SandboxControlFailure, { kind: "refused" }>,
): string {
  if (failure.reason === "unverified") {
    return "Traycer couldn't confirm your credit balance. Try again in a moment.";
  }
  if (failure.reason === "unsupported-subscription") {
    return "Your plan doesn't include sandboxes.";
  }
  // Create, resume and start share one gate (an hour of the new rate on top
  // of what is already awake), so the sentence names no verb.
  return failure.shortfallMc === null
    ? "Your credits don't cover an hour of this sandbox."
    : `Your credits don't cover an hour of this sandbox. Add ${formatCredits(failure.shortfallMc)} credits and try again.`;
}

/**
 * The user-facing sentence for a control-plane failure. Every known code gets
 * this build's copy; an unknown one says the server refused, never the raw
 * code.
 */
export function sandboxFailureMessage(failure: SandboxControlFailure): string {
  if (failure.kind === "unauthorized") {
    return "Sign in again to try that.";
  }
  if (failure.kind === "network-error") {
    return "Couldn't reach Traycer. Try again in a moment.";
  }
  switch (failure.code) {
    case SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT:
      return insufficientCreditCopy(failure);
    case SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED:
      return (
        SHAPE_REASON_COPY[failure.reason ?? ""] ??
        "That size is outside what's offered."
      );
    case SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE:
      return "Sandboxes aren't available right now. Try again later.";
    case SANDBOX_REFUSAL_CODE_PROVIDER_FAILED:
      return "The sandbox failed to start. It's listed as failed; destroy it and try again.";
    case SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT:
      return "This sandbox is changing state. Try again in a moment.";
    case SANDBOX_REFUSAL_CODE_BUSY:
      return "It's in use (an agent turn, a running shell or an open tab), so it stays awake.";
    case SANDBOX_REFUSAL_CODE_FROZEN:
      return "This sandbox is frozen because your credits ran out. Add credits to wake it.";
    case SANDBOX_REFUSAL_CODE_NOT_FOUND:
      return "This sandbox no longer exists.";
    case SANDBOX_REFUSAL_CODE_VERB_NOT_AVAILABLE:
      return "This action isn't available yet.";
    default:
      return "Traycer refused that request.";
  }
}
