import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// Same isolation as `stageDoctorMocks`, but with the OS service reporting
// `running`. Used by the recovered-host case: doctor's marker-derived
// service-start report has to key off current state, not just the marker.
function stageDoctorMocksWithRunningService() {
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
        state: "running",
        version: "1.5.0",
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

// `stageDoctorMocks` with a bootstrap history: the host is DOWN now, but the
// log shows it started after a given moment. Used to prove the finalize
// marker's service-start report keys off recovery history and not only current
// liveness - the two differ once the host comes up and later stops again.
function stageDoctorMocksWithStartAt(startedAt: string) {
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => null,
  }));
  vi.doMock("../../host/bootstrap-log", () => ({
    readBootstrapMarkers: async () => [
      { timestamp: startedAt, phase: "starting", fields: {} },
    ],
  }));
  vi.doMock("../../host/pid-metadata", () => ({
    readHostPidMetadata: async () => null,
  }));
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: "stopped",
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

  // CLI-007: doctor used to fold a "swapped" marker into the manifest and
  // delete it (`reconcilePostFinalizeMarker`), so a second `host doctor` run
  // over the same disk state gave a different answer than the first - a
  // diagnostic that destroys the evidence it reports. It now only READS the
  // marker (`readPostFinalizeMarker`) and reports what it finds; folding the
  // marker into the manifest is `host restart`'s job.
  it("reports a 'swapped' post-finalize marker as CLI_UPGRADE_FINALIZED_UNRECONCILED without touching the marker or the manifest", async () => {
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
    const markerBody = JSON.stringify({
      status: "swapped",
      attemptedAt: "2026-05-11T00:00:00Z",
      livePath: liveBinaryPath,
      stagedBinaryPath,
      errorMessage: null,
      serviceStartError: null,
    });
    writeFileSync(markerPath, markerBody, { encoding: "utf8", mode: 0o600 });
    const manifestPath = join(workHome, ".traycer", "cli", "manifest.json");
    const manifestBefore = readFileSync(manifestPath, "utf8");

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    expect(
      result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING"),
    ).toBeUndefined();
    const settled = result.issues.find(
      (i) => i.code === "CLI_UPGRADE_FINALIZED_UNRECONCILED",
    );
    expect(settled).toBeDefined();
    expect(settled?.severity).toBe("info");
    expect(settled?.fixAction).toBe("host-restart");
    expect(settled?.terminalCommand).toMatch(/traycer host restart/);
    // `host doctor`'s exit code is keyed off error/fatal severities
    // (commands/host-doctor.ts) - an `info` issue for an already-applied
    // upgrade must not itself flip a doctor run to failing.
    expect(settled?.severity).not.toBe("error");
    expect(settled?.severity).not.toBe("fatal");
    // Read-only: the marker and the manifest are untouched.
    expect(readFileSync(markerPath, "utf8")).toBe(markerBody);
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
  });

  it("reports a 'swap-failed' post-finalize marker as CLI_UPGRADE_FINALIZE_FAILED without consuming the marker", async () => {
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
    const markerBody = JSON.stringify({
      status: "swap-failed",
      attemptedAt: "2026-05-11T00:00:00Z",
      livePath: liveBinaryPath,
      stagedBinaryPath,
      errorMessage: "MoveFileEx error 5: Access denied",
      serviceStartError: null,
    });
    writeFileSync(markerPath, markerBody);

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    expect(
      result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING"),
    ).toBeUndefined();
    const failed = result.issues.find(
      (i) => i.code === "CLI_UPGRADE_FINALIZE_FAILED",
    );
    expect(failed).toBeDefined();
    expect(failed?.severity).toBe("warning");
    expect(failed?.message).toContain("MoveFileEx error 5: Access denied");
    // Not consumed - a diagnostic must be safe to run twice.
    expect(readFileSync(markerPath, "utf8")).toBe(markerBody);
  });

  // The finding CLI-007 exists to prove: a diagnostic that destroys the
  // evidence it reports cannot be trusted, and cannot be run twice. Running
  // `runDoctor` twice back to back over the same real temp-dir marker and
  // manifest files must leave both byte-identical.
  it("running runDoctor twice leaves the marker file and the CLI manifest byte-identical", async () => {
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
    const markerBody = JSON.stringify({
      status: "swapped",
      attemptedAt: "2026-05-11T00:00:00Z",
      livePath: liveBinaryPath,
      stagedBinaryPath,
      errorMessage: null,
      serviceStartError: null,
    });
    writeFileSync(markerPath, markerBody, { encoding: "utf8", mode: 0o600 });
    const manifestPath = join(workHome, ".traycer", "cli", "manifest.json");

    const { runDoctor } = await import("../engine");
    const firstResult = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });
    const markerAfterFirst = readFileSync(markerPath, "utf8");
    const manifestAfterFirst = readFileSync(manifestPath, "utf8");

    const secondResult = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });
    const markerAfterSecond = readFileSync(markerPath, "utf8");
    const manifestAfterSecond = readFileSync(manifestPath, "utf8");

    expect(markerAfterSecond).toBe(markerAfterFirst);
    expect(manifestAfterSecond).toBe(manifestAfterFirst);
    // Same question, same answer - not just "the files didn't change".
    expect(
      secondResult.issues.find(
        (i) => i.code === "CLI_UPGRADE_FINALIZED_UNRECONCILED",
      ),
    ).toEqual(
      firstResult.issues.find(
        (i) => i.code === "CLI_UPGRADE_FINALIZED_UNRECONCILED",
      ),
    );
  });

  // A marker carries no version - only the paths it operated on - so "a marker
  // exists" is not evidence about the upgrade the manifest is CURRENTLY
  // pending. A helper that swapped 1.5.0 can leave its marker behind, and a
  // later `cli upgrade` overwrites pendingUpgrade with 1.6.0 without clearing
  // it. Believing the stale marker would tell the user 1.6.0 was already
  // applied - the opposite of true, and unfalsifiable from the card.
  it("ignores a post-finalize marker that belongs to a DIFFERENT staged upgrade", async () => {
    stageDoctorMocks();
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.6.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writePendingManifest({
      version: "1.6.0",
      stagedBinaryPath,
      liveBinaryPath,
      stagedExists: true,
    });
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    // Marker from the PRIOR 1.5.0 swap, never consumed.
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swapped",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath: join(workHome, "bin", "traycer-1.5.0"),
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

    // The pending 1.6.0 upgrade is still pending, and must be reported as such.
    expect(
      result.issues.find(
        (i) => i.code === "CLI_UPGRADE_FINALIZED_UNRECONCILED",
      ),
    ).toBeUndefined();
    const pending = result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING");
    expect(pending).toBeDefined();
    // The stale marker is still surfaced in details for anyone investigating.
    expect(pending?.details?.finalizeMarker).toBe("swapped");
  });

  // A matching `swap-failed` marker must not mask the missing-stage recovery.
  // `host restart` - the fix the finalize-failed card offers - would consume
  // the marker, find no bytes to finalize, and leave the upgrade pending
  // exactly as it was. Only the re-stage guidance actually recovers this.
  it("prefers the re-stage guidance over the finalize-failed card when the staged binary is gone", async () => {
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
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swap-failed",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath,
        errorMessage: "EBUSY",
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
      result.issues.find((i) => i.code === "CLI_UPGRADE_FINALIZE_FAILED"),
    ).toBeUndefined();
    const pending = result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING");
    expect(pending).toBeDefined();
    expect(pending?.title).toContain("missing");
    expect(pending?.terminalCommand).toMatch(/traycer cli upgrade/);
  });

  // The NORMAL on-disk state for "helper swapped the CLI, then could not start
  // the service": `finalizePendingCliUpgrade` clears pendingUpgrade on success
  // and the marker recording the service-start failure is written afterwards.
  // Gating marker interpretation on `pendingUpgrade !== null` therefore lost
  // the helper's error in exactly the case it exists to explain.
  it("reports a swapped marker's serviceStartError even though the pending upgrade is already cleared", async () => {
    stageDoctorMocks();
    const cliDir = join(workHome, ".traycer", "cli");
    const liveBinaryPath = join(workHome, "bin", "traycer");
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(
      join(cliDir, "manifest.json"),
      JSON.stringify(
        {
          version: "1.5.0",
          installedAt: "2026-04-01T00:00:00Z",
          binaryPath: liveBinaryPath,
          source: "manual",
          // Already cleared by the successful swap - the point of the test.
          pendingUpgrade: null,
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    const markerPath = join(cliDir, "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swapped",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath: join(workHome, "bin", "traycer-1.5.0"),
        errorMessage: null,
        serviceStartError: "launchctl kickstart failed: Input/output error",
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    const issue = result.issues.find(
      (i) => i.code === "CLI_UPGRADE_SERVICE_START_FAILED",
    );
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("Input/output error");
    expect(issue?.terminalCommand).toMatch(/traycer host restart/);
    // Not an upgrade to retry - the upgrade worked; only the service is down.
    expect(
      result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING"),
    ).toBeUndefined();
    // Still observational.
    expect(existsSync(markerPath)).toBe(true);
  });

  // The marker records what happened at `attemptedAt` and then persists until
  // some later `host restart` reconciles it. On a machine whose supervisor
  // already recovered the host, warning that "the host is down" would assert
  // something this very doctor run has evidence against - the failure mode
  // this whole PR is about, arriving via a stale file instead of a return
  // value.
  it("downgrades the service-start failure to non-actionable history once the host is running again", async () => {
    stageDoctorMocksWithRunningService();
    const cliDir = join(workHome, ".traycer", "cli");
    const liveBinaryPath = join(workHome, "bin", "traycer");
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(
      join(cliDir, "manifest.json"),
      JSON.stringify(
        {
          version: "1.5.0",
          installedAt: "2026-04-01T00:00:00Z",
          binaryPath: liveBinaryPath,
          source: "manual",
          pendingUpgrade: null,
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(
      join(cliDir, "post-finalize.json"),
      JSON.stringify({
        status: "swapped",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath: join(workHome, "bin", "traycer-1.5.0"),
        errorMessage: null,
        serviceStartError: "launchctl kickstart failed: Input/output error",
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    const issue = result.issues.find(
      (i) => i.code === "CLI_UPGRADE_SERVICE_START_FAILED",
    );
    expect(issue).toBeDefined();
    // Info, not warning: nothing is broken now, and it must not flip the
    // doctor exit code for a healthy machine.
    expect(issue?.severity).toBe("info");
    // No repair offered, because there is nothing left to repair.
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
    expect(issue?.details?.hostRunningNow).toBe(true);
    // The helper's error is still quoted - it explains the past outage.
    expect(issue?.message).toContain("Input/output error");
  });

  // History QUALIFIES the report; it does not suppress it. A `starting` marker
  // is written before the child is even spawned, so it proves another attempt
  // began - not that it succeeded - and the host is observably down right now,
  // which is the actionable part. So: still a warning with a fix, but the copy
  // says a start has happened since, and the two facts stay in separate
  // details fields so nothing can read one as the other.
  it("keeps the service-start failure actionable while the host is down, but notes a start since", async () => {
    // Host is DOWN now (service "stopped", no pid metadata) but the bootstrap
    // log shows a start AFTER the marker was written.
    stageDoctorMocksWithStartAt("2026-05-12T00:00:00Z");
    const cliDir = join(workHome, ".traycer", "cli");
    const liveBinaryPath = join(workHome, "bin", "traycer");
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(
      join(cliDir, "manifest.json"),
      JSON.stringify(
        {
          version: "1.5.0",
          installedAt: "2026-04-01T00:00:00Z",
          binaryPath: liveBinaryPath,
          source: "manual",
          pendingUpgrade: null,
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(
      join(cliDir, "post-finalize.json"),
      JSON.stringify({
        status: "swapped",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath: join(workHome, "bin", "traycer-1.5.0"),
        errorMessage: null,
        serviceStartError: "launchctl kickstart failed: Input/output error",
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    const issue = result.issues.find(
      (i) => i.code === "CLI_UPGRADE_SERVICE_START_FAILED",
    );
    expect(issue).toBeDefined();
    // The host is down, so this stays actionable - `starting` is not evidence
    // that any later attempt succeeded.
    expect(issue?.severity).toBe("warning");
    expect(issue?.fixAction).toBe("host-restart");
    // ...but the two facts must not be conflated. Claiming "running now" while
    // the service and pid probes both say otherwise is the contradiction this
    // separation exists to prevent.
    expect(issue?.details?.hostRunningNow).toBe(false);
    expect(issue?.details?.startAttemptedSinceFailure).toBe(true);
    expect(issue?.message).not.toContain("The host is running now");
    // The qualifier the history buys: the current outage may be unrelated.
    expect(issue?.message).toContain("may have a different cause");
  });

  // The other arrangement that loses the causal error: an OLD swapped marker
  // carrying a serviceStartError survives while a LATER `cli upgrade` records
  // a new pending upgrade. `postFinalizeMarkerIssue` correctly rejects that
  // marker as stale, so gating this report on "nothing pending" meant nobody
  // reported the failure at all - while the host stayed down for exactly the
  // reason the marker names.
  it("still reports a stale marker's service-start error when a NEWER upgrade is pending", async () => {
    stageDoctorMocks();
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const pendingStagedPath = join(workHome, "bin", "traycer-1.6.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writePendingManifest({
      version: "1.6.0",
      stagedBinaryPath: pendingStagedPath,
      liveBinaryPath,
      stagedExists: true,
    });
    writeFileSync(
      join(workHome, ".traycer", "cli", "post-finalize.json"),
      JSON.stringify({
        status: "swapped",
        // Predates the pending 1.6.0 staging and names the 1.5.0 staged path,
        // so `markerDescribesUpgrade` rejects it for the pending card.
        attemptedAt: "2026-05-09T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath: join(workHome, "bin", "traycer-1.5.0"),
        errorMessage: null,
        serviceStartError: "launchctl kickstart failed: Input/output error",
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    const startFailure = result.issues.find(
      (i) => i.code === "CLI_UPGRADE_SERVICE_START_FAILED",
    );
    expect(startFailure).toBeDefined();
    expect(startFailure?.message).toContain("Input/output error");
    // ...and the newer pending upgrade is still reported on its own card.
    expect(
      result.issues.find((i) => i.code === "CLI_UPGRADE_PENDING"),
    ).toBeDefined();
    // The stale marker must NOT be read as completing the newer upgrade.
    expect(
      result.issues.find(
        (i) => i.code === "CLI_UPGRADE_FINALIZED_UNRECONCILED",
      ),
    ).toBeUndefined();
  });

  // `invalid` (read the bytes, they were nonsense) and `unreadable` (could not
  // read the bytes at all) license different advice. Reconciliation unlinks
  // the first but returns without unlinking on a read failure, so offering
  // `host restart` for the second promises a repair that cannot happen.
  // A directory at the marker path makes `readFile` fail deterministically
  // (EISDIR) regardless of which user runs the suite - a chmod-based fixture
  // would silently not apply under root.
  it("offers no repair when the marker cannot be read at all, only when it cannot be parsed", async () => {
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
    mkdirSync(join(cliDir, "post-finalize.json"), { recursive: true });

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    const issue = result.issues.find(
      (i) => i.code === "CLI_UPGRADE_MARKER_UNREADABLE",
    );
    expect(issue).toBeDefined();
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
    // The message must not send the reader to a command that cannot help.
    expect(issue?.message).toContain("permissions");
  });

  // `readPostFinalizeMarker` separates `invalid` from `absent` precisely so the
  // fault can be reported. Consulting that only inside the pending-upgrade
  // branch would mean a corrupt marker on a manifest with nothing pending
  // produces silence, and doctor calls the CLI-upgrade state clean while a file
  // it could not parse sits on disk shaping the next `host restart`.
  it("reports an unreadable finalize marker even when no upgrade is pending", async () => {
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
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    const markerBody = "{ not valid json";
    writeFileSync(markerPath, markerBody, { encoding: "utf8", mode: 0o600 });

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: null,
    });

    // Its OWN code, not the read-failure one: reconciliation unlinks an
    // unparseable marker, so `host restart` genuinely clears it, whereas a
    // marker it cannot read at all is left in place. Opposite remediations
    // must not share a code, or a consumer grouping by `code` has to parse
    // message prose to tell which advice applies.
    const unparseable = result.issues.find(
      (i) => i.code === "CLI_UPGRADE_MARKER_UNPARSEABLE",
    );
    expect(unparseable).toBeDefined();
    expect(unparseable?.severity).toBe("warning");
    expect(
      result.issues.find((i) => i.code === "CLI_UPGRADE_MARKER_UNREADABLE"),
    ).toBeUndefined();
    // The fixture creates the marker directory 0o700 under the test user, so
    // it IS writable and this branch must offer the repair that works.
    // Pinning both sides of that conditional, since probing writability
    // existed precisely to stop advertising a deletion that cannot happen.
    expect(unparseable?.fixAction).toBe("host-restart");
    expect(unparseable?.terminalCommand).toMatch(/traycer host restart/);
    expect(unparseable?.details?.markerDirWritable).toBe(true);
    // Still observational: reporting the fault must not repair it.
    expect(readFileSync(markerPath, "utf8")).toBe(markerBody);
  });
});
