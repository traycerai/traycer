import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `traycer host ensure` is the desktop's idempotent post-auth
// install+register+start call. It now owns the SAME sign-in pre-flight and
// post-start credential provisioning as `host install` / `host service
// install` (see `install-auth.ts`'s start-capable command inventory): the
// pre-flight runs BEFORE `ensureHost` (it can block on a human and touches
// nothing `ensureHost`'s inner cli-lock guards), and the provisioning probe
// runs AFTER `ensureHost` returns, dialed with whatever `postSwapAction`
// the result's `serviceLifecycle` reports - `"none"` when nothing was
// started (`serviceLifecycle === null`) or the post-swap start itself
// failed (`postSwapError !== null`, nothing to dial). This suite pins that
// wiring, mirroring `service-install.test.ts`'s mocking conventions.
//
// `runSignInPreflight`/`maybeProvisionCredential` are mocked directly
// (rather than their transitive dependencies in `../auth/login-flow`,
// `../host/credential-provisioning`, `../internal/host-auth`) since this
// command imports them straight from `../host/install-auth` - the internal
// behaviour of those two functions has its own coverage in
// `install-auth.test.ts` / `credential-provisioning.test.ts`.
// `formatCredentialProvisionNote` is left genuine (pure string formatting,
// no I/O) so the human-line assertions exercise the real copy.
//
// `ensureHost` (`../../host/ensure`) is mocked wholesale: its own
// source-resolution + `provisionHost` core (lock acquisition, install,
// service lifecycle) has its own coverage elsewhere, and this suite only
// needs to pin how `host-ensure.ts` THREADS the result through the two new
// auth steps.

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  ensureHostMock: vi.fn(),
  runSignInPreflightMock: vi.fn(),
  maybeProvisionCredentialMock: vi.fn(),
}));

vi.mock("../../host/ensure", () => ({
  ensureHost: (...callArgs: Parameters<typeof mocks.ensureHostMock>) => {
    mocks.callOrder.push("ensure");
    return mocks.ensureHostMock(...callArgs);
  },
}));

vi.mock("../../host/install-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/install-auth")>();
  return {
    ...actual,
    runSignInPreflight: (
      ...callArgs: Parameters<typeof mocks.runSignInPreflightMock>
    ) => {
      mocks.callOrder.push("preflight");
      return mocks.runSignInPreflightMock(...callArgs);
    },
    maybeProvisionCredential: (
      ...callArgs: Parameters<typeof mocks.maybeProvisionCredentialMock>
    ) => {
      mocks.callOrder.push("credential-provision");
      return mocks.maybeProvisionCredentialMock(...callArgs);
    },
  };
});

import { buildHostEnsureCommand, type HostEnsureArgs } from "../host-ensure";
import type { CommandContext } from "../../runner/runner";
import type { HostEnsureResult } from "../../host/ensure";
import type { HostProvisionServiceLifecycle } from "../../host/provision";
import type { HostCredentialProvisionOutcome } from "../../host/credential-provisioning";
import type { HostInstallAuthPreflight } from "../../host/install-auth";

function baseArgs(overrides: Partial<HostEnsureArgs>): HostEnsureArgs {
  return {
    versionRequest: null,
    fromPath: null,
    enableLinger: true,
    allowSelfInvocation: false,
    noServiceRegister: false,
    force: false,
    ...overrides,
  };
}

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
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

function signedInPreflight(): HostInstallAuthPreflight {
  return { state: "signed-in", reason: null };
}

function unauthenticatedPreflight(): HostInstallAuthPreflight {
  return { state: "unauthenticated", reason: "noninteractive-cannot-prompt" };
}

function lifecycle(
  overrides: Partial<HostProvisionServiceLifecycle>,
): HostProvisionServiceLifecycle {
  return {
    priorServiceState: "stopped",
    stoppedBeforeSwap: false,
    postSwapAction: "start",
    postSwapError: null,
    ...overrides,
  };
}

function baseEnsureResult(
  overrides: Partial<HostEnsureResult>,
): HostEnsureResult {
  return {
    installed: true,
    registered: true,
    running: true,
    version: "1.2.3",
    runtimeVersion: "1.2.3",
    action: "started",
    serviceLifecycle: null,
    postSwapError: null,
    installGeneration: "gen-1",
    ...overrides,
  };
}

