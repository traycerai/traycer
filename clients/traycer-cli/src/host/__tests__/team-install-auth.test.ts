import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `runSignInPreflight`'s policy argument: `true` (bytes-only bypass), `false`
// (warn and continue unauthenticated) and `{ requireSignIn: true }` (the
// team-install policy, which must refuse instead of continuing signed out).
//
// Only the layers below the pre-flight are mocked - the credentials read and
// the device flow. The decision under test (can this run prompt, and what
// happens on each outcome) is the real one.

const mocks = vi.hoisted(() => ({
  resolveHostAuthMock: vi.fn(),
  runDeviceAuthFlowMock: vi.fn(),
}));

vi.mock("../../internal/host-auth", () => ({
  resolveHostAuth: mocks.resolveHostAuthMock,
}));

vi.mock("../../auth/login-flow", () => ({
  runDeviceAuthFlow: mocks.runDeviceAuthFlowMock,
}));

import { runSignInPreflight } from "../install-auth";
import { CLI_ERROR_CODES, CliError, cliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";

const REQUIRE_SIGN_IN = { requireSignIn: true } as const;

interface CtxOverrides {
  readonly json: boolean;
  readonly nonInteractive: boolean;
}

function fakeCtx(overrides: CtxOverrides): CommandContext {
  return {
    runtime: {
      json: overrides.json,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: overrides.nonInteractive,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
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

const INTERACTIVE: CtxOverrides = { json: false, nonInteractive: false };

function storedAuth(): {
  readonly token: string;
  readonly authnBaseUrl: string;
  readonly userId: string;
} {
  return {
    token: "stored-bearer",
    authnBaseUrl: "https://authn.test",
    userId: "user-1",
  };
}

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

describe("runSignInPreflight policy", () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(
    process.stdout,
    "isTTY",
  );

  beforeEach(() => {
    vi.resetAllMocks();
    setStdoutIsTTY(true);
  });

  afterEach(() => {
    if (originalIsTTY === undefined) {
      Reflect.deleteProperty(process.stdout, "isTTY");
    } else {
      Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
    }
  });

  describe("bytes-only (true)", () => {
    it("reports not-checked without reading credentials or prompting", async () => {
      const result = await runSignInPreflight(fakeCtx(INTERACTIVE), true);

      expect(result).toEqual({ state: "not-checked", reason: "bytes-only" });
      expect(mocks.resolveHostAuthMock).not.toHaveBeenCalled();
      expect(mocks.runDeviceAuthFlowMock).not.toHaveBeenCalled();
    });
  });

  describe("requireSignIn", () => {
    it("bypasses the prompt when credentials already exist", async () => {
      mocks.resolveHostAuthMock.mockResolvedValue(storedAuth());

      const result = await runSignInPreflight(
        fakeCtx(INTERACTIVE),
        REQUIRE_SIGN_IN,
      );

      expect(result).toEqual({ state: "signed-in", reason: null });
      expect(mocks.runDeviceAuthFlowMock).not.toHaveBeenCalled();
    });

    it.each<{
      readonly name: string;
      readonly ctx: CtxOverrides;
      readonly isTTY: boolean;
    }>([
      {
        name: "non-interactive",
        ctx: { json: false, nonInteractive: true },
        isTTY: true,
      },
      {
        name: "JSON",
        ctx: { json: true, nonInteractive: false },
        isTTY: true,
      },
      {
        name: "non-TTY stdout",
        ctx: INTERACTIVE,
        isTTY: false,
      },
    ])(
      "refuses a signed-out $name run with E_AUTH_NO_CREDENTIALS and never prompts",
      async ({ ctx, isTTY }) => {
        setStdoutIsTTY(isTTY);
        mocks.resolveHostAuthMock.mockResolvedValue(null);
        const context = fakeCtx(ctx);

        const failure = await runSignInPreflight(context, REQUIRE_SIGN_IN).then(
          () => null,
          (err: unknown) => err,
        );

        expect(failure).toBeInstanceOf(CliError);
        expect(failure).toMatchObject({
          code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
          exitCode: 1,
        });
        expect(mocks.runDeviceAuthFlowMock).not.toHaveBeenCalled();
        // A refusal is not the warn-and-continue path.
        expect(context.runtime.logger.warn).not.toHaveBeenCalled();
      },
    );

    it("propagates a device-flow failure instead of continuing unauthenticated", async () => {
      mocks.resolveHostAuthMock.mockResolvedValue(null);
      const rejected = cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: "device code expired",
        details: null,
        exitCode: 1,
      });
      mocks.runDeviceAuthFlowMock.mockRejectedValue(rejected);
      const context = fakeCtx(INTERACTIVE);

      const failure = await runSignInPreflight(context, REQUIRE_SIGN_IN).then(
        () => null,
        (err: unknown) => err,
      );

      expect(failure).toBe(rejected);
      expect(context.runtime.logger.warn).not.toHaveBeenCalled();
    });

    it("reports signed-in-inline after a successful inline sign-in", async () => {
      mocks.resolveHostAuthMock.mockResolvedValue(null);
      mocks.runDeviceAuthFlowMock.mockResolvedValue({
        user: { id: "user-1", email: "person@example.test", name: "Person" },
      });

      const result = await runSignInPreflight(
        fakeCtx(INTERACTIVE),
        REQUIRE_SIGN_IN,
      );

      expect(result).toEqual({ state: "signed-in-inline", reason: null });
      expect(mocks.runDeviceAuthFlowMock).toHaveBeenCalledTimes(1);
    });

    it("does not print an account id when inline sign-in has no email or name", async () => {
      mocks.resolveHostAuthMock.mockResolvedValue(null);
      mocks.runDeviceAuthFlowMock.mockResolvedValue({
        token: "inline-token",
        user: { id: "opaque-user-id", email: "", name: "" },
      });
      const context = fakeCtx(INTERACTIVE);

      const result = await runSignInPreflight(context, REQUIRE_SIGN_IN);

      expect(result).toEqual({ state: "signed-in-inline", reason: null });
      expect(context.output.humanRequired).toHaveBeenNthCalledWith(
        2,
        "Signed in.",
      );
    });
  });

  describe("existing warn-and-continue (false)", () => {
    it("warns and continues unauthenticated when it cannot prompt", async () => {
      mocks.resolveHostAuthMock.mockResolvedValue(null);
      const context = fakeCtx({ json: false, nonInteractive: true });

      const result = await runSignInPreflight(context, false);

      expect(result).toEqual({
        state: "unauthenticated",
        reason: "noninteractive-cannot-prompt",
      });
      expect(context.runtime.logger.warn).toHaveBeenCalledTimes(1);
      expect(mocks.runDeviceAuthFlowMock).not.toHaveBeenCalled();
    });

    it("warns and continues unauthenticated when the inline sign-in fails", async () => {
      mocks.resolveHostAuthMock.mockResolvedValue(null);
      mocks.runDeviceAuthFlowMock.mockRejectedValue(
        cliError({
          code: CLI_ERROR_CODES.AUTH_REJECTED,
          message: "denied",
          details: null,
          exitCode: 1,
        }),
      );
      const context = fakeCtx(INTERACTIVE);

      const result = await runSignInPreflight(context, false);

      expect(result).toEqual({
        state: "unauthenticated",
        reason: "sign-in-incomplete",
      });
      expect(context.runtime.logger.warn).toHaveBeenCalledTimes(1);
    });
  });
});
