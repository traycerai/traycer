import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { buildLoginCommand } from "../login";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import { validateAuthTokenIdentityAccessOnly } from "../../../../shared/auth/auth-validation";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";

// `login --token -` is access-only + fail-fast (§7): validate the piped access
// token WITHOUT a refresh fallback, then persist through the locked store. Keep
// the real (pure) identity projection, stub the network probe, and inject a fake
// store through the store-facing helpers the command imports directly. Mocking
// `createCliCredentialsStore` alone would NOT work: `runWithCliStore` calls it
// intra-module, so that call binds to the real function - so we mock the helpers
// (`runWithCliStore` / `withCommitRetry`) the command actually imports.
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

const identityMock = vi.mocked(validateAuthTokenIdentityAccessOnly);

function makeRuntime(overrides: Partial<RuntimeContext>): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
    ...overrides,
  };
}

function makeCtx(runtime: RuntimeContext): CommandContext {
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

const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");

function stubStdin(value: { isTTY: boolean; chunks: string[] }): void {
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: {
      isTTY: value.isTTY,
      async *[Symbol.asyncIterator]() {
        for (const chunk of value.chunks) yield Buffer.from(chunk);
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  identityMock.mockResolvedValue({ kind: "valid", user: signedInUser });
  signInMock.mockResolvedValue({ outcome: "applied", credentials: null });
});

afterEach(() => {
  vi.clearAllMocks();
  if (realStdin !== undefined) {
    Object.defineProperty(process, "stdin", realStdin);
  }
});

describe("buildLoginCommand with --token", () => {
  it("validates the piped token access-only, signs in, and reports the user", async () => {
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ token: "captured-bearer", refreshToken: "" })],
    });
    const fn = buildLoginCommand({ token: "-" });
    const result = await fn(makeCtx(makeRuntime({})));

    expect(identityMock).toHaveBeenCalledWith(
      expect.any(String),
      "captured-bearer",
    );
    expect(signInMock).toHaveBeenCalledTimes(1);
    const credentials = signInMock.mock.calls[0][0];
    expect(credentials.token).toBe("captured-bearer");
    expect(credentials.user).toEqual({
      id: "u1",
      email: "ada@traycer.ai",
      name: "Ada",
    });
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
      bootstrap: null,
    });
  });

  it("fails fast on an expired/invalid access token without spending (AUTH_REJECTED)", async () => {
    identityMock.mockResolvedValue({ kind: "rejected" });
    stubStdin({
      isTTY: false,
      chunks: [
        JSON.stringify({ token: "expired-bearer", refreshToken: "some-rt" }),
      ],
    });
    const fn = buildLoginCommand({ token: "-" });
    const err = await fn(makeCtx(makeRuntime({}))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.AUTH_REJECTED);
    expect((err as CliError).exitCode).toBe(1);
    // Fail-fast: never route the expired access token through a spend.
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("persists the paired refresh token from the stdin JSON payload", async () => {
    stubStdin({
      isTTY: false,
      chunks: [
        JSON.stringify({ token: "bearer", refreshToken: "new-refresh" }),
      ],
    });
    const fn = buildLoginCommand({ token: "-" });
    await fn(makeCtx(makeRuntime({})));

    expect(identityMock).toHaveBeenCalledWith(expect.any(String), "bearer");
    expect(signInMock.mock.calls[0][0].refreshToken).toBe("new-refresh");
    // Always requested even when a fresh refresh token is present - it only
    // takes effect on a blank one - so the CLI need not branch on this.
    expect(signInMock.mock.calls[0][1]).toBe(true);
  });

  it("signs in with a blank refresh token + preserveRefreshTokenIfBlank when the stdin payload carries none", async () => {
    // A bare-bearer re-seed must NOT resolve "keep the on-disk refresh token"
    // itself (that pre-lock read/write raced a concurrent rotate); it hands the
    // empty string plus `preserveRefreshTokenIfBlank: true` to the locked
    // `signIn`, which resolves it under the same lock that performs the write.
    // The actual preservation mechanics are covered at the store level in
    // credentials-mutation.test.ts.
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ token: "rotated-bearer", refreshToken: "" })],
    });
    const fn = buildLoginCommand({ token: "-" });
    await fn(makeCtx(makeRuntime({})));

    expect(signInMock.mock.calls[0][0].token).toBe("rotated-bearer");
    expect(signInMock.mock.calls[0][0].refreshToken).toBe("");
    expect(signInMock.mock.calls[0][1]).toBe(true);
  });

  it("surfaces a persistence failure (UNEXPECTED) when the store cannot commit", async () => {
    signInMock.mockResolvedValue({
      outcome: "commit-failed",
      credentials: null,
    });
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ token: "bearer", refreshToken: "rt" })],
    });
    const fn = buildLoginCommand({ token: "-" });
    const err = await fn(makeCtx(makeRuntime({}))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.UNEXPECTED);
  });

  it("rejects a literal --token value without reading stdin or validating (INVALID_ARGUMENT)", async () => {
    const fn = buildLoginCommand({ token: "captured-bearer" });
    const err = await fn(makeCtx(makeRuntime({}))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect((err as CliError).exitCode).toBe(1);
    expect(identityMock).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("maps an unreachable authn service to AUTH_NETWORK (exit 2)", async () => {
    identityMock.mockResolvedValue({ kind: "network-error" });
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ token: "x", refreshToken: "" })],
    });
    const fn = buildLoginCommand({ token: "-" });
    const err = await fn(makeCtx(makeRuntime({}))).catch((e: unknown) => e);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.AUTH_NETWORK);
    expect((err as CliError).exitCode).toBe(2);
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("reads the token from stdin for --token -", async () => {
    stubStdin({ isTTY: false, chunks: ["piped-bearer\n"] });
    const fn = buildLoginCommand({ token: "-" });
    await fn(makeCtx(makeRuntime({})));
    // Trailing newline is trimmed before validation.
    expect(identityMock).toHaveBeenCalledWith(
      expect.any(String),
      "piped-bearer",
    );
  });

  it("rejects --token - with no piped input (INVALID_ARGUMENT)", async () => {
    stubStdin({ isTTY: false, chunks: ["   \n"] });
    const fn = buildLoginCommand({ token: "-" });
    const err = await fn(makeCtx(makeRuntime({}))).catch((e: unknown) => e);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(identityMock).not.toHaveBeenCalled();
  });

  it("rejects --token - on an interactive TTY (INVALID_ARGUMENT)", async () => {
    stubStdin({ isTTY: true, chunks: [] });
    const fn = buildLoginCommand({ token: "-" });
    const err = await fn(makeCtx(makeRuntime({}))).catch((e: unknown) => e);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
  });

  it("falls back to the browser flow when no token is given", async () => {
    const { loginCommand } = await import("../login");
    expect(buildLoginCommand({ token: null })).toBe(loginCommand);
  });
});
