import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCredentialsFile,
  writeCredentialsFile,
} from "@traycer/protocol/config/credentials";
import {
  LegacyTeamHost,
  LEGACY_TEAM,
} from "../../host/__tests__/legacy-team-host";
import { CLI_ERROR_CODES } from "../../runner/errors";
import {
  hostEnrollmentRecordPath,
  hostTeamInstallTokenPath,
} from "../../store/paths";
import {
  AUTHN_UNREACHABLE_SENTENCE,
  type InlineSignIn,
  inlineSignIn,
  inlineSignInCredentials,
  MINT_FAILURES,
  MINT_URL,
  MINTED_ENVIRONMENT_ID,
  MINTED_TOKEN,
  MINTED_TOKEN_FILE,
  mintedAnswer,
  RETAINED_SIGN_IN_WARNING,
  registerHostOnMachine,
  signedInAcmeUser,
  signedInNonMemberUser,
  stagedTeamTokenFile,
  stubMintAnswer,
  TEAM_INSTALL_ROADS,
  TEAM_SLUG_SENTENCE,
} from "../../host/__tests__/team-install-fixtures";
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

// HOME is redirected to a private temp dir before anything reads it: the
// command looks for this machine's host enrolment record and stages the team
// token under `hostHomeDir()`, and `store/paths` binds `homedir()` at module
// load. The dir is made inside the `node:os` factory, so it exists before the
// first module that asks for `homedir()` is evaluated.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-host-ensure-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  credentialsPath: "",
  legacyHost: null as LegacyTeamHost | null,
  resolveHostAuthMock: vi.fn(),
  validateIdentityMock: vi.fn(),
  createStoreBackedRevalidatorMock: vi.fn(),
  readHostOwnershipMock: vi.fn(),
  ensureHostMock: vi.fn(),
  runSignInPreflightMock: vi.fn(),
  runDeviceAuthFlowMock: vi.fn(),
  maybeProvisionCredentialMock: vi.fn(),
  completeTeamInstallMock: vi.fn(),
  teamTokenPreparationMock: vi.fn(),
  waitForTeamTokenInstallMock: vi.fn(),
  pidMetadata: null as { pid: number; websocketUrl: string } | null,
}));

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return { ...actual, cliCredentialsPath: () => mocks.credentialsPath };
});
vi.mock("../../internal/host-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-auth")>();
  return { ...actual, resolveHostAuth: mocks.resolveHostAuthMock };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return {
    ...actual,
    // The sign-in's own record of the person's teams is read through this
    // call; the order records when a command reads it.
    validateAuthTokenIdentityAccessOnly: (
      ...callArgs: Parameters<typeof mocks.validateIdentityMock>
    ) => {
      mocks.callOrder.push("sign-in-list-read");
      return mocks.validateIdentityMock(...callArgs);
    },
  };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createStoreBackedRevalidator: (
      ...callArgs: Parameters<typeof actual.createStoreBackedRevalidator>
    ) => mocks.createStoreBackedRevalidatorMock(...callArgs),
  };
});

vi.mock(
  "@traycer-clients/shared/host-client/host-ownership",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-ownership")
      >();
    return {
      ...actual,
      readHostOwnershipViaHttp: (
        ...callArgs: Parameters<typeof actual.readHostOwnershipViaHttp>
      ) => mocks.readHostOwnershipMock(...callArgs),
    };
  },
);

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    resolveEndpoint: async () => ({
      hostId: "host-local",
      websocketUrl: "ws://127.0.0.1:1/rpc",
    }),
    callHostRpcAtResolvedEndpoint: (
      ...callArgs: Parameters<typeof actual.callHostRpcAtResolvedEndpoint>
    ) => {
      if (mocks.legacyHost === null)
        throw new Error("No legacy host configured");
      return mocks.legacyHost.request(callArgs[0], callArgs[1], callArgs[4]);
    },
    callHostRpc: async () => ({ environments: [LEGACY_TEAM] }),
    callHostRpcWithDispatch: (
      ...callArgs: Parameters<typeof actual.callHostRpcWithDispatch>
    ) => {
      if (mocks.legacyHost === null)
        throw new Error("No legacy host configured");
      return mocks.legacyHost.request(...callArgs);
    },
  };
});

