import type { RetainedStepUpVerifyResponse } from "@traycer-clients/shared/auth/devices-sessions-fetcher";

const STEP_UP_EXPIRY_SKEW_MS = 5_000;

export class StepUpRequiredError extends Error {
  constructor() {
    super("Step-up verification is required.");
    this.name = "StepUpRequiredError";
  }
}

export interface StepUpCredential {
  readonly expiresAtMs: number;
}

export type StepUpCredentialProvider = () => Promise<StepUpCredential>;

export function isStepUpRequiredError(error: unknown): boolean {
  return error instanceof StepUpRequiredError;
}

export function createStepUpCredential(
  response: RetainedStepUpVerifyResponse,
  issuedAtMs: number,
): StepUpCredential {
  const usableTtlMs = Math.max(
    0,
    response.expires_in * 1_000 - STEP_UP_EXPIRY_SKEW_MS,
  );
  return {
    expiresAtMs: issuedAtMs + usableTtlMs,
  };
}

export function getActiveStepUpCredential(
  credential: StepUpCredential | null,
  nowMs: number,
): StepUpCredential | null {
  if (credential === null) {
    return null;
  }
  return credential.expiresAtMs > nowMs ? credential : null;
}

export async function runStepUpProtectedAction<T>(input: {
  readonly getCredential: () => StepUpCredential | null;
  readonly setCredential: (credential: StepUpCredential | null) => void;
  readonly requestCredential: StepUpCredentialProvider;
  readonly action: (useStepUpCredential: boolean) => Promise<T>;
  readonly nowMs: () => number;
}): Promise<T> {
  const activeCredential = getActiveStepUpCredential(
    input.getCredential(),
    input.nowMs(),
  );
  try {
    return await input.action(activeCredential !== null);
  } catch (error) {
    if (!isStepUpRequiredError(error)) {
      throw error;
    }
  }

  input.setCredential(null);
  const credential = await input.requestCredential();
  input.setCredential(credential);
  try {
    return await input.action(true);
  } catch (error) {
    if (isStepUpRequiredError(error)) {
      input.setCredential(null);
    }
    throw error;
  }
}
