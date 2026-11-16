import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  pollDeviceToken,
  startDeviceAuthorization,
  type DeviceAuthorizationResult,
  type DevicePollSchedule,
} from "../../../../shared/auth/device-auth";
import { validateAuthTokenIdentityAccessOnly } from "../../../../shared/auth/auth-validation";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";
import { buildLoginCommand, loginCommand } from "../login";
import { runHostStart } from "../host-start";
import { runHostStartCommand } from "../host-start-command";
import type { RunHostStartOptions } from "../host-start";
import { config } from "../../config";
import type { HostCredentialProvisionOutcome } from "../../host/credential-provisioning";
import { noopLogger } from "../../logger";
import type { CommandContext, CommandResult } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { isProcessAlive } from "../../store/cli-lock";
import { hostPidMetadataPath } from "../../store/paths";
import { hostTokensPath } from "@traycer-clients/shared/auth/host-token-file";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";

// `traycer login` persists the sign-in, then hands a host that is already
// running its credential. The device poll, the access-token probe, and the
// browser open are stubbed (they leave the machine). The credentials store
// and the pid-metadata read stay real, so a pid.json in this file's temp
// home is what decides whether anything is dialed. The dial itself is
// `provisionInstalledHostCredential`; its ack/mint loop has its own suite
// and a 30s budget, so this file stubs that one function and asserts what
// login does with the outcome and whether login invoked it.

const mocks = vi.hoisted(() => ({
  provisionInstalledHostCredential: vi.fn(),
  fetch: vi.fn(),
  home: { path: null as string | null },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mocks.home.path ?? actual.homedir() };
});

vi.mock("../host-start", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host-start")>();
  return { ...actual, runHostStart: vi.fn() };
});

vi.mock("../../host/credential-provisioning", () => ({
  provisionInstalledHostCredential: (options: {
    readonly environment: string;
    readonly auth: {
      readonly token: string;
      readonly authnBaseUrl: string;
      readonly userId: string;
    };
  }): Promise<HostCredentialProvisionOutcome> =>
    mocks.provisionInstalledHostCredential(options),
}));

vi.mock("../../../../shared/auth/device-auth", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/device-auth")
    >();
  return {
    ...actual,
    startDeviceAuthorization: vi.fn(),
    pollDeviceToken: vi.fn(),
    // The real schedule clamps the pre-poll sleep to at least 5s. Login's
    // credential handoff is what this file tests; a zero interval lets the
    // real device flow persist credentials without that wait.
    createPollSchedule: (): DevicePollSchedule => ({
      intervalMs: 0,
      baseIntervalMs: 0,
      expiresAtMs: Date.now() + 3_600_000,
    }),
  };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return { ...actual, validateAuthTokenIdentityAccessOnly: vi.fn() };
});

// `openInBrowser` spawns the platform opener. Nothing else in login should
// spawn, so a host install or start shows up as some other command.
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
const provisionMock = mocks.provisionInstalledHostCredential;
const spawnMock = vi.mocked(spawn);
const runHostStartMock = vi.mocked(runHostStart);

const signedInIdentity = {
  id: "u1",
  email: "ada@traycer.ai",
  name: "Ada",
};
const SIGNED_IN_LINE = `Signed in as ${signedInIdentity.email}.`;
const PROVISIONED_LINE = `${SIGNED_IN_LINE} Host authorized.`;
const UNREACHABLE_LINE =
  SIGNED_IN_LINE +
  " Host authorization not confirmed (the host did not respond in time) - run `traycer host doctor` to see how to fix it.";
const DEVICE_TOKEN = "minted-bearer";
const TOKEN_LOGIN_BEARER = "captured-bearer";
const RUNNING_HOST_URL = "ws://127.0.0.1:7100/rpc";

const authorizedDevice: DeviceAuthorizationResult = {
  kind: "started",
  deviceCode: "device-code",
  userCode: "ABCD-1234",
  verificationUri: "https://app.traycer.ai/device",
  verificationUriComplete: "https://app.traycer.ai/device?code=ABCD-1234",
  intervalSeconds: 0,
  expiresInSeconds: 3600,
};

const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");

function userWith(id: string, email: string, name: string): AuthenticatedUser {
  const base = createAuthenticatedUserFixture(undefined);
  return { ...base, user: { ...base.user, id, email, name } };
}

function makeCtx(): CommandContext {
  return makeCtxWithJson(false);
}