vi.mock("../../auth/login-flow", () => ({
  runDeviceAuthFlow: async (
    ...callArgs: Parameters<typeof mocks.runDeviceAuthFlowMock>
  ) => mocks.runDeviceAuthFlowMock(...callArgs),
}));

vi.mock("../../host/team-install-token", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/team-install-token")>();
  return {
    ...actual,
    withTeamTokenInstall: async (
      ...[environment, environmentId, piped, readToken, run]: Parameters<
        typeof actual.withTeamTokenInstall
      >
    ) => {
      if (environmentId === null) return run(null);
      mocks.callOrder.push("team-token-prepare");
      const prepared: PreparedTeamTokenInstall | null =
        await mocks.teamTokenPreparationMock(
          environment,
          environmentId,
          piped,
          readToken,
        );
      if (prepared === null) return run(null);
      try {
        return await run(prepared);
      } finally {
        mocks.callOrder.push("team-token-finished");
      }
    },
    waitForTeamTokenInstall: (
      ...callArgs: Parameters<typeof actual.waitForTeamTokenInstall>
    ) => {
      mocks.callOrder.push("team-token-wait");
      return mocks.waitForTeamTokenInstallMock(...callArgs);
    },
  };
});

// The pid record the responsiveness check reads. `null` (nothing published)
// unless a test stages one, so no test reads the developer's real home.
vi.mock("../../host/pid-metadata", () => ({
  readHostPidMetadata: async () => mocks.pidMetadata,
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
    completeTeamInstall: (
      ...callArgs: Parameters<typeof actual.completeTeamInstall>
    ) => mocks.completeTeamInstallMock(...callArgs),
  };
});

import { buildHostEnsureCommand, type HostEnsureArgs } from "../host-ensure";
import * as installAuthModule from "../../host/install-auth";
import type { PreparedTeamTokenInstall } from "../../host/team-install-token";
import type { CommandContext } from "../../runner/runner";
import type { HostEnsureResult } from "../../host/ensure";
import type { HostProvisionServiceLifecycle } from "../../host/provision";
import type { HostCredentialProvisionOutcome } from "../../host/credential-provisioning";
import type { HostInstallAuthPreflight } from "../../host/install-auth";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";

const teamBindingFixture = {
  hostId: "host-local",
  environment: {
    environmentId: "environment-acme",
    ownerKind: "organization",
    ownerId: "organization-acme",
    roomId: "room-acme",
    label: "Acme",
  },
  explicit: true,
  enrolledByUserId: "member-1",
  canUnbind: true,
} satisfies EnvironmentHostBinding;

