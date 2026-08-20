import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `traycer host service install` (the deferred half of the documented
// `host install --no-service-register` split flow) owns the SAME sign-in
// pre-flight + post-start credential provisioning as `host install`, since
// this command is the one that actually starts the host in that split.
// This suite pins that wiring: `runSignInPreflight` runs BEFORE the CLI
// lock, `maybeProvisionCredential` runs with `postSwapAction: "install"`
// AFTER `controller.install(...)`, and the result payload/human line carry
// both outcomes - mirroring `host-install.test.ts`'s mocking conventions.
//
// `runSignInPreflight`/`maybeProvisionCredential` are mocked directly
// (rather than their transitive dependencies in `../auth/login-flow`,
// `../host/credential-provisioning`, `../internal/host-auth`) since this
// command imports them straight from `../host/install-auth` - the internal
// behaviour of those two functions has its own coverage in
// `install-auth.test.ts` / `credential-provisioning.test.ts`.
// `formatCredentialProvisionNote` is left genuine (pure string formatting,
// no I/O) so the human-line assertions exercise the real copy.

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  runSignInPreflightMock: vi.fn(),
  maybeProvisionCredentialMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  resolveServiceCliInvocationMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  serviceManifestPathMock: vi.fn(),
  windowsTaskNameMock: vi.fn(),
  attestInstallRuntimeMock: vi.fn(),
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

// `createServiceController`/`resolveServiceCliInvocation` must be mocked:
// the real controller builds a `createCliLogger` that does filesystem I/O
// against the operator's actual `~/.traycer` home, and the real invocation
// resolver reads the CLI manifest off disk. `formatServiceLifecycleWarning`
// is kept genuine (pure), same convention as `host-install.test.ts`.
vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: mocks.createServiceControllerMock,
    resolveServiceCliInvocation: mocks.resolveServiceCliInvocationMock,
    serviceLabelFor: mocks.serviceLabelForMock,
    serviceManifestPath: mocks.serviceManifestPathMock,
    windowsTaskName: mocks.windowsTaskNameMock,
  };
});

// Reads the real install manifest off disk otherwise - same filesystem
// hazard as the mocks above. Records into `callOrder`: the attestation's
// placement is load-bearing (see the ordering test below).
vi.mock("../../host/attested-install-runtime", () => ({
  attestInstallRuntime: (
    ...callArgs: Parameters<typeof mocks.attestInstallRuntimeMock>
  ) => {
    mocks.callOrder.push("attest");
    return mocks.attestInstallRuntimeMock(...callArgs);
  },
}));

vi.mock("../../store/cli-lock", () => ({
  withCliLock: async (
    _opts: unknown,
    fn: (handle: {
      path: string;
      metadata: Record<string, unknown>;
      release: () => Promise<void>;
    }) => Promise<unknown>,
  ) => {
    mocks.callOrder.push("lock-enter");
    const result = await fn({
      path: "/tmp/.lock",
      metadata: {},
      release: async () => {},
    });
    mocks.callOrder.push("lock-exit");
    return result;
  },
}));

import {
  buildServiceInstallCommand,
  type ServiceInstallArgs,
} from "../service-install";
import type { CommandContext } from "../../runner/runner";
import type { HostCredentialProvisionOutcome } from "../../host/credential-provisioning";
import type { HostInstallAuthPreflight } from "../../host/install-auth";

