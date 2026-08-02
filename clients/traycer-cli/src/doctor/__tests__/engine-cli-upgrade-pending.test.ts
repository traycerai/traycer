import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Doctor must emit a stable `CLI_UPGRADE_PENDING` issue whenever the
// CLI install manifest has a non-null pendingUpgrade - Settings and
// Desktop's failure card key off this code to render the staged
// upgrade and offer a `host restart` fix that releases the binary
// lock.
//
// This test isolates the doctor engine from the host supervisor /
// service-controller checks (which require a real host install +
// platform service manager) by mocking the supporting reads. We only
// care here that the pending-upgrade issue is produced and shaped
// correctly.

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

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-pending-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
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
  vi.restoreAllMocks();
  vi.doUnmock("../../manifest/host-install");
  vi.doUnmock("../../host/bootstrap-log");
  vi.doUnmock("../../host/pid-metadata");
  vi.doUnmock("../../service");
});

function stageDoctorMocks() {
  // Pretend no host is installed and no service is registered.
  // That suppresses every other doctor issue except the install-record
  // one, which is acceptable noise for this test - we just assert
  // that the pending-upgrade issue is also produced.
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => null,
  }));
  vi.doMock("../../host/bootstrap-log", () => ({
    readBootstrapMarkers: async () => [],
  }));
  vi.doMock("../../host/pid-metadata", () => ({
    readHostPidMetadata: async () => null,
  }));
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: "not-installed",
        version: null,
        listenUrl: null,
        pid: null,
      }),
      install: async () => undefined,
      uninstall: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
    }),
    serviceLabelFor: (environment: "production" | "dev") => ({
      id: `ai.traycer.host.${environment}`,
    }),
  }));
}

function writePendingManifest(opts: {
  readonly version: string;
  readonly stagedBinaryPath: string;
  readonly liveBinaryPath: string;
  readonly stagedExists: boolean;
}): void {
  const cliDir = join(workHome, ".traycer", "cli");
  mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  if (opts.stagedExists) {
    mkdirSync(join(opts.stagedBinaryPath, ".."), { recursive: true });
    writeFileSync(opts.stagedBinaryPath, "staged");
  }
  writeFileSync(opts.liveBinaryPath, "live", { encoding: "utf8" });
  writeFileSync(
    join(cliDir, "manifest.json"),
    JSON.stringify(
      {
        version: "1.4.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: opts.liveBinaryPath,
        source: "manual",
        pendingUpgrade: {
          version: opts.version,
          stagedBinaryPath: opts.stagedBinaryPath,
          stagedAt: "2026-05-10T00:00:00Z",
          reason: "binary-locked",
        },
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
}

describe("runDoctor pending CLI upgrade surface", () => {
  it("emits CLI_UPGRADE_PENDING with host-restart fix when staged binary is on disk", async () => {
    stageDoctorMocks();
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writePendingManifest({
      version: "1.5.0",
      stagedBinaryPath,
      liveBinaryPath,
      stagedExists: true,
    });

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });
    const issue = result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.fixAction).toBe("host-restart");
    expect(issue?.terminalCommand).toMatch(/traycer host restart/);
    expect(issue?.title).toContain("1.5.0");
    expect(issue?.details).toMatchObject({
      stagedVersion: "1.5.0",
      stagedBinaryPath,
      reason: "binary-locked",
      currentVersion: "1.4.0",
      binaryPath: liveBinaryPath,
    });
  });

  it("emits CLI_UPGRADE_PENDING with null fixAction when staged binary is missing", async () => {
    stageDoctorMocks();
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0-missing");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writePendingManifest({
      version: "1.5.0",
      stagedBinaryPath,
      liveBinaryPath,
      stagedExists: false,
    });

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });
    const issue = result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    // No Doctor auto-fix button - Desktop's failure card doesn't proxy
    // `cli upgrade` through the host management IPC, so we leave
    // recovery to the user via the terminal command.
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toMatch(/traycer cli upgrade/);
    expect(issue?.title).toContain("missing");
  });

  it("does not emit CLI_UPGRADE_PENDING when manifest has no pendingUpgrade", async () => {
    stageDoctorMocks();
    const cliDir = join(workHome, ".traycer", "cli");
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(cliDir, "manifest.json"),
      JSON.stringify(
        {
          version: "1.5.0",
          installedAt: "2026-04-01T00:00:00Z",
          binaryPath: join(workHome, "bin", "traycer"),
          source: "manual",
          pendingUpgrade: null,
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });
    expect(
      result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING"),
    ).toBeUndefined();
  });

  it("does not emit CLI_UPGRADE_PENDING when no CLI manifest exists", async () => {
    stageDoctorMocks();
    // No manifest file written - fresh install with no CLI upgrade
    // state at all.
    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });
    expect(
      result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING"),
    ).toBeUndefined();
  });

  it("folds in a 'swapped' post-finalize marker before checking pendingUpgrade - no CLI_UPGRADE_PENDING is emitted afterwards", async () => {
    // The detached helper from a prior `host restart` succeeded and
    // wrote a post-finalize marker. Doctor must consume that marker
    // and clear pendingUpgrade *before* reading the manifest, so the
    // user sees the resolved state immediately on next `host
    // doctor` without first having to run another `host restart`.
    stageDoctorMocks();
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writePendingManifest({
      version: "1.5.0",
      stagedBinaryPath,
      liveBinaryPath,
      stagedExists: true,
    });
    // Helper marker written by a previous detached run.
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swapped",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath,
        errorMessage: null,
        serviceStartError: null,
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });
    expect(
      result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING"),
    ).toBeUndefined();
    // Marker was consumed.
    const { existsSync } = await import("node:fs");
    expect(existsSync(markerPath)).toBe(false);
    // Manifest's pendingUpgrade has been cleared.
    const manifestPath = join(workHome, ".traycer", "cli", "manifest.json");
    const reread = JSON.parse(
      (await import("node:fs")).readFileSync(manifestPath, "utf8"),
    );
    expect(reread.pendingUpgrade).toBeNull();
    expect(reread.version).toBe("1.5.0");
  });

  it("still emits CLI_UPGRADE_PENDING when the prior helper attempt was swap-failed (pending state retained)", async () => {
    stageDoctorMocks();
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writePendingManifest({
      version: "1.5.0",
      stagedBinaryPath,
      liveBinaryPath,
      stagedExists: true,
    });
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swap-failed",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath,
        errorMessage: "MoveFileEx error 5: Access denied",
        serviceStartError: null,
      }),
    );

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });
    const issue = result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.fixAction).toBe("host-restart");
    // Marker still consumed so the next reconcile reads only fresh
    // helper outcomes.
    const { existsSync } = await import("node:fs");
    expect(existsSync(markerPath)).toBe(false);
  });
});