function makeCtxWithJson(json: boolean): CommandContext {
  const runtime: RuntimeContext = {
    json,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: config.environment,
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

function signedInData(
  credentialProvision: HostCredentialProvisionOutcome | null,
): {
  readonly user: typeof signedInIdentity;
  readonly bootstrap: null;
  readonly credentialProvision: HostCredentialProvisionOutcome | null;
} {
  return {
    user: signedInIdentity,
    bootstrap: null,
    credentialProvision,
  };
}

function stubStdin(chunks: readonly string[]): void {
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: {
      isTTY: false,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield Buffer.from(chunk);
      },
    },
  });
}

function pidPath(): string {
  return hostPidMetadataPath(config.environment);
}

async function removeHostPid(): Promise<void> {
  await rm(pidPath(), { force: true });
}

async function writeHostPid(pid: number): Promise<void> {
  const path = pidPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      pid,
      hostId: "host-1",
      version: "1.0.0",
      websocketUrl: RUNNING_HOST_URL,
      startedAt: "2026-10-30T00:00:00.000Z",
    }),
  );
}

function findDeadPid(): number {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = spawnSync(process.execPath, ["-e", "0"]);
    if (result.pid !== undefined && !isProcessAlive(result.pid)) {
      return result.pid;
    }
  }
  throw new Error("could not obtain a dead pid");
}

function expectOnlyBrowserOpens(): void {
  expect(spawnMock).toHaveBeenCalled();
  for (const call of spawnMock.mock.calls) {
    const command = call[0];
    expect(
      command === "open" || command === "xdg-open" || command === "rundll32",
    ).toBe(true);
  }
}

function expectUndialed(result: CommandResult): void {
  expect(provisionMock).not.toHaveBeenCalled();
  expect(result.exitCode).toBe(0);
  expect(result.human).toBe(SIGNED_IN_LINE);
  expect(result.data).toEqual(signedInData(null));
}

function expectProvisionedWith(result: CommandResult, token: string): void {
  expect(result.exitCode).toBe(0);
  expect(result.human).toBe(PROVISIONED_LINE);
  expect(result.data).toEqual(signedInData({ kind: "active", minted: true }));
  expect(provisionMock).toHaveBeenCalledTimes(1);
  expect(provisionMock).toHaveBeenCalledWith(
    expect.objectContaining({
      environment: config.environment,
      auth: {
        token,
        authnBaseUrl: config.authnBaseUrl,
        userId: signedInIdentity.id,
      },
    }),
  );
}

async function runDeviceLogin(): Promise<{
  readonly ctx: CommandContext;
  readonly result: CommandResult;
}> {
  const ctx = makeCtx();
  const result = await loginCommand(ctx);
  return { ctx, result };
}

async function runTokenLogin(): Promise<CommandResult> {
  stubStdin([
    JSON.stringify({ token: TOKEN_LOGIN_BEARER, refreshToken: "rt" }),
  ]);
  return buildLoginCommand({ token: "-" })(makeCtx());
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.home.path = await mkdtemp(join(tmpdir(), "traycer-cli-login-"));
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          session_grant: "login-host-token",
          session_grant_expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", mocks.fetch);
  provisionMock.mockReset();
  runHostStartMock.mockReset();
  provisionMock.mockResolvedValue({ kind: "active", minted: true });
  startAuthMock.mockReset();
  startAuthMock.mockResolvedValue(authorizedDevice);
  pollMock.mockReset();
  pollMock.mockResolvedValue({
    kind: "authorized",
    token: DEVICE_TOKEN,
    refreshToken: "minted-refresh",
  });
  identityMock.mockReset();
  identityMock.mockResolvedValue({
    kind: "valid",
    user: userWith(
      signedInIdentity.id,
      signedInIdentity.email,
      signedInIdentity.name,
    ),
  });
  await removeHostPid();
});

afterEach(async () => {
  const cleanupStartedAt = performance.now();
  const lockPath = `${cliCredentialsPath(config.environment)}.lock`;
  const lockPresentAtCleanup = existsSync(lockPath);
  if (lockPresentAtCleanup) {
    await vi.waitFor(() => expect(existsSync(lockPath)).toBe(false), {
      timeout: 10_000,
    });
  }
  console.info(
    `[timing] login-host-credential cleanup-at=${performance.now().toFixed(1)} elapsed=${(performance.now() - cleanupStartedAt).toFixed(1)}ms token-lock-at-entry=${lockPresentAtCleanup}`,
  );
  await removeHostPid();
  vi.unstubAllGlobals();
  const home = mocks.home.path;
  mocks.home.path = null;
  if (home !== null) await rm(home, { recursive: true, force: true });
  if (realStdin !== undefined) {
    Object.defineProperty(process, "stdin", realStdin);
  }
}, 15_000);

