import { isStepUpRequiredError, type StepUpCredential } from "./step-up-flow";

export const STEP_UP_CODE_LENGTH = 6;

/**
 * Which action is being re-authenticated. Only the dialog's copy varies - the
 * challenge/verify round trip is identical - but the copy is what tells the user
 * WHY a code was suddenly demanded, which matters most for `host-provision`:
 * that one is raised by a background host connection rather than by a button the
 * user just pressed.
 */
export type StepUpPromptPurpose =
  "session-revoke" | "global-revoke" | "host-provision";

export interface StepUpPromptRequest {
  readonly id: number;
  readonly purpose: StepUpPromptPurpose;
  /** Names the machine for `host-provision`; `null` for account-wide actions. */
  readonly subjectLabel: string | null;
  readonly resolve: (credential: StepUpCredential) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Raised when the user dismisses the dialog rather than verifying. Distinct
 * from a failure: host provisioning treats it as a deliberate decline and stops
 * asking, instead of retrying as it would after a transport error.
 */
export class StepUpCanceledError extends Error {
  constructor() {
    super("Verification canceled.");
    this.name = "StepUpCanceledError";
  }
}

export function isStepUpCanceledError(error: unknown): boolean {
  return error instanceof StepUpCanceledError;
}

export function normalizeStepUpCodeInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, STEP_UP_CODE_LENGTH);
}

export function messageFromError(error: unknown): string {
  if (isStepUpRequiredError(error)) {
    return "Verification expired. Try again.";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Action failed. Try again.";
}
