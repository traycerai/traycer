import type { VerifyStepUpResponse } from "@traycer/protocol/auth/devices-sessions";

const STEP_UP_EXPIRY_SKEW_MS = 5_000;

export class StepUpRequiredError extends Error {
  constructor() {
    super("Step-up verification is required.");
    this.name = "StepUpRequiredError";
  }
}

export interface StepUpCredential {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

export type StepUpCredentialProvider = () => Promise<StepUpCredential>;

export function isStepUpRequiredError(error: unknown): boolean {
  return error instanceof StepUpRequiredError;
}

export function createStepUpCredential(
  response: VerifyStepUpResponse,
  issuedAtMs: number,
): StepUpCredential {
  return {
    accessToken: response.access_token,
    expiresAtMs: issuedAtMs + response.expires_in * 1_000,
  };
}

export function getActiveStepUpCredential(
  credential: StepUpCredential | null,
  nowMs: number,
): StepUpCredential | null {
  if (credential === null) {
    return null;
  }
  return credential.expiresAtMs - STEP_UP_EXPIRY_SKEW_MS > nowMs
    ? credential
    : null;
}

export async function runStepUpProtectedAction<T>(input: {
  readonly getCredential: () => StepUpCredential | null;
  readonly setCredential: (credential: StepUpCredential | null) => void;
  readonly requestCredential: StepUpCredentialProvider;
  readonly action: (accessToken: string | null) => Promise<T>;
}): Promise<T> {
  const activeCredential = input.getCredential();
  try {
    return await input.action(activeCredential?.accessToken ?? null);
  } catch (error) {
    if (!isStepUpRequiredError(error)) {
      throw error;
    }
  }

  input.setCredential(null);
  const credential = await input.requestCredential();
  input.setCredential(credential);
  try {
    return await input.action(credential.accessToken);
  } catch (error) {
    if (isStepUpRequiredError(error)) {
      input.setCredential(null);
    }
    throw error;
  }
}
