import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliError, CLI_ERROR_CODES } from "../../runner/errors";
import {
  removeStoredSignIn,
  seedStoredSignIn,
} from "../../__tests__/support/stored-sign-in";
import { PROCESS_PROFILE_LOGIN_IO } from "../profile-login";

const helper = vi.hoisted(() => ({
  askWithStoredSignIn: vi.fn(),
}));

vi.mock("../../internal/sign-in-environments", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../internal/sign-in-environments")
  >()),
  askWithStoredSignIn: helper.askWithStoredSignIn,
}));

const REQUEST = {
  operationId: "6f1c1d2e-4c0e-4d7a-9a55-3a1c0d6a8b11",
  environmentId: "environment-1",
  sourceHostId: "host-1",
  sourceSharingGeneration: 1,
  harnessId: "claude-code",
} as const;

let pendingOperations: Promise<unknown>[] = [];

function trackOperation<T>(operation: Promise<T>): Promise<T> {
  pendingOperations.push(operation);
  return operation;
}

function recordSignInRequest(): Promise<unknown> {
  return trackOperation(
    PROCESS_PROFILE_LOGIN_IO.signInRequests.recordSignInRequest(
      REQUEST,
      new AbortController().signal,
    ),
  );
}

beforeEach(async () => {
  pendingOperations = [];
  helper.askWithStoredSignIn.mockReset();
  await seedStoredSignIn("stored-bearer", "member-1");
});

afterEach(async () => {
  await Promise.all(
    pendingOperations.map((operation) =>
      operation.then(
        () => undefined,
        () => undefined,
      ),
    ),
  );
  await removeStoredSignIn();
});

describe("PROCESS_PROFILE_LOGIN_IO.signInRequests.recordSignInRequest rethrows helper errors", () => {
  it("rethrows a non-mapped CliError by identity instead of returning unauthorized", async () => {
    // No real path throws another CliError code today; fake only the helper to pin this catch mapping.
    const error = cliError({
      code: CLI_ERROR_CODES.HOST_UNREACHABLE,
      message: "helper surfaced an unrelated CLI failure",
      details: null,
      exitCode: 1,
    });
    helper.askWithStoredSignIn.mockRejectedValue(error);

    await expect(recordSignInRequest()).rejects.toBe(error);
  });

  it("rethrows a non-CliError from the helper by identity", async () => {
    const error = new Error("helper surfaced a non-CLI failure");
    helper.askWithStoredSignIn.mockRejectedValue(error);

    await expect(recordSignInRequest()).rejects.toBe(error);
  });
});
