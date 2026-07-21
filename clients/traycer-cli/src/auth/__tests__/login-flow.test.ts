import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { runDeviceAuthFlow } from "../login-flow";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import { config } from "../../config";
import {
  startDeviceAuthorization,
  pollDeviceToken,
  type DeviceAuthorizationResult,
} from "../../../../shared/auth/device-auth";
import { validateAuthTokenIdentityAccessOnly } from "../../../../shared/auth/auth-validation";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";

// `traycer login` (interactive device flow) migrated to §7: after the device
// poll mints a pair, validate it ACCESS-ONLY (no refresh — a minted token that
// fails is a genuine rejection) and persist through the locked store's `signIn`.
// Mock only the device-flow transport + the access probe + the store helpers
// (`runWithCliStore`/`withCommitRetry`, which call `createCliCredentialsStore`
// intra-module) + node `spawn` (so the best-effort browser open never launches a
// real browser). Keep the pure identity projection real.
const { fakeStore, signInMock } = vi.hoisted(() => {
  const signInMock = vi.fn();
  return {
    signInMock,
    fakeStore: {
      read: vi.fn(),
      rotate: vi.fn(),
      signIn: signInMock,
      signOut: vi.fn(),
      updateProfile: vi.fn(),
      guardedSignIn: vi.fn(),
      migrateFirstWrite: vi.fn(),
      hasPendingContinuation: () => false,
      dispose: vi.fn(),
    },
  };
});

vi.mock("../../../../shared/auth/device-auth", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/device-auth")
    >();
  return {
    ...actual,
    startDeviceAuthorization: vi.fn(),
    pollDeviceToken: vi.fn(),
  };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return { ...actual, validateAuthTokenIdentityAccessOnly: vi.fn() };
});

vi.mock("../../store/credentials-store", () => ({
  createCliCredentialsStore: () => fakeStore,
  runWithCliStore: (fn: (store: unknown) => unknown) => fn(fakeStore),
  withCommitRetry: (op: () => unknown) => op(),
}));

// The best-effort browser open must never spawn a real process in tests.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
  };
});

const startAuthMock = vi.mocked(startDeviceAuthorization);
const pollMock = vi.mocked(pollDeviceToken);
const identityMock = vi.mocked(validateAuthTokenIdentityAccessOnly);

function makeCtx(): CommandContext {
  const runtime: RuntimeContext = {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
  return {
    runtime,
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

function userWith(id: string, email: string, name: string): AuthenticatedUser {
  const base = createAuthenticatedUserFixture(undefined);
  return { ...base, user: { ...base.user, id, email, name } };
}

const signedInUser = userWith("u1", "ada@traycer.ai", "Ada");

// `intervalSeconds: 0` → the poll loop's pre-poll sleep is immediate, so a single
// mocked `authorized` poll resolves the flow without any real wait.
const authorizedDevice: DeviceAuthorizationResult = {
  kind: "started",
  deviceCode: "device-code",
  userCode: "ABCD-1234",
  verificationUri: "https://app.traycer.ai/device",
  verificationUriComplete: "https://app.traycer.ai/device?code=ABCD-1234",
  intervalSeconds: 0,
  expiresInSeconds: 3600,
};

beforeEach(() => {
  vi.clearAllMocks();
  // The poll loop sleeps the (RFC 8628-clamped, ~5s) interval before its first
  // poll; fake timers let each test advance past it instead of really waiting.
  vi.useFakeTimers();
  startAuthMock.mockResolvedValue(authorizedDevice);
  pollMock.mockResolvedValue({
    kind: "authorized",
    token: "minted-bearer",
    refreshToken: "minted-refresh",
  });
  identityMock.mockResolvedValue({ kind: "valid", user: signedInUser });
  signInMock.mockResolvedValue({ outcome: "applied", credentials: null });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("runDeviceAuthFlow", () => {
  it("validates the minted pair access-only, signs in via the locked store, and returns the user", async () => {
    const promise = runDeviceAuthFlow(makeCtx());
    // Advance past the pre-poll interval sleep so the single mocked `authorized`
    // poll resolves the flow.
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    // The freshly-minted access token is validated WITHOUT a refresh.
    expect(identityMock).toHaveBeenCalledWith(
      expect.any(String),
      "minted-bearer",
    );
    expect(signInMock).toHaveBeenCalledTimes(1);
    const credentials = signInMock.mock.calls[0][0];
    expect(credentials.token).toBe("minted-bearer");
    expect(credentials.refreshToken).toBe("minted-refresh");
    expect(credentials.user).toEqual({
      id: "u1",
      email: "ada@traycer.ai",
      name: "Ada",
    });
    // `signIn` is unconditional (clears any tombstone) — an interactive sign-in
    // always carries a fresh refresh token, so it never asks the locked store
    // to preserve the on-disk one.
    expect(signInMock.mock.calls[0][1]).toBe(false);
    expect(signInMock.mock.calls[0][2]).toBeNull();
    expect(result).toEqual({
      token: "minted-bearer",
      user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
      authnBaseUrl: config.authnBaseUrl,
    });
  });

  it("throws UNEXPECTED when the store cannot persist the sign-in", async () => {
    signInMock.mockResolvedValue({
      outcome: "commit-failed",
      credentials: null,
    });
    const promise = runDeviceAuthFlow(makeCtx()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await promise;
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.UNEXPECTED);
  });

  it("throws AUTH_REJECTED without signing in when the minted token fails validation", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    const promise = runDeviceAuthFlow(makeCtx()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await promise;
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.AUTH_REJECTED);
    // A minted-but-rejected token is a genuine rejection, not an expiry to spend
    // past — no refresh, no store write.
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("throws AUTH_NETWORK without polling when device authorization cannot reach authn", async () => {
    startAuthMock.mockResolvedValue({ kind: "network-error" });
    const err = await runDeviceAuthFlow(makeCtx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.AUTH_NETWORK);
    expect(pollMock).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
  });
});