function baseArgs(overrides: Partial<ServiceInstallArgs>): ServiceInstallArgs {
  return {
    enableLinger: true,
    allowSelfInvocation: false,
    takeover: false,
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

describe("buildServiceInstallCommand", () => {
  beforeEach(() => {
    mocks.createServiceControllerMock.mockReturnValue({
      install: vi.fn().mockResolvedValue(undefined),
      takeoverDesktopRegistration: vi.fn(),
    });
    mocks.resolveServiceCliInvocationMock.mockResolvedValue({
      command: "/usr/local/bin/traycer",
      args: [],
    });
    mocks.serviceLabelForMock.mockReturnValue({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment: "production",
      devSlot: null,
    });
    mocks.serviceManifestPathMock.mockReturnValue("/tmp/ai.traycer.host.plist");
    mocks.windowsTaskNameMock.mockReturnValue("ai.traycer.host");
    mocks.attestInstallRuntimeMock.mockResolvedValue({
      installGeneration: null,
      runtimeVersion: null,
      runtimeWasNull: false,
    });
    // Every existing test predates the caller needing an explicit default -
    // set one so only the tests that care about auth override it.
    mocks.runSignInPreflightMock.mockResolvedValue(signedInPreflight());
    mocks.maybeProvisionCredentialMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.resetAllMocks();
    mocks.callOrder = [];
  });

  it("runs the sign-in pre-flight before the lock is acquired, attests inside it, and provisions only after it releases", async () => {
    // Every position here is deliberate. The pre-flight can block on a human
    // (device-flow sign-in) and the probe can wait up to 30s for the host -
    // neither touches lock-guarded state, so neither may extend the shared
    // cli-lock's critical section (mirrors `host install`). The attestation
    // is the opposite: it must read the install record INSIDE the lock, or a
    // concurrent bytes-only install committing after release gets its record
    // attested as this cycle's - and Desktop then stamps the new record with
    // the runtime version of a host still running the old bytes.
    mocks.runSignInPreflightMock.mockResolvedValue(signedInPreflight());
    mocks.maybeProvisionCredentialMock.mockResolvedValue({
      kind: "active",
      minted: false,
    });
    mocks.attestInstallRuntimeMock.mockResolvedValue({
      installGeneration: "gen-7",
      runtimeVersion: "1.2.3",
      runtimeWasNull: false,
    });

    const command = buildServiceInstallCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(mocks.callOrder).toEqual([
      "preflight",
      "lock-enter",
      "attest",
      "lock-exit",
      "credential-provision",
    ]);
    // The lock-scoped attestation is what the payload carries - Desktop's
    // stamp-runtime CAS consumes exactly these fields.
    expect(result.data).toMatchObject({
      installGeneration: "gen-7",
      runtimeVersion: "1.2.3",
      runtimeWasNull: false,
    });
  });

  it("a signed-out, non-interactive run still completes registration; credentialProvision is null and the human line names the unprovisioned host", async () => {
    mocks.runSignInPreflightMock.mockResolvedValue(unauthenticatedPreflight());
    // `maybeProvisionCredential` itself decides not to attempt a mint when
    // the pre-flight was unauthenticated - this suite only pins that
    // service-install SURFACES whatever it returns, not that internal
    // decision (covered in `install-auth.test.ts`).
    mocks.maybeProvisionCredentialMock.mockResolvedValue(null);

    const command = buildServiceInstallCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(mocks.maybeProvisionCredentialMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      authPreflight: unauthenticatedPreflight(),
      credentialProvision: null,
    });
    expect(result.human ?? "").toContain(
      "not signed in - the host is unprovisioned",
    );
    expect(result.exitCode).toBe(0);
  });

  it("a signed-in run calls the provisioning probe with postSwapAction 'install' and surfaces the outcome", async () => {
    const outcome: HostCredentialProvisionOutcome = {
      kind: "active",
      minted: true,
    };
    mocks.runSignInPreflightMock.mockResolvedValue(signedInPreflight());
    mocks.maybeProvisionCredentialMock.mockResolvedValue(outcome);

    const command = buildServiceInstallCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(mocks.maybeProvisionCredentialMock).toHaveBeenCalledWith(
      expect.anything(),
      "install",
      signedInPreflight(),
    );
    expect(result.data).toMatchObject({
      authPreflight: signedInPreflight(),
      credentialProvision: outcome,
    });
    expect(result.human ?? "").toMatch(/host credential provisioned$/);
  });

  it("passes exactly 'install' as the postSwapAction on every run - service install always starts the host", async () => {
    mocks.runSignInPreflightMock.mockResolvedValue(signedInPreflight());
    mocks.maybeProvisionCredentialMock.mockResolvedValue({
      kind: "not-adopted",
    });

    const command = buildServiceInstallCommand(baseArgs({}));
    const result = await command(fakeCtx());

    const call = mocks.maybeProvisionCredentialMock.mock.calls[0];
    expect(call[1]).toBe("install");
    expect(result.data).toMatchObject({
      credentialProvision: { kind: "not-adopted" },
    });
    expect(result.human).toContain(
      "host credential not provisioned (the host did not adopt it in time)",
    );
  });
});
