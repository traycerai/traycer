import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { ServiceInstallArgs } from "../service-install";
import {
  writeInstalledHostFixture,
  writeInstallRecordFixture,
} from "./service-install-host-fixture";

// `host service install` registers and starts host bytes that `host install`
// staged; it does not download them. With no install record (or a record whose
// executable is gone) the registration would be written and the service would
// then fail to spawn, surfacing only as a spawn-evidence timeout. The command
// instead refuses with the supervisor's own `E_HOST_NOT_INSTALLED` BEFORE any
// takeover, registration or adoption grant.
//
// The install record and executable are REAL files under a redirected HOME;
// only the OS service controller, sign-in and the CLI lock are substituted.
// `store/paths` binds its data root at module load, so every module under test
// is re-imported after the HOME redirect (same fixture as
// `service-install-plain-foreground.test.ts`).

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  installMock: vi.fn(),
  takeoverMock: vi.fn(),
  hostStartAdoptionLabelMock: vi.fn(),
  findLiveIncumbentHostMock: vi.fn(),
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      install: (...callArgs: Parameters<typeof mocks.installMock>) =>
        mocks.installMock(...callArgs),
      takeoverDesktopRegistration: (
        ...callArgs: Parameters<typeof mocks.takeoverMock>
      ) => mocks.takeoverMock(...callArgs),
      hostStartAdoptionLabel: (
        ...callArgs: Parameters<typeof mocks.hostStartAdoptionLabelMock>
      ) => mocks.hostStartAdoptionLabelMock(...callArgs),
    }),
    resolveServiceCliInvocation: async () => ({
      command: "/usr/local/bin/traycer",
      args: [] as string[],
    }),
    serviceLabelFor: (environment: "dev" | "production") => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
    serviceManifestPath: () => "/tmp/ai.traycer.host.plist",
    windowsTaskName: () => "ai.traycer.host",
  };
});

vi.mock("../../host/install-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/install-auth")>();
  return {
    ...actual,
    runSignInPreflight: async () => ({
      state: "signed-in" as const,
      reason: null,
    }),
    maybeProvisionCredential: async () => null,
  };
});

vi.mock("../../host/attested-install-runtime", () => ({
  attestInstallRuntime: async () => ({
    installGeneration: null,
    runtimeVersion: null,
    runtimeWasNull: false,
  }),
}));

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      _opts: { reason: string },
      fn: (handle: {
        path: string;
        metadata: Record<string, unknown>;
        release: () => Promise<void>;
      }) => Promise<T>,
    ): Promise<T> =>
      fn({ path: "/tmp/.lock", metadata: {}, release: async () => {} }),
  };
});

vi.mock("../../host/incumbent-check", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/incumbent-check")>();
  return {
    ...actual,
    findLiveIncumbentHost: (environment: string | undefined) =>
      mocks.findLiveIncumbentHostMock(environment),
  };
});

import { CLI_ERROR_CODES } from "../../runner/errors";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

function baseArgs(overrides: Partial<ServiceInstallArgs>): ServiceInstallArgs {
  return {
    enableLinger: true,
    allowSelfInvocation: false,
    takeover: false,
    attemptAdoption: null,
    lifecycleOrigin: "terminal",
    expectedHost: null,
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

async function installRecordPath(): Promise<string> {
  const { hostInstallRecordPath } = await import("../../store/paths");
  return hostInstallRecordPath("production");
}

async function run(
  overrides: Partial<ServiceInstallArgs>,
): Promise<{ readonly result: unknown; readonly caught: unknown }> {
  const { buildServiceInstallCommand } = await import("../service-install");
  let result: unknown = null;
  const caught: unknown = await buildServiceInstallCommand(baseArgs(overrides))(
    fakeCtx(),
  ).then(
    (value) => {
      result = value;
      return null;
    },
    (err: unknown) => err,
  );
  return { result, caught };
}

function expectNothingRegistered(): void {
  expect(mocks.takeoverMock).not.toHaveBeenCalled();
  expect(mocks.installMock).not.toHaveBeenCalled();
  expect(mocks.hostStartAdoptionLabelMock).not.toHaveBeenCalled();
}

beforeEach(async () => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-service-install-nohost-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  expect((await installRecordPath()).startsWith(workHome)).toBe(true);
  mocks.installMock.mockReset();
  mocks.installMock.mockResolvedValue(undefined);
  mocks.takeoverMock.mockReset();
  mocks.takeoverMock.mockResolvedValue({
    kind: "cli-host-stopped",
    cooperativeStop: "stopped",
  });
  mocks.hostStartAdoptionLabelMock.mockReset();
  mocks.hostStartAdoptionLabelMock.mockImplementation(
    async (label: { id: string }) => label.id,
  );
  mocks.findLiveIncumbentHostMock.mockReset();
  mocks.findLiveIncumbentHostMock.mockResolvedValue(null);
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
});

describe("buildServiceInstallCommand - host bytes not installed", () => {
  it("refuses E_HOST_NOT_INSTALLED naming 'traycer host install' when there is no install record, before any registration", async () => {
    expect(existsSync(await installRecordPath())).toBe(false);

    const { caught } = await run({});

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
      details: { environment: "production" },
    });
    expect((caught as { message: string }).message).toContain(
      "traycer host install",
    );
    expectNothingRegistered();
  }, 20_000);

  it("refuses a desktop --takeover the same way, before the Desktop registration is stopped or booted out", async () => {
    const { caught } = await run({
      takeover: true,
      lifecycleOrigin: "desktop",
    });

    expect(caught).toMatchObject({ code: CLI_ERROR_CODES.HOST_NOT_INSTALLED });
    expectNothingRegistered();
  }, 20_000);

  it("refuses E_HOST_NOT_INSTALLED when the record names an executable that is gone, before any registration", async () => {
    const missingExecutable = join(workHome, "gone", "traycer-host");
    writeInstallRecordFixture(await installRecordPath(), missingExecutable);

    const { caught } = await run({});

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
      details: { environment: "production", executablePath: missingExecutable },
    });
    const message = (caught as { message: string }).message;
    expect(message).toContain(missingExecutable);
    expect(message).toContain("traycer host install");
    expectNothingRegistered();
  }, 20_000);

  it("(control) registers once the install record and its executable exist", async () => {
    writeInstalledHostFixture(await installRecordPath());

    const { caught, result } = await run({});

    expect(caught).toBeNull();
    expect(result).toMatchObject({ exitCode: 0 });
    expect(mocks.installMock).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("(control) a --takeover proceeds through both actuators once the host is installed", async () => {
    writeInstalledHostFixture(await installRecordPath());

    const { caught } = await run({
      takeover: true,
      lifecycleOrigin: "desktop",
    });

    expect(caught).toBeNull();
    expect(mocks.takeoverMock).toHaveBeenCalledTimes(1);
    expect(mocks.installMock).toHaveBeenCalledTimes(1);
  }, 20_000);
});
