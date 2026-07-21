import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `host restart`'s command-level wiring (Host Update Layer Redesign Tech
// Plan, "Lifecycle lock coverage" + "host restart --if-idle"): the whole
// marker-reconcile -> stop -> finalize -> start sequence runs inside ONE
// `cli-lock` acquisition, and `--if-idle` gates immediately before it
// with a fresh busy probe. `restartWithPendingCliUpgradeFinalize` itself
// is already covered end-to-end (stub controller, real manifest I/O)
// by host-restart-finalize.test.ts - these tests only need to prove the
// NEW command-level wrapping (lock span, ordering, --if-idle gating),
// so the service controller is stubbed here too.

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  busyOverride: null as "busy" | null,
  busyCalls: [] as Array<string | undefined>,
  lockCalls: [] as Array<{ reason: string }>,
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      install: async () => undefined,
      uninstall: async () => undefined,
      status: async () => ({
        state: "stopped" as const,
        version: null,
        listenUrl: null,
        pid: null,
      }),
      stop: async () => {
        mocks.controllerCalls.push("stop");
      },
      start: async () => {
        mocks.controllerCalls.push("start");
      },
      restart: async () => {
        mocks.controllerCalls.push("restart");
      },
    }),
  };
});

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async (environment: string | undefined) => {
    mocks.busyCalls.push(environment);
    if (mocks.busyOverride === "busy") {
      throw Object.assign(new Error("host is busy"), { code: "E_HOST_BUSY" });
    }
  },
}));

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      opts: { reason: string },
      fn: () => Promise<T>,
    ): Promise<T> => {
      mocks.lockCalls.push({ reason: opts.reason });
      return fn();
    },
  };
});

import type { CommandContext } from "../../runner/runner";

// `store/paths` binds its home root from `os.homedir()` at module load.
// Keep the environment mutation below, but redirect `homedir()` too.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

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

async function writeInstallRecordForAttestation(): Promise<void> {
  const { writeHostInstallRecord } =
    await import("../../manifest/host-install");
  await writeHostInstallRecord("production", {
    installId: "restart-attestation-install",
    version: "1.7.0",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: "1.7.0" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: join(workHome, "host", "traycer-host"),
  });
}

describe("buildHostRestartCommand", () => {
  beforeEach(() => {
    workHome = mkdtempSync(join(tmpdir(), "traycer-host-restart-cmd-test-"));
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    // `store/paths` captures `homedir()` once at module load - drop the
    // module cache so each test (and the dynamic import below) sees its
    // own tmp HOME, matching host-restart-finalize.test.ts's pattern.
    vi.resetModules();
    mocks.controllerCalls = [];
    mocks.busyOverride = null;
    mocks.busyCalls = [];
    mocks.lockCalls = [];
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

  it("wraps the whole restart in one cli-lock acquisition, without a busy probe by default", async () => {
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({ ifIdle: false });
    await command(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "host-restart" }]);
    expect(mocks.busyCalls).toHaveLength(0);
    expect(mocks.controllerCalls).toEqual(["stop", "start"]);
  });

  it("plain restart proceeds unconditionally even when the host is busy", async () => {
    mocks.busyOverride = "busy";
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({ ifIdle: false });
    const result = await command(fakeCtx());

    expect(mocks.busyCalls).toHaveLength(0);
    expect(mocks.controllerCalls).toEqual(["stop", "start"]);
    expect(result.data).toMatchObject({ restarted: true });
  });

  it("returns the install record it observed under cli-lock for Desktop's post-restart CAS", async () => {
    await writeInstallRecordForAttestation();
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({ ifIdle: false });

    const result = await command(fakeCtx());

    expect(result.data).toMatchObject({
      runtimeVersion: null,
      runtimeWasNull: true,
      installGeneration: expect.stringContaining("restart-attestation-install"),
    });
  });

  it("--if-idle probes busy (inside the lock) before stop, and proceeds when idle", async () => {
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({ ifIdle: true });
    await command(fakeCtx());

    expect(mocks.busyCalls).toEqual(["production"]);
    expect(mocks.controllerCalls).toEqual(["stop", "start"]);
  });

  it("--if-idle refuses with E_HOST_BUSY before stop is ever called, and never proceeds", async () => {
    mocks.busyOverride = "busy";
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({ ifIdle: true });

    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_HOST_BUSY",
    });
    expect(mocks.controllerCalls).toEqual([]);
  });
});
