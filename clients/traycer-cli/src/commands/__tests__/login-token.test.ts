import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLoginCommand } from "../login";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import { validateAuthTokenViaHttp } from "../../../../shared/auth/auth-validation";
import { readCredentials, writeCredentials } from "../../store/credentials";

vi.mock("../../../../shared/auth/auth-validation", () => ({
  validateAuthTokenViaHttp: vi.fn(),
}));

vi.mock("../../store/credentials", () => ({
  writeCredentials: vi.fn(),
  readCredentials: vi.fn(),
}));

const validateMock = vi.mocked(validateAuthTokenViaHttp);
const writeMock = vi.mocked(writeCredentials);
const readMock = vi.mocked(readCredentials);

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

const validProfile = {
  kind: "valid" as const,
  profile: { userId: "u1", userName: "Ada", email: "ada@traycer.ai" },
};

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
  // Default: no credentials on disk yet.
  readMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  if (realStdin !== undefined) {
    Object.defineProperty(process, "stdin", realStdin);
  }
});

describe("buildLoginCommand with --token", () => {
  it("validates the piped token, writes credentials, and reports the user", async () => {
    validateMock.mockResolvedValue(validProfile);
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ token: "captured-bearer", refreshToken: "" })],
    });
    const fn = buildLoginCommand({ token: "-" });
    const result = await fn(makeCtx(makeRuntime({})));

    expect(validateMock).toHaveBeenCalledWith(expect.any(String), "captured-bearer", "");
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0].token).toBe("captured-bearer");
    expect(writeMock.mock.calls[0][0].user).toEqual({
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

  it("persists the rotated token when validation refreshed it", async () => {
    validateMock.mockResolvedValue({
      ...validProfile,
      refreshedToken: "rotated-bearer",
    });
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ token: "stale-bearer", refreshToken: "" })],
    });
    const fn = buildLoginCommand({ token: "-" });
    await fn(makeCtx(makeRuntime({})));
    expect(writeMock.mock.calls[0][0].token).toBe("rotated-bearer");
  });

  it("persists the paired refresh token from the stdin JSON payload", async () => {
    validateMock.mockResolvedValue(validProfile);
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ token: "bearer", refreshToken: "new-refresh" })],
    });
    const fn = buildLoginCommand({ token: "-" });
    await fn(makeCtx(makeRuntime({})));

    expect(validateMock).toHaveBeenCalledWith(
      expect.any(String),
      "bearer",
      "new-refresh",
    );
    expect(writeMock.mock.calls[0][0].refreshToken).toBe("new-refresh");
  });

  it("keeps the on-disk refresh token when the stdin payload carries none", async () => {
    // The rotation re-seed (CliCredentialSeeder) carries only the bearer; an
    // empty paired token must NOT wipe the refresh token already persisted.
    validateMock.mockResolvedValue(validProfile);
    readMock.mockResolvedValue({
      token: "old-bearer",
      refreshToken: "persisted-refresh",
      authnBaseUrl: "https://authn.example",
      savedAt: "2026-01-01T00:00:00.000Z",
      user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
    });
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ token: "rotated-bearer", refreshToken: "" })],
    });
    const fn = buildLoginCommand({ token: "-" });
    await fn(makeCtx(makeRuntime({})));

    expect(writeMock.mock.calls[0][0].token).toBe("rotated-bearer");
    expect(writeMock.mock.calls[0][0].refreshToken).toBe("persisted-refresh");
  });

  it("rejects a literal --token value without reading stdin or validating (INVALID_ARGUMENT)", async () => {
    const fn = buildLoginCommand({ token: "captured-bearer" });
    const err = await fn(makeCtx(makeRuntime({}))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect((err as CliError).exitCode).toBe(1);
    expect(validateMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("rejects a token the authn service refuses (AUTH_REJECTED, exit 1)", async () => {
    validateMock.mockResolvedValue({ kind: "rejected" });
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ token: "bad", refreshToken: "" })],
    });
    const fn = buildLoginCommand({ token: "-" });
    const err = await fn(makeCtx(makeRuntime({}))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.AUTH_REJECTED);
    expect((err as CliError).exitCode).toBe(1);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("maps an unreachable authn service to AUTH_NETWORK (exit 2)", async () => {
    validateMock.mockResolvedValue({ kind: "network-error" });
    stubStdin({
      isTTY: false,
      chunks: [JSON.stringify({ token: "x", refreshToken: "" })],
    });
    const fn = buildLoginCommand({ token: "-" });
    const err = await fn(makeCtx(makeRuntime({}))).catch((e: unknown) => e);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.AUTH_NETWORK);
    expect((err as CliError).exitCode).toBe(2);
  });

  it("reads the token from stdin for --token -", async () => {
    stubStdin({ isTTY: false, chunks: ["piped-bearer\n"] });
    validateMock.mockResolvedValue(validProfile);
    const fn = buildLoginCommand({ token: "-" });
    await fn(makeCtx(makeRuntime({})));
    // Trailing newline is trimmed before validation.
    expect(validateMock).toHaveBeenCalledWith(expect.any(String), "piped-bearer", "");
  });

  it("rejects --token - with no piped input (INVALID_ARGUMENT)", async () => {
    stubStdin({ isTTY: false, chunks: ["   \n"] });
    const fn = buildLoginCommand({ token: "-" });
    const err = await fn(makeCtx(makeRuntime({}))).catch((e: unknown) => e);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(validateMock).not.toHaveBeenCalled();
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
