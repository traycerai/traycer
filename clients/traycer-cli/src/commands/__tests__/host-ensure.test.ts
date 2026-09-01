import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `traycer host ensure` is the desktop's idempotent post-auth
// install+register+start call. Unlike `host install` / `host service
// install`, it can also be a NO-OP (already installed + registered +
// running), so it cannot run the sign-in pre-flight unconditionally - a
// signed-out operator whose host is already healthy would be prompted to
// sign in for a command that then does nothing (and, non-interactively,
// would be told the existing host is "unprovisioned" - a claim that is
// false for an already-running host, which can hold a live delegated
// credential long after a local logout). So `host-ensure.ts` hands
// `runSignInPreflight` to `ensureHost` as its `beforeMutate` hook (threaded
// straight through to `provisionHost`, see `host/provision.ts`), which
// invokes it ONLY once the lock-free fast path has declined the no-op
// return - i.e. only once this call has committed to installing,
// registering or starting a host. A no-op run therefore never runs the
// pre-flight, leaving `authPreflight` at its honest default,
// `{state:"not-checked", reason:"nothing-to-start"}`; the regression suite
// below pins exactly that. The post-start credential provisioning probe
// still runs AFTER `ensureHost` returns, dialed with whatever
// `postSwapAction` the result's `serviceLifecycle` reports - `"none"` when
// nothing was started (`serviceLifecycle === null`) or the post-swap start
// itself failed (`postSwapError !== null`, nothing to dial). This suite
// pins that wiring, mirroring `service-install.test.ts`'s mocking
// conventions.
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
// service lifecycle, and the `beforeMutate` fast-path gate itself - see
// `provision.test.ts`) has its own coverage elsewhere. To stay faithful to
// that gate without reimplementing it, the mock drives its own
// `beforeMutate` invocation off the SAME kind of signal the real
// `provisionHost` uses: the configured result's `action`/`serviceLifecycle`
// (mutating vs. no-op) - see the mock factory below. This suite only needs
// to pin how `host-ensure.ts` THREADS the callback and the result through
// the two auth steps.

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  ensureHostMock: vi.fn(),
  runSignInPreflightMock: vi.fn(),
  maybeProvisionCredentialMock: vi.fn(),
}));

vi.mock("../../host/ensure", () => ({
  ensureHost: async (...callArgs: Parameters<typeof mocks.ensureHostMock>) => {
    mocks.callOrder.push("ensure-enter");
    const [opts] = callArgs;
    const result = await mocks.ensureHostMock(...callArgs);
    // Mirrors `provisionHost`'s own fast-path gate (`host/provision.ts`):
    // `beforeMutate` runs only once the call has committed to mutating the
    // host. There is no separate "fast-path state" to read in this
    // wholesale mock, so the gate is driven off the configured result
    // itself - the same action/serviceLifecycle fields the REAL
    // `provisionHost`'s no-op return is built from (see `noopResult`
    // there).
    const isMutatingRun =
      result.serviceLifecycle !== null || result.action !== "noop";
    if (isMutatingRun) {
      await opts.beforeMutate?.();
    }
    mocks.callOrder.push("ensure-exit");
    return result;
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
    // Every existing case is a solo invocation - the acquire-or-refuse path
    // these tests already assert.
    attemptAdoption: null,
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

// The pre-flight's own honest "we never looked" default - what
// `authPreflight` stays at when `beforeMutate` never runs (the no-op fast
// path). Distinct from `unauthenticatedPreflight()`, which is a VERIFIED
// negative from a pre-flight that actually ran.
function notCheckedNothingToStartPreflight(): HostInstallAuthPreflight {
  return { state: "not-checked", reason: "nothing-to-start" };
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

  it("runs the sign-in pre-flight inside ensureHost's beforeMutate hook, and provisions the credential only after ensureHost returns", async () => {
    const command = buildHostEnsureCommand(baseArgs({}));
    await command(fakeCtx());

    expect(mocks.callOrder).toEqual([
      "ensure-enter",
      "preflight",
      "ensure-exit",
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

    // The noop fixture is exactly the mock's no-op gate (see the mock
    // factory above): `beforeMutate` never runs, so `authPreflight` here is
    // the honest "not-checked" default, not the `signedInPreflight()`
    // `beforeEach` configures the pre-flight mock to return if it WERE
    // called. Full regression coverage for this gate lives below.
    expect(mocks.runSignInPreflightMock).not.toHaveBeenCalled();
    expect(mocks.maybeProvisionCredentialMock).toHaveBeenCalledWith(
      expect.anything(),
      "none",
      notCheckedNothingToStartPreflight(),
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

    // Unlike the noop case above, this fixture DID start something
    // (`serviceLifecycle !== null`), so the pre-flight ran and the mapping's
    // third argument is the real signed-in preflight.
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

  it("a no-op run never invokes the pre-flight, so authPreflight stays honest ('not-checked') and the human line makes no unprovisioned claim", async () => {
    // Reviewer finding this pins directly: the pre-flight used to run
    // unconditionally before `ensureHost`, so a signed-out operator whose
    // host was already healthy got prompted to sign in for a command that
    // then did nothing - and in non-interactive mode the human line falsely
    // claimed the existing host was "unprovisioned" (an already-running
    // host can hold a live delegated credential long after a local
    // logout). `beforeMutate` fixes this by firing only once
    // `provisionHost`'s fast path has declined the noop return; the mock's
    // gate mirrors that. Configuring the pre-flight mock to resolve
    // unauthenticated-IF-CALLED (rather than relying on `beforeEach`'s
    // signed-in default) means a broken gate would surface here instead of
    // accidentally passing.
    mocks.runSignInPreflightMock.mockResolvedValue(unauthenticatedPreflight());
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "noop",
        serviceLifecycle: null,
        postSwapError: null,
      }),
    );

    const command = buildHostEnsureCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(mocks.runSignInPreflightMock).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      authPreflight: notCheckedNothingToStartPreflight(),
    });
    expect(result.human ?? "").not.toContain("not signed in");
    expect(result.human ?? "").not.toContain("unprovisioned");
  });

  it("a mutating run DOES invoke the pre-flight, and a signed-out one truthfully reports the host it just started as unprovisioned", async () => {
    // Contrast with the no-op case above: this run actually installs/
    // starts a host, so "unprovisioned" is a truthful claim about a host
    // THIS command brought up while signed out - there is no false claim to
    // guard against here, only the requirement that the pre-flight still
    // runs at all on the mutating path.
    mocks.runSignInPreflightMock.mockResolvedValue(unauthenticatedPreflight());
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "installed",
        serviceLifecycle: lifecycle({ postSwapAction: "install" }),
        postSwapError: null,
      }),
    );

    const command = buildHostEnsureCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(mocks.runSignInPreflightMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      authPreflight: unauthenticatedPreflight(),
    });
    expect(result.human ?? "").toContain(
      "not signed in - the host is unprovisioned until you run `traycer login`",
    );
  });
});