describe("traycer login credentials a host already running", () => {
  it("does not expose the account id when the identity has no email or name", async () => {
    identityMock.mockResolvedValue({
      kind: "valid",
      user: userWith("opaque-user-id", "", ""),
    });

    const { result } = await runDeviceLogin();

    expect(result.human).toBe("Signed in.");
  });

  it("provisions a credential when the running host reports missing", async () => {
    await writeHostPid(process.pid);

    const { ctx, result } = await runDeviceLogin();

    expectProvisionedWith(result, DEVICE_TOKEN);
    expect(ctx.progress).toHaveBeenCalledWith({
      stage: "host-credential",
      message: "authorizing the running host...",
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    expectOnlyBrowserOpens();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(
      await readFile(hostTokensPath(config.environment), "utf8"),
    ).toContain("login-host-token");
  });

  it("removes the prior account's host tokens when login switches accounts", async () => {
    await writeHostPid(process.pid);
    identityMock.mockResolvedValue({
      kind: "valid",
      user: userWith("old-user", "old@traycer.ai", "Old"),
    });
    pollMock.mockResolvedValue({
      kind: "authorized",
      token: "old-sign-in-token",
      refreshToken: "old-refresh-token",
    });
    await loginCommand(makeCtx());

    identityMock.mockResolvedValue({
      kind: "valid",
      user: userWith("new-user", "new@traycer.ai", "New"),
    });
    pollMock.mockResolvedValue({
      kind: "authorized",
      token: "new-sign-in-token",
      refreshToken: "new-refresh-token",
    });
    await loginCommand(makeCtx());

    const tokens = JSON.parse(
      await readFile(hostTokensPath(config.environment), "utf8"),
    );
    expect(tokens).not.toHaveProperty("users.old-user");
    expect(tokens).toHaveProperty(
      "users.new-user.host-1.token",
      "login-host-token",
    );
  });

  it("stays quiet when the running host already holds a credential", async () => {
    await writeHostPid(process.pid);
    provisionMock.mockResolvedValue({ kind: "active", minted: false });

    const result = await loginCommand(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.human).toBe(SIGNED_IN_LINE);
    expect(result.data).toEqual(
      signedInData({ kind: "active", minted: false }),
    );
    expect(provisionMock).toHaveBeenCalledTimes(1);
  });

  it("dials nothing when no pid record is published", async () => {
    const result = await loginCommand(makeCtx());

    expectUndialed(result);
    expectOnlyBrowserOpens();
  });

  it("dials nothing when the published pid is dead", async () => {
    await writeHostPid(findDeadPid());

    const result = await loginCommand(makeCtx());

    expectUndialed(result);
    expectOnlyBrowserOpens();
  });

  it("keeps exit 0 and names traycer host doctor when the running host is unreachable", async () => {
    const startedAt = performance.now();
    await writeHostPid(process.pid);
    provisionMock.mockResolvedValue({ kind: "unreachable" });

    const result = await loginCommand(makeCtx());
    console.info(
      `[timing] login-host-unreachable command-settled-at=${performance.now().toFixed(1)} elapsed=${(performance.now() - startedAt).toFixed(1)}ms`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.human).toBe(UNREACHABLE_LINE);
    expect(result.data).toEqual(signedInData({ kind: "unreachable" }));
    expect(provisionMock).toHaveBeenCalledTimes(1);
  });

  it("token login provisions a credential when the running host reports missing", async () => {
    await writeHostPid(process.pid);

    const result = await runTokenLogin();

    expectProvisionedWith(result, TOKEN_LOGIN_BEARER);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("token login dials nothing when no pid record is published", async () => {
    const result = await runTokenLogin();

    expectUndialed(result);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("manual host start uses a stored sign-in without prompting", () => {
  async function runManualStart(ctx: CommandContext): Promise<void> {
    runHostStartMock.mockImplementation(async (_options, injected) => {
      const onHostStarted = injected.onHostStarted;
      if (onHostStarted !== null && onHostStarted !== undefined) {
        await onHostStarted();
      }
    });
    await runHostStartCommand(
      ctx,
      { environment: config.environment, cwd: null },
      {},
    );
  }

  it("uses the sign-in just stored by login and reports the real probe outcome", async () => {
    await runTokenLogin();
    const baseCtx = makeCtx();
    const debug = vi.fn();
    const ctx: CommandContext = {
      ...baseCtx,
      runtime: { ...baseCtx.runtime, logger: { ...noopLogger, debug } },
    };

    await runManualStart(ctx);

    expect(runHostStartMock).toHaveBeenCalledTimes(1);
    expect(runHostStartMock.mock.calls[0]?.[0]).toEqual({
      environment: config.environment,
      cwd: null,
    });
    expect(runHostStartMock.mock.calls[0]?.[1].onHostStarted).toEqual(
      expect.any(Function),
    );
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: config.environment,
        auth: expect.objectContaining({ token: TOKEN_LOGIN_BEARER }),
      }),
    );
    expect(ctx.output.humanRequired).toHaveBeenCalledWith("host authorized");
    expect(ctx.output.emitResult).not.toHaveBeenCalled();
    expect(ctx.progress).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      "Host credential provisioning settled",
      expect.objectContaining({
        environment: config.environment,
        credentialProvision: { kind: "active", minted: true },
      }),
    );
  });

  it("keeps a caught probe diagnostic out of warning and info logs", async () => {
    const diagnostic =
      "credential-probe-marker path=/private/test/credentials body=distinctive";
    await runTokenLogin();
    provisionMock.mockRejectedValueOnce(new Error(diagnostic));
    const baseCtx = makeCtx();
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const ctx: CommandContext = {
      ...baseCtx,
      runtime: {
        ...baseCtx.runtime,
        logger: { ...noopLogger, warn, info, debug },
      },
    };

    await runManualStart(ctx);

    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Host credential provisioning threw; the command itself was unaffected",
      { kind: "error" },
    );
    expect(info).toHaveBeenCalledWith("Host credential provisioning settled", {
      environment: config.environment,
      outcome: "error",
    });
    expect(
      JSON.stringify({ warning: warn.mock.calls, info: info.mock.calls }),
    ).not.toContain(diagnostic);
    expect(JSON.stringify(debug.mock.calls)).toContain(diagnostic);
    expect(ctx.output.humanRequired).toHaveBeenCalledWith(
      "host authorization not confirmed - run " +
        String.fromCharCode(96) +
        "traycer host doctor" +
        String.fromCharCode(96) +
        " to see how to fix it",
    );
    expect(ctx.output.emitResult).not.toHaveBeenCalled();
  });

  it("keeps manual-start JSON stdout free of probe diagnostics and result envelopes", async () => {
    const diagnostic =
      "manual-json-probe-marker path=/private/test/credentials body=distinctive";
    await runTokenLogin();
    provisionMock.mockImplementationOnce(async () => {
      console.debug(diagnostic);
      return { kind: "active", minted: true };
    });
    const ctx = makeCtxWithJson(true);
    const originalConsole = {
      log: console.log,
      info: console.info,
      debug: console.debug,
    };
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
      callback: (() => void) | undefined,
    ) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      if (typeof callback === "function") callback();
      return true;
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
      callback: (() => void) | undefined,
    ) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      if (typeof callback === "function") callback();
      return true;
    }) as never);
    try {
      await runManualStart(ctx);
    } finally {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.debug = originalConsole.debug;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    const stdout = stdoutChunks.join("");
    expect(stdout).not.toContain(diagnostic);
    expect(stdout.trim()).toBe("");
    expect(stderrChunks.join("")).toContain(diagnostic);
    expect(ctx.progress).not.toHaveBeenCalled();
    expect(ctx.output.emitResult).not.toHaveBeenCalled();
  });

  it("keeps an already credentialed host quiet instead of minting another credential", async () => {
    await runTokenLogin();
    provisionMock.mockResolvedValue({ kind: "active", minted: false });
    const ctx = makeCtx();

    await runManualStart(ctx);

    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(ctx.output.humanRequired).not.toHaveBeenCalled();
    expect(ctx.output.emitResult).not.toHaveBeenCalled();
  });

  it("leaves a signed-out manual start alone without opening a sign-in flow", async () => {
    const ctx = makeCtx();

    await runManualStart(ctx);

    expect(startAuthMock).not.toHaveBeenCalled();
    expect(pollMock).not.toHaveBeenCalled();
    expect(provisionMock).not.toHaveBeenCalled();
    expect(ctx.output.humanRequired).not.toHaveBeenCalled();
    expect(ctx.output.emitResult).not.toHaveBeenCalled();
  });

  it("does not provision from a service-manager start identity", async () => {
    const ctx = makeCtx();
    await runHostStartCommand(
      ctx,
      {
        environment: config.environment,
        cwd: null,
        serviceLabel: "ai.traycer.host",
        adoptionNonce: null,
      },
      {},
    );

    expect(runHostStartMock.mock.calls[0]?.[1].onHostStarted).toBeNull();
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("does not provision from an authorized reclaim probe identity", async () => {
    const ctx = makeCtx();
    await runHostStartCommand(
      ctx,
      {
        environment: config.environment,
        cwd: null,
        probe: {
          transitionId: "transition-1",
          probeNonce: "probe-1",
          serviceLabel: "ai.traycer.host",
        },
      },
      {},
    );

    expect(runHostStartMock.mock.calls[0]?.[1].onHostStarted).toBeNull();
    expect(provisionMock).not.toHaveBeenCalled();
  });
});
