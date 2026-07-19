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

// Coverage for the detached pending-CLI-upgrade finalize helper:
//
//  - scheduleFinalizationHelper writes a platform-appropriate script,
//    invokes the spawn stub with detached/ignored stdio flags, and
//    returns a structured result identifying the helper pid.
//  - The rendered script body contains the parent pid + live/staged
//    binary paths and, once the parent exits, hands off to the staged
//    binary's own hidden `cli finalize-upgrade` command (tested
//    separately in commands/__tests__/cli-finalize-upgrade*.test.ts) -
//    we don't actually execute the rendered script here, but the
//    contract is asserted on the rendered body.
//  - reconcilePostFinalizeMarker folds a "swapped" marker into the
//    CLI install manifest (clears pendingUpgrade, promotes version),
//    leaves the manifest unchanged on "swap-failed"/"parent-still-
//    alive", and consumes the marker either way.

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
  workHome = mkdtempSync(join(tmpdir(), "traycer-finalize-helper-test-"));
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
});

function writeManifest(opts: {
  readonly liveBinaryPath: string;
  readonly stagedBinaryPath: string;
  readonly version: string;
  readonly currentVersion: string;
}): string {
  const cliDir = join(workHome, ".traycer", "cli");
  mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(cliDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version: opts.currentVersion,
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
  return manifestPath;
}

describe("scheduleFinalizationHelper", () => {
  it("renders a PowerShell script with parent pid + paths and spawns powershell.exe detached on Windows", async () => {
    const spawnCalls: Array<{
      command: string;
      args: readonly string[];
      options: { readonly detached?: boolean; readonly stdio?: unknown };
    }> = [];
    const writeCalls: Array<{ path: string; body: string }> = [];
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      environment: "production",
      stagedBinaryPath: "C:/Users/dev/AppData/.traycer/cli/traycer-1.5.0.exe",
      livePath: "C:/Users/dev/AppData/.traycer/cli/traycer.exe",
      parentPid: 4242,
      parentExitTimeoutSeconds: 60,
      platform: "win32",
      spawnImpl: (command, args, options) => {
        spawnCalls.push({
          command,
          args,
          options: options as { detached?: boolean; stdio?: unknown },
        });
        return { pid: 99001, unref: () => undefined };
      },
      writeImpl: async (path, body) => {
        writeCalls.push({ path, body });
      },
    });

    expect(result.status).toBe("scheduled");
    expect(result.helperPid).toBe(99001);
    expect(result.platform).toBe("win32");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toBe("powershell.exe");
    expect(spawnCalls[0]?.args).toContain("-NoProfile");
    expect(spawnCalls[0]?.args).toContain("-ExecutionPolicy");
    expect(spawnCalls[0]?.args).toContain("-File");
    expect(spawnCalls[0]?.options.detached).toBe(true);
    expect(spawnCalls[0]?.options.stdio).toBe("ignore");

    expect(writeCalls).toHaveLength(1);
    const body = writeCalls[0]?.body ?? "";
    expect(body).toMatch(/\$ParentPid\s*=\s*4242/);
    expect(body).toContain("C:/Users/dev/AppData/.traycer/cli/traycer.exe");
    expect(body).toContain(
      "C:/Users/dev/AppData/.traycer/cli/traycer-1.5.0.exe",
    );
    // The parked-still-alive marker write (only reachable path owned by
    // this script now) still targets post-finalize.json.
    expect(body).toContain("post-finalize.json");
    // Binary swap + service start hand off to the staged binary's own
    // hidden `cli finalize-upgrade` command - it acquires cli-lock
    // under its own PID + start-time identity (Host Update Layer
    // Redesign Tech Plan, "Windows CLI-finalize helper").
    expect(body).toContain("$StagedBinary cli finalize-upgrade");
    expect(body).not.toContain("Move-Item -Force -LiteralPath $StagedBinary");
    expect(body).not.toContain("Start-Service");
  });

  it("renders a POSIX shell script with parent pid + paths and spawns /bin/sh detached on linux", async () => {
    const spawnCalls: Array<{
      command: string;
      args: readonly string[];
    }> = [];
    const writeCalls: Array<{ path: string; body: string }> = [];
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      environment: "production",
      stagedBinaryPath: "/usr/local/share/traycer/cli/traycer-1.5.0",
      livePath: "/usr/local/share/traycer/cli/traycer",
      parentPid: 4242,
      parentExitTimeoutSeconds: 60,
      platform: "linux",
      spawnImpl: (command, args) => {
        spawnCalls.push({ command, args });
        return { pid: 88001, unref: () => undefined };
      },
      writeImpl: async (path, body) => {
        writeCalls.push({ path, body });
      },
    });
    expect(result.status).toBe("scheduled");
    expect(result.helperPid).toBe(88001);
    expect(spawnCalls[0]?.command).toBe("/bin/sh");
    const body = writeCalls[0]?.body ?? "";
    expect(body).toContain("#!/usr/bin/env sh");
    expect(body).toContain("4242");
    expect(body).toContain("/usr/local/share/traycer/cli/traycer");
    // Binary swap + service start hand off to the staged binary's own
    // hidden `cli finalize-upgrade` command, same as the Windows script.
    expect(body).toContain('"$STAGED" cli finalize-upgrade');
    expect(body).not.toContain('mv -f "$STAGED" "$LIVE"');
    expect(body).not.toContain("launchctl");
    expect(body).not.toContain("systemctl");
  });

  it("returns status='failed' when the write stub throws and never invokes spawn", async () => {
    const spawnCalls: Array<{ command: string }> = [];
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      environment: "production",
      stagedBinaryPath: "/tmp/staged",
      livePath: "/tmp/live",
      parentPid: 4242,
      parentExitTimeoutSeconds: 60,
      platform: "win32",
      spawnImpl: (command) => {
        spawnCalls.push({ command });
        return { pid: 1, unref: () => undefined };
      },
      writeImpl: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/ENOSPC/);
    expect(spawnCalls).toHaveLength(0);
  });

  it("returns status='failed' when spawn throws", async () => {
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      environment: "production",
      stagedBinaryPath: "/tmp/staged",
      livePath: "/tmp/live",
      parentPid: 4242,
      parentExitTimeoutSeconds: 60,
      platform: "win32",
      spawnImpl: () => {
        throw new Error("EPERM: permission denied to spawn child");
      },
      writeImpl: async () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/EPERM/);
  });

  it("removes any stale post-finalize marker before scheduling so the next reconcile reads only the fresh outcome", async () => {
    // Prepare a stale marker on disk from a previous helper attempt.
    const cliDir = join(workHome, ".traycer", "cli");
    mkdirSync(cliDir, { recursive: true });
    const markerPath = join(cliDir, "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swapped",
        attemptedAt: "2026-04-29T00:00:00Z",
        livePath: "/tmp/live",
        stagedBinaryPath: "/tmp/staged",
        errorMessage: null,
        serviceStartError: null,
      }),
    );
    expect(existsSync(markerPath)).toBe(true);

    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    await scheduleFinalizationHelper({
      environment: "production",
      stagedBinaryPath: "/tmp/staged",
      livePath: "/tmp/live",
      parentPid: 4242,
      parentExitTimeoutSeconds: 60,
      platform: "linux",
      spawnImpl: () => ({ pid: 1, unref: () => undefined }),
      writeImpl: async () => undefined,
    });
    // The stale marker must have been cleared so the helper's own
    // marker write isn't conflated with the previous attempt.
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe("reconcilePostFinalizeMarker", () => {
  it("returns no-marker when the file is absent", async () => {
    const { reconcilePostFinalizeMarker } = await import("../finalize-helper");
    const outcome = await reconcilePostFinalizeMarker({
      environment: "production",
    });
    expect(outcome).toEqual({ status: "no-marker" });
  });

  it("on 'swapped' marker, clears pendingUpgrade, promotes version, and unlinks the marker", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    // The real helper would have moved staged → live by now; mirror
    // that.
    writeFileSync(liveBinaryPath, "staged-bytes");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
      currentVersion: "1.4.0",
    });
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
    );

    const { reconcilePostFinalizeMarker } = await import("../finalize-helper");
    const outcome = await reconcilePostFinalizeMarker({
      environment: "production",
    });
    expect(outcome.status).toBe("applied-swapped");
    if (outcome.status === "applied-swapped") {
      expect(outcome.previousVersion).toBe("1.4.0");
      expect(outcome.version).toBe("1.5.0");
    }
    expect(existsSync(markerPath)).toBe(false);
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.version).toBe("1.5.0");
    expect(reread.pendingUpgrade).toBeNull();
  });

  it("on 'swap-failed' marker, preserves pendingUpgrade and returns the helper's error message", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes");
    writeFileSync(stagedBinaryPath, "staged-bytes");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
      currentVersion: "1.4.0",
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

    const { reconcilePostFinalizeMarker } = await import("../finalize-helper");
    const outcome = await reconcilePostFinalizeMarker({
      environment: "production",
    });
    expect(outcome.status).toBe("applied-swap-failed");
    if (outcome.status === "applied-swap-failed") {
      expect(outcome.errorMessage).toContain("Access denied");
    }
    expect(existsSync(markerPath)).toBe(false);
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.pendingUpgrade).not.toBeNull();
    expect(reread.pendingUpgrade.version).toBe("1.5.0");
    expect(reread.version).toBe("1.4.0");
  });

  it("on 'parent-still-alive' marker, preserves pendingUpgrade and reports the outcome", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes");
    writeFileSync(stagedBinaryPath, "staged-bytes");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
      currentVersion: "1.4.0",
    });
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "parent-still-alive",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath,
        errorMessage: "parent CLI process 4242 did not exit within 60s",
        serviceStartError: null,
      }),
    );

    const { reconcilePostFinalizeMarker } = await import("../finalize-helper");
    const outcome = await reconcilePostFinalizeMarker({
      environment: "production",
    });
    expect(outcome.status).toBe("applied-parent-still-alive");
    expect(existsSync(markerPath)).toBe(false);
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.pendingUpgrade).not.toBeNull();
  });

  it("on a malformed marker JSON, returns marker-invalid and consumes the marker", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live");
    writeFileSync(stagedBinaryPath, "staged");
    writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
      currentVersion: "1.4.0",
    });
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(markerPath, "{ malformed json :::");

    const { reconcilePostFinalizeMarker } = await import("../finalize-helper");
    const outcome = await reconcilePostFinalizeMarker({
      environment: "production",
    });
    expect(outcome.status).toBe("marker-invalid");
    expect(existsSync(markerPath)).toBe(false);
  });

  it("is a no-op when the manifest no longer has a pendingUpgrade (idempotent on repeated apply)", async () => {
    const cliDir = join(workHome, ".traycer", "cli");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(cliDir, "manifest.json"),
      JSON.stringify({
        version: "1.5.0",
        installedAt: "2026-05-11T00:00:00Z",
        binaryPath: join(workHome, "bin", "traycer"),
        source: "manual",
        pendingUpgrade: null,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const markerPath = join(cliDir, "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swapped",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: join(workHome, "bin", "traycer"),
        stagedBinaryPath: join(workHome, "bin", "traycer-1.5.0"),
        errorMessage: null,
        serviceStartError: null,
      }),
    );

    const { reconcilePostFinalizeMarker } = await import("../finalize-helper");
    const outcome = await reconcilePostFinalizeMarker({
      environment: "production",
    });
    // No pendingUpgrade to clear, but the marker is still consumed so
    // we don't re-apply it next cycle.
    expect(outcome.status).toBe("applied-swapped");
    expect(existsSync(markerPath)).toBe(false);
  });
});