function baseArgs(overrides: Partial<HostEnsureArgs>): HostEnsureArgs {
  return {
    team: null,
    versionRequest: null,
    fromPath: null,
    enableLinger: true,
    allowSelfInvocation: false,
    noServiceRegister: false,
    force: false,
    keepInstalled: false,
    // Every existing case is a solo invocation - the acquire-or-refuse path
    // these tests already assert.
    attemptAdoption: null,
    lifecycleOrigin: "terminal",
    acceptStoreFormatLoss: false,
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

// The sign-in pre-flight's prompt gate reads `process.stdout.isTTY` directly
// (not through `ctx`), so a case that signs in inline sets it itself; the
// original shape is restored after every case.
const originalStdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY",
);

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

/** A device flow that signs the person in and leaves the sign-in on disk. */
function inlineSignInDeviceFlow(token: string): () => Promise<InlineSignIn> {
  return async () => {
    // The inline sign-in is now the one the command resolves.
    mocks.resolveHostAuthMock.mockResolvedValue({
      token,
      authnBaseUrl: "https://authn.test",
      userId: "test-person",
    });
    await writeCredentialsFile(
      mocks.credentialsPath,
      inlineSignInCredentials(token),
      0,
    );
    return inlineSignIn(token);
  };
}

describe("buildHostEnsureCommand", () => {
  beforeEach(() => {
    mocks.pidMetadata = null;
    mocks.legacyHost = null;
    // Every existing test predates the caller needing an explicit default -
    // set one so only the tests that care about auth override it.
    mocks.runSignInPreflightMock.mockResolvedValue(signedInPreflight());
    mocks.maybeProvisionCredentialMock.mockResolvedValue(null);
    mocks.ensureHostMock.mockResolvedValue(baseEnsureResult({}));
    // The signed-in person belongs to the acme team unless a case says not.
    mocks.resolveHostAuthMock.mockResolvedValue({
      token: "test-token",
      authnBaseUrl: "https://authn.test",
      userId: "user-1",
    });
    mocks.validateIdentityMock.mockResolvedValue({
      kind: "valid",
      user: signedInAcmeUser(),
    });
    mocks.completeTeamInstallMock.mockResolvedValue(teamBindingFixture);
    mocks.teamTokenPreparationMock.mockResolvedValue(null);
    mocks.waitForTeamTokenInstallMock.mockResolvedValue({
      hostId: "host-local",
      environmentId: "environment-acme",
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    mocks.callOrder = [];
    rmSync(hostEnrollmentRecordPath("production"), { force: true });
    rmSync(hostTeamInstallTokenPath("production"), { force: true });
    if (originalStdoutIsTTYDescriptor === undefined) {
      Reflect.deleteProperty(process.stdout, "isTTY");
    } else {
      Object.defineProperty(
        process.stdout,
        "isTTY",
        originalStdoutIsTTYDescriptor,
      );
    }
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

  it("sends --team ensure on a machine with a registered host through the shared team completion step, including an already-running no-op", async () => {
    registerHostOnMachine();
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({ action: "noop", serviceLifecycle: null }),
    );

    const ctx = fakeCtx();
    const result = await buildHostEnsureCommand(baseArgs({ team: "acme" }))(
      ctx,
    );

    expect(result.data).toMatchObject({ teamBinding: teamBindingFixture });

    expect(mocks.completeTeamInstallMock).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({
        preflight: { state: "signed-in", reason: null },
        inlineSignInToken: null,
      }),
      ctx.progress,
    );
    // A member's team is found in the sign-in's list before ensure installs,
    // registers or starts anything.
    expect(mocks.callOrder.indexOf("sign-in-list-read")).toBeGreaterThanOrEqual(
      0,
    );
    expect(mocks.callOrder.indexOf("sign-in-list-read")).toBeLessThan(
      mocks.callOrder.indexOf("ensure-enter"),
    );
  });

  it.each(
    [
      {
        label: "a person who belongs to no team",
        user: signedInNonMemberUser,
        team: "acme",
      },
      {
        label: "a member who mistypes the slug",
        user: signedInAcmeUser,
        team: "acmee",
      },
    ].flatMap((teamCase) =>
      TEAM_INSTALL_ROADS.map((road) => ({ ...teamCase, ...road })),
    ),
  )(
    "stops --team ensure for $label on $road before anything is installed or started",
    async ({ user, team, hostRegistered }) => {
      if (hostRegistered) registerHostOnMachine();
      const mintRequests = stubMintAnswer(() => null);
      mocks.validateIdentityMock.mockResolvedValue({
        kind: "valid",
        user: user(),
      });

      await expect(
        buildHostEnsureCommand(baseArgs({ team }))(fakeCtx()),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: TEAM_SLUG_SENTENCE,
        exitCode: 1,
      });

      expect(mocks.callOrder).not.toContain("ensure-enter");
      expect(mocks.ensureHostMock).not.toHaveBeenCalled();
      expect(mocks.completeTeamInstallMock).not.toHaveBeenCalled();
      expect(mocks.maybeProvisionCredentialMock).not.toHaveBeenCalled();
      expect(mocks.legacyHost).toBeNull();
      // The list refused it first: no token was asked for or kept.
      expect(mintRequests).toEqual([]);
      expect(stagedTeamTokenFile()).toBeNull();
    },
  );

  it.each(TEAM_INSTALL_ROADS)(
    "stops --team ensure on $road before anything is installed when the sign-in's teams cannot be read",
    async ({ hostRegistered }) => {
      if (hostRegistered) registerHostOnMachine();
      const mintRequests = stubMintAnswer(() => null);
      mocks.validateIdentityMock.mockResolvedValue({ kind: "network-error" });

      await expect(
        buildHostEnsureCommand(baseArgs({ team: "acme" }))(fakeCtx()),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: AUTHN_UNREACHABLE_SENTENCE,
        exitCode: 1,
      });

      expect(mocks.ensureHostMock).not.toHaveBeenCalled();
      expect(mocks.completeTeamInstallMock).not.toHaveBeenCalled();
      expect(mintRequests).toEqual([]);
      expect(stagedTeamTokenFile()).toBeNull();
    },
  );

  it("the CLI does not send a team target to a host that cannot transfer", async () => {
    registerHostOnMachine();
    mocks.resolveHostAuthMock.mockResolvedValue({
      token: "stored-bearer",
      authnBaseUrl: "https://authn.test",
      userId: "user-1",
    });
    mocks.validateIdentityMock.mockResolvedValue({
      kind: "valid",
      user: signedInAcmeUser(),
    });
    mocks.readHostOwnershipMock.mockResolvedValue({
      kind: "ok",
      host: {
        hostId: "host-local",
        owner: { kind: "user", id: "user-1" },
        kind: "personal",
        remoteAccess: false,
      },
    });
    const legacyHost = new LegacyTeamHost();
    mocks.legacyHost = legacyHost;
    const actual = await vi.importActual<
      typeof import("../../host/install-auth")
    >("../../host/install-auth");
    mocks.completeTeamInstallMock.mockImplementation(
      actual.completeTeamInstall,
    );

    const ctx = fakeCtx();
    await expect(
      buildHostEnsureCommand(baseArgs({ team: "acme" }))(ctx),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message: expect.stringContaining("traycer host update"),
    });
    // The team is read from the sign-in's list twice: before anything is
    // installed, and again by the transfer itself.
    expect(mocks.validateIdentityMock).toHaveBeenCalledTimes(2);
    expect(legacyHost.requests).toEqual([]);
  });

  it.each(["ensure", "bind", "not-running", "unreadable"] as const)(
    "warns about the retained sign-in when team %s fails through the real credentials file",
    async (failure) => {
      const directory = mkdtempSync(join(tmpdir(), "team-ensure-sign-in-"));
      mocks.credentialsPath = join(directory, "credentials");
      const token = "inline-team-token";
      const ctx = fakeCtx();
      registerHostOnMachine();
      setStdoutIsTTY(true);
      mocks.resolveHostAuthMock.mockResolvedValue(null);
      mocks.runDeviceAuthFlowMock.mockImplementation(
        inlineSignInDeviceFlow(token),
      );
      if (failure === "ensure")
        mocks.ensureHostMock.mockRejectedValue(new Error("ensure failed"));
      if (failure === "unreadable")
        mocks.ensureHostMock.mockImplementation(async () => {
          renameSync(mocks.credentialsPath, `${mocks.credentialsPath}.saved`);
          mkdirSync(mocks.credentialsPath);
          throw new Error("unreadable failed");
        });
      if (failure === "bind")
        mocks.completeTeamInstallMock.mockRejectedValue(
          new Error("bind failed"),
        );
      if (failure === "not-running")
        mocks.ensureHostMock.mockResolvedValue(
          baseEnsureResult({ running: false }),
        );
      try {
        const pending = buildHostEnsureCommand(baseArgs({ team: "acme" }))(ctx);
        if (failure === "not-running")
          await expect(pending).resolves.toMatchObject({ exitCode: 1 });
        else await expect(pending).rejects.toThrow(`${failure} failed`);
        if (failure === "unreadable") {
          expect(ctx.output.humanRequired).toHaveBeenCalledWith(
            "Your sign-in could still be on this computer. Run `traycer logout` to remove it.",
          );
        } else {
          expect(
            (await readCredentialsFile(mocks.credentialsPath))?.token,
          ).toBe(token);
          expect(ctx.output.humanRequired).toHaveBeenCalledWith(
            RETAINED_SIGN_IN_WARNING,
          );
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
        mocks.credentialsPath = "";
      }
    },
  );

  describe("--team on a machine with no host yet", () => {
    it("mints by the resolved environment id and stages the token before ensure installs or starts anything, with no personal credential, transfer or restart", async () => {
      const mintRequests = stubMintAnswer(mintedAnswer);
      // What the machine holds for the host's first start, read where ensure
      // installs and starts the host.
      const tokenFileAtEnsure: (string | null)[] = [];
      mocks.ensureHostMock.mockImplementation(() => {
        tokenFileAtEnsure.push(stagedTeamTokenFile());
        return Promise.resolve(
          baseEnsureResult({
            action: "started",
            serviceLifecycle: lifecycle({ postSwapAction: "start" }),
            postSwapError: null,
          }),
        );
      });
      const receipt = {
        hostId: "host-local",
        environmentId: MINTED_ENVIRONMENT_ID,
      };
      mocks.waitForTeamTokenInstallMock.mockResolvedValue(receipt);

      const ctx = fakeCtx();
      const result = await buildHostEnsureCommand(baseArgs({ team: "acme" }))(
        ctx,
      );

      expect(mintRequests).toEqual([
        {
          url: MINT_URL,
          authorization: "Bearer test-token",
          body: { environmentId: MINTED_ENVIRONMENT_ID },
        },
      ]);
      expect(tokenFileAtEnsure).toEqual([MINTED_TOKEN_FILE]);
      // The team is found in the sign-in's list, then the token is minted:
      // both before ensure installs, registers or starts anything.
      expect(mocks.callOrder.indexOf("sign-in-list-read")).toBeGreaterThan(-1);
      expect(mocks.callOrder.indexOf("sign-in-list-read")).toBeLessThan(
        mocks.callOrder.indexOf("ensure-enter"),
      );
      // The receipt is awaited after ensure, for the minted target.
      expect(mocks.callOrder.indexOf("team-token-wait")).toBeGreaterThan(
        mocks.callOrder.indexOf("ensure-exit"),
      );
      expect(mocks.waitForTeamTokenInstallMock).toHaveBeenCalledWith(
        "production",
        {
          environmentId: MINTED_ENVIRONMENT_ID,
          tokenHash: createHash("sha256").update(MINTED_TOKEN).digest("hex"),
        },
        60_000,
      );
      expect(result.human).toContain("This computer belongs to acme.");
      expect(result.exitCode).toBe(0);
      expect(result.data).toMatchObject({
        teamBinding: null,
        teamInstallReceipt: receipt,
      });
      // No personal credential, no transfer, no restart.
      expect(mocks.maybeProvisionCredentialMock).not.toHaveBeenCalled();
      expect(mocks.callOrder).not.toContain("credential-provision");
      expect(mocks.completeTeamInstallMock).not.toHaveBeenCalled();
      expect(mocks.legacyHost).toBeNull();
      expect(ctx.progress).not.toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Restarting Traycer"),
        }),
      );
      // The token never leaves the command.
      expect(JSON.stringify(result)).not.toContain(MINTED_TOKEN);
      expect(
        JSON.stringify(vi.mocked(ctx.output.human).mock.calls),
      ).not.toContain(MINTED_TOKEN);
    });

    it.each(MINT_FAILURES)(
      "stops before anything is installed or started when $label at the token's mint",
      async ({ answer, error }) => {
        const mintRequests = stubMintAnswer(answer);

        await expect(
          buildHostEnsureCommand(baseArgs({ team: "acme" }))(fakeCtx()),
        ).rejects.toMatchObject({ ...error, exitCode: 1 });

        expect(mintRequests).toHaveLength(1);
        expect(mocks.ensureHostMock).not.toHaveBeenCalled();
        expect(mocks.completeTeamInstallMock).not.toHaveBeenCalled();
        expect(mocks.maybeProvisionCredentialMock).not.toHaveBeenCalled();
        expect(stagedTeamTokenFile()).toBeNull();
      },
    );

    it("reminds a person who signed in inline that the sign-in stays when the team is refused", async () => {
      const directory = mkdtempSync(join(tmpdir(), "team-ensure-refused-"));
      mocks.credentialsPath = join(directory, "credentials");
      setStdoutIsTTY(true);
      mocks.resolveHostAuthMock.mockResolvedValue(null);
      mocks.runDeviceAuthFlowMock.mockImplementation(
        inlineSignInDeviceFlow("retained-refused-team"),
      );
      mocks.validateIdentityMock.mockResolvedValue({
        kind: "valid",
        user: signedInNonMemberUser(),
      });
      const mintRequests = stubMintAnswer(() => null);

      const ctx = fakeCtx();
      try {
        await expect(
          buildHostEnsureCommand(baseArgs({ team: "acme" }))(ctx),
        ).rejects.toMatchObject({
          code: CLI_ERROR_CODES.INVALID_ARGUMENT,
          message: TEAM_SLUG_SENTENCE,
        });

        expect(ctx.output.humanRequired).toHaveBeenCalledWith(
          RETAINED_SIGN_IN_WARNING,
        );
        expect(mintRequests).toEqual([]);
        expect(mocks.ensureHostMock).not.toHaveBeenCalled();
      } finally {
        rmSync(directory, { recursive: true, force: true });
        mocks.credentialsPath = "";
      }
    });
  });

  it("uses a prepared team token before auth, waits after ensure, and returns only the target receipt", async () => {
    const prepared = {
      environmentId: "environment-acme",
      tokenHash: "c".repeat(64),
    } satisfies PreparedTeamTokenInstall;
    const receipt = {
      hostId: "host-local",
      environmentId: "environment-acme",
    };
    const ctx = fakeCtx();
    mocks.teamTokenPreparationMock.mockResolvedValue(prepared);
    mocks.waitForTeamTokenInstallMock.mockImplementation(async () => {
      expect(ctx.progress).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "host-team",
          message: "Waiting for this computer to join the team…",
        }),
      );
      return receipt;
    });
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "started",
        serviceLifecycle: lifecycle({ postSwapAction: "start" }),
        postSwapError: null,
      }),
    );
    const attendedTeamInstall = vi.spyOn(
      installAuthModule,
      "beginAttendedTeamInstall",
    );
    const signInPreflight = vi.spyOn(installAuthModule, "runSignInPreflight");

    const result = await buildHostEnsureCommand(
      baseArgs({ team: "environment-acme" }),
    )(ctx);

    expect(mocks.callOrder).toEqual([
      "team-token-prepare",
      "ensure-enter",
      "ensure-exit",
      "team-token-wait",
      "team-token-finished",
    ]);
    expect(mocks.waitForTeamTokenInstallMock).toHaveBeenCalledWith(
      "production",
      prepared,
      60_000,
    );
    expect(attendedTeamInstall).not.toHaveBeenCalled();
    expect(signInPreflight).not.toHaveBeenCalled();
    expect(mocks.runSignInPreflightMock).not.toHaveBeenCalled();
    expect(mocks.maybeProvisionCredentialMock).not.toHaveBeenCalled();
    expect(mocks.completeTeamInstallMock).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ teamInstallReceipt: receipt });
    expect(JSON.stringify(result.data)).not.toContain(prepared.tokenHash);
    expect(JSON.stringify(result.data)).not.toContain('"token"');
  });

  it("keeps a failing ensure inside the team-token operation before any receipt wait", async () => {
    const prepared = {
      environmentId: "environment-acme",
      tokenHash: "e".repeat(64),
    } satisfies PreparedTeamTokenInstall;
    mocks.teamTokenPreparationMock.mockResolvedValue(prepared);
    mocks.ensureHostMock.mockRejectedValue(
      new Error("token-path ensure failed"),
    );

    await expect(
      buildHostEnsureCommand(baseArgs({ team: "environment-acme" }))(fakeCtx()),
    ).rejects.toThrow("token-path ensure failed");

    expect(mocks.callOrder.at(-1)).toBe("team-token-finished");
    expect(mocks.waitForTeamTokenInstallMock).not.toHaveBeenCalled();
    expect(mocks.completeTeamInstallMock).not.toHaveBeenCalled();
  });

  it("propagates a team-token receipt timeout after ensure finishes", async () => {
    const prepared = {
      environmentId: "environment-acme",
      tokenHash: "d".repeat(64),
    } satisfies PreparedTeamTokenInstall;
    mocks.teamTokenPreparationMock.mockResolvedValue(prepared);
    mocks.waitForTeamTokenInstallMock.mockRejectedValue(
      new Error("team install receipt deadline reached"),
    );
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "started",
        serviceLifecycle: lifecycle({ postSwapAction: "start" }),
        postSwapError: null,
      }),
    );

    await expect(
      buildHostEnsureCommand(baseArgs({ team: "environment-acme" }))(fakeCtx()),
    ).rejects.toThrow("team install receipt deadline reached");
    expect(mocks.callOrder).toEqual([
      "team-token-prepare",
      "ensure-enter",
      "ensure-exit",
      "team-token-wait",
      "team-token-finished",
    ]);
    expect(mocks.completeTeamInstallMock).not.toHaveBeenCalled();
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
      "host authorization not confirmed (the host did not respond in time)",
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

  // Ticket 2: `--keep-installed` plumbs straight through to `ensureHost` -
  // the actual `viability` selection is `ensure.ts`'s own concern
  // (`satisfaction-policy-propagation.test.ts`); this only pins that the
  // command layer threads the flag rather than dropping it.
  it("threads args.keepInstalled into ensureHost's keepInstalled option", async () => {
    const command = buildHostEnsureCommand(baseArgs({ keepInstalled: true }));
    await command(fakeCtx());

    expect(mocks.ensureHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ keepInstalled: true }),
    );
  });

  // `host ensure` now exits 1 whenever the
  // post-swap start itself failed, the same rule `host install` follows -
  // Desktop's CLI runners trust the terminal `ok` line over a non-zero exit,
  // so the JSON payload stays exactly what it was.
  it("a post-swap start failure exits 1, with data.postSwapError unchanged", async () => {
    // Both `postSwapError` fields are set, as the "Both postSwapError
    // fields are set" fixture above explains: every `HostProvisionResult`
    // construction site copies one value into the nested lifecycle AND the
    // top-level field.
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

    const command = buildHostEnsureCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.data).toMatchObject({
      postSwapError: "launchctl load failed",
    });
  });

  it("no post-swap error exits 0", async () => {
    mocks.ensureHostMock.mockResolvedValue(
      baseEnsureResult({
        action: "started",
        serviceLifecycle: lifecycle({ postSwapAction: "start" }),
        postSwapError: null,
      }),
    );

    const command = buildHostEnsureCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(result.exitCode).toBe(0);
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

// traycer#1563 D3d: a reinstall or `host ensure` beside a wedged host found
// it registered and running by its pid record and process table, and printed
// "host already ready" while it answered nothing. The run still changes
// nothing and kills nothing; it reports what it found and the way out.
describe("host ensure over a running host that does not respond (traycer#1563 D3d)", () => {
  beforeEach(() => {
    mocks.pidMetadata = null;
    mocks.runSignInPreflightMock.mockResolvedValue(signedInPreflight());
    mocks.maybeProvisionCredentialMock.mockResolvedValue(null);
  });

  afterEach(() => {
    mocks.pidMetadata = null;
  });

  it("reports a running host that answers nothing as not responding, naming the force restart", async () => {
    const { createServer } = await import("node:net");
    const held: import("node:net").Socket[] = [];
    // Accepts and stays silent, as a host whose main thread is blocked does.
    const silent = createServer((socket) => {
      held.push(socket);
    });
    await new Promise<void>((resolve) => {
      silent.listen(0, "127.0.0.1", resolve);
    });
    const address = silent.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    try {
      mocks.pidMetadata = {
        pid: 4242,
        websocketUrl: `ws://127.0.0.1:${port}/rpc`,
      };
      mocks.ensureHostMock.mockResolvedValue(
        baseEnsureResult({ action: "noop", installGeneration: null }),
      );

      const result = await buildHostEnsureCommand(baseArgs({}))(fakeCtx());

      expect(result.data).toMatchObject({ hostResponsive: false });
      expect(result.human).toContain("pid=4242");
      expect(result.human).toContain("not responding");
      expect(result.human).toContain("traycer host restart --force");
      expect(result.human).not.toContain("already ready");
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => {
        silent.close(() => resolve());
      });
    }
  });

  it("still reports a responding host as ready", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"busy":false}');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    try {
      mocks.pidMetadata = {
        pid: 4242,
        websocketUrl: `ws://127.0.0.1:${port}/rpc`,
      };
      mocks.ensureHostMock.mockResolvedValue(
        baseEnsureResult({ action: "noop", installGeneration: null }),
      );

      const result = await buildHostEnsureCommand(baseArgs({}))(fakeCtx());

      expect(result.data).toMatchObject({ hostResponsive: true });
      expect(result.human).toContain("host already ready");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
