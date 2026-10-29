import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
import { config } from "../../config";
import type { HostCredentialProvisionOutcome } from "../../host/credential-provisioning";
import { noopLogger } from "../../logger";
import type { CommandContext, CommandResult } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";
import { isProcessAlive } from "../../store/cli-lock";
import { hostPidMetadataPath } from "../../store/paths";

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
}));

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

const signedInIdentity = {
  id: "u1",
  email: "ada@traycer.ai",
  name: "Ada",
};
const SIGNED_IN_LINE = `Signed in as ${signedInIdentity.email}.`;
const PROVISIONED_LINE = `${SIGNED_IN_LINE} Host credential provisioned.`;
const UNREACHABLE_LINE =
  SIGNED_IN_LINE +
  " Host credential not provisioned (the host did not respond in time) - run `traycer host doctor` to see how to fix it.";
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
  const runtime: RuntimeContext = {
    json: false,
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
  provisionMock.mockReset();
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
  await removeHostPid();
  if (realStdin !== undefined) {
    Object.defineProperty(process, "stdin", realStdin);
  }
});

describe("traycer login credentials a host already running", () => {
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
    await writeHostPid(process.pid);
    provisionMock.mockResolvedValue({ kind: "unreachable" });

    const result = await loginCommand(makeCtx());

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
