import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_BUSY,
  SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_ENVIRONMENT_UNAVAILABLE,
  SANDBOX_REFUSAL_CODE_FROZEN,
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_PROVIDER_FAILED,
  SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE,
  SANDBOX_REFUSAL_CODE_RENAME_UNAVAILABLE,
  SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED,
  SANDBOX_REFUSAL_CODE_TEAM_PODS_FULL,
  SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT,
  SANDBOX_REFUSAL_CODE_VERB_NOT_AVAILABLE,
} from "@traycer/protocol/host/sandbox-control";
import { formatCreditsRequired } from "@/lib/sandboxes/sandbox-pricing";
import {
  SANDBOX_CREATE_ENVIRONMENT_UNAVAILABLE_LINE,
  sandboxNotAMemberLine,
} from "@/components/hosts/sandbox-create-model";

/** Keep the control-plane refusal available to the row and its diagnostics. */
export class SandboxOperationError extends Error {
  constructor(readonly failure: SandboxControlFailure) {
    super(sandboxFailureMessage(failure));
    this.name = "SandboxOperationError";
  }
}

/** `shape_not_offered`'s `reason`, in words. */
const SHAPE_REASON_COPY: Record<string, string> = {
  "os-not-offered": "That operating system isn't offered yet.",
  "region-not-offered": "That region isn't offered for this size.",
  "cpus-out-of-range": "That vCPU count is outside what's offered.",
  "memory-out-of-range": "That memory size is outside what's offered.",
  "memory-per-cpu-out-of-range":
    "That much memory per vCPU is outside what's offered.",
  "disk-out-of-range": "That disk size is outside what's offered.",
  "provider-plan-too-small":
    "This account's sandbox plan can't run a sandbox yet.",
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
  let pot = "Your credits";
  if (failure.creditSource === "team-allowance") pot = "Your team allowance";
  if (failure.creditSource === "team") pot = "The team's credits";
  const cover = failure.creditSource === "team-allowance" ? "doesn't" : "don't";
  const sentence = `${pot} ${cover} cover an hour of this sandbox.`;
  return failure.shortfallMc === null
    ? sentence
    : `${sentence} Add $${formatCreditsRequired(failure.shortfallMc)} and try again.`;
}

/** The refusals whose sentence depends on nothing but the code. */
const REFUSAL_COPY: ReadonlyMap<string, string> = new Map([
  [
    SANDBOX_REFUSAL_CODE_RENAME_UNAVAILABLE,
    "Couldn't rename the sandbox. Try again in a moment.",
  ],
  [
    SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE,
    "Sandboxes aren't available right now. Try again later.",
  ],
  [
    SANDBOX_REFUSAL_CODE_PROVIDER_FAILED,
    "The sandbox failed to start. It's listed as failed; destroy it and try again.",
  ],
  [
    SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT,
    "This sandbox is changing state. Try again in a moment.",
  ],
  [
    SANDBOX_REFUSAL_CODE_BUSY,
    "It's in use (an agent turn, a running shell or an open tab), so it stays awake.",
  ],
  [
    SANDBOX_REFUSAL_CODE_FROZEN,
    "This sandbox is frozen because your credits ran out. Add credits to wake it.",
  ],
  [SANDBOX_REFUSAL_CODE_NOT_FOUND, "This sandbox no longer exists."],
  [SANDBOX_REFUSAL_CODE_VERB_NOT_AVAILABLE, "This action isn't available yet."],
]);

/**
 * The user-facing sentence for a control-plane failure. Every known code gets
 * this build's copy; an unknown one says the server refused, never the raw
 * code.
 */
export function sandboxFailureMessage(failure: SandboxControlFailure): string {
  if (failure.kind === "unauthorized") {
    return "Sign in again to try that.";
  }
  if (failure.kind === "unavailable") {
    return failure.reason;
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
    // The server names the team and its admins; its sentence is the copy.
    case SANDBOX_REFUSAL_CODE_TEAM_PODS_FULL:
      return failure.message !== null && failure.message.length > 0
        ? failure.message
        : "Every team pod is full; ask an admin to add one.";
    default:
      return REFUSAL_COPY.get(failure.code) ?? "Traycer refused that request.";
  }
}

/**
 * A create's failure in words. A team create the
 * server refuses as `environment_not_found` names the team the person picked
 * (`teamName`), since the server names none; `environment_unavailable` says
 * where the check failed. Everything else is {@link sandboxFailureMessage}.
 */
export function sandboxCreateFailureMessage(
  failure: SandboxControlFailure,
  teamName: string | null,
): string {
  if (failure.kind === "refused") {
    if (
      failure.code === SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND &&
      teamName !== null
    ) {
      return sandboxNotAMemberLine(teamName);
    }
    if (failure.code === SANDBOX_REFUSAL_CODE_ENVIRONMENT_UNAVAILABLE) {
      return SANDBOX_CREATE_ENVIRONMENT_UNAVAILABLE_LINE;
    }
  }
  return sandboxFailureMessage(failure);
}