describe("buildHostEnsureCommand", () => {
  beforeEach(() => {
    // Every existing test predates the caller needing an explicit default -
    // set one so only the tests that care about auth override it.
    mocks.runSignInPreflightMock.mockResolvedValue(signedInPreflight());
    mocks.maybeProvisionCredentialMock.mockResolvedValue(null);
    mocks.ensureHostMock.mockResolvedValue(baseEnsureResult({}));
  });

  afterEach(() => {
    vi.resetAllMocks();
    mocks.callOrder = [];
  });

  it("runs the sign-in pre-flight before ensureHost, and provisions the credential only after ensureHost returns", async () => {
    const command = buildHostEnsureCommand(baseArgs({}));
    await command(fakeCtx());

    expect(mocks.callOrder).toEqual([
      "preflight",
      "ensure",
      "credential-provision",
    ]);
  });

  it("maps a serviceLifecycle with a successful post-swap start into that exact postSwapAction", async () => {
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "started",
        serviceLifecycle: lifecycle({ postSwapAction: "start" }),
        postSwapError: null,
      }),
    );
    const command = buildHostEnsureCommand(baseArgs({}));
    await command(fakeCtx());

    expect(mocks.maybeProvisionCredentialMock).toHaveBeenCalledWith(
      expect.anything(),
      "start",
      signedInPreflight(),
    );

    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "installed",
        serviceLifecycle: lifecycle({ postSwapAction: "install" }),
        postSwapError: null,
      }),
    );
    const secondCommand = buildHostEnsureCommand(baseArgs({}));
    await secondCommand(fakeCtx());

    expect(mocks.maybeProvisionCredentialMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "install",
      signedInPreflight(),
    );
  });

  it("maps to 'none' when nothing started (noop) and when the post-swap start itself failed", async () => {
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "noop",
        serviceLifecycle: null,
        postSwapError: null,
      }),
    );
    const command = buildHostEnsureCommand(baseArgs({}));
    await command(fakeCtx());

    expect(mocks.maybeProvisionCredentialMock).toHaveBeenCalledWith(
      expect.anything(),
      "none",
      signedInPreflight(),
    );

    // Both `postSwapError` fields are set: every `HostProvisionResult`
    // construction site in provision.ts copies one value into the nested
    // lifecycle AND the top-level field, so a fixture that set only one
    // would model a state the producer cannot emit.
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "started",
        serviceLifecycle: lifecycle({
          postSwapAction: "start",
          postSwapError: "launchctl load failed",
        }),
        postSwapError: "launchctl load failed",
      }),
    );
    const secondCommand = buildHostEnsureCommand(baseArgs({}));
    await secondCommand(fakeCtx());

    expect(mocks.maybeProvisionCredentialMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "none",
      signedInPreflight(),
    );
  });

  it("a signed-out, non-interactive run surfaces both outcomes: credentialProvision null, human line names the unprovisioned host", async () => {
    mocks.runSignInPreflightMock.mockResolvedValue(unauthenticatedPreflight());
    // `maybeProvisionCredential` itself decides not to attempt a mint when
    // the pre-flight was unauthenticated - this suite only pins that
    // host-ensure SURFACES whatever it returns, not that internal decision
    // (covered in `install-auth.test.ts`).
    mocks.maybeProvisionCredentialMock.mockResolvedValue(null);
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "started",
        serviceLifecycle: lifecycle({ postSwapAction: "start" }),
      }),
    );

    const command = buildHostEnsureCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(result.data).toMatchObject({
      authPreflight: unauthenticatedPreflight(),
      credentialProvision: null,
    });
    expect(result.human ?? "").toContain(
      "not signed in - the host is unprovisioned until you run `traycer login`",
    );
    expect(result.exitCode).toBe(0);
  });

  it("threads args.noServiceRegister into runSignInPreflight's bytesOnly parameter, and surfaces a provisioning outcome note in the human line", async () => {
    const outcome: HostCredentialProvisionOutcome = { kind: "unreachable" };
    mocks.maybeProvisionCredentialMock.mockResolvedValue(outcome);
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "started",
        serviceLifecycle: lifecycle({ postSwapAction: "start" }),
      }),
    );

    const command = buildHostEnsureCommand(
      baseArgs({ noServiceRegister: true }),
    );
    const result = await command(fakeCtx());

    expect(mocks.runSignInPreflightMock).toHaveBeenCalledWith(
      expect.anything(),
      true,
    );
    expect(result.data).toMatchObject({
      authPreflight: signedInPreflight(),
      credentialProvision: outcome,
    });
    expect(result.human ?? "").toContain(
      "host credential not provisioned (the host did not come up in time)",
    );
  });
});
