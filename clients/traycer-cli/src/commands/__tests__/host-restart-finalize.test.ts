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

// `host restart` is the controlled supervisor restart that owns the
// pending CLI upgrade finalize step. Between `controller.stop()` and
// `controller.start()` the live CLI binary's lock is released, so the
// command attempts the staged-binary swap in that window.
//
// We exercise the split-out helper `restartWithPendingCliUpgradeFinalize`
// with a controller stub so the test doesn't depend on a real OS
// service manager. The CLI manifest is written under a tmp HOME so
// the manifest read/write paths exercise the real on-disk format.

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
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-restart-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  // The `store/paths` module captures `homedir()` once at module
  // load - drop the module cache so each test sees its own tmp HOME.
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
});

interface StubCalls {
  readonly calls: string[];
}

interface StubController {
  install: () => Promise<void>;
  uninstall: () => Promise<void>;
  status: () => Promise<{
    state: "stopped";
    version: null;
    listenUrl: null;
    pid: null;
  }>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  restart: () => Promise<void>;
}

function makeStubController(calls: StubCalls): StubController {
  return {
    install: async () => undefined,
    uninstall: async () => undefined,
    status: async () => ({
      state: "stopped" as const,
      version: null,
      listenUrl: null,
      pid: null,
    }),
    stop: async () => {
      calls.calls.push("stop");
    },
    start: async () => {
      calls.calls.push("start");
    },
    restart: async () => {
      calls.calls.push("restart");
    },
  };
}

function writeManifest(opts: {
  readonly liveBinaryPath: string;
  readonly stagedBinaryPath: string;
  readonly version: string;
}): string {
  const cliDir = join(workHome, ".traycer", "cli");
  mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(cliDir, "manifest.json");
  writeFileSync(
    manifestPath,
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
  return manifestPath;
}

interface RestartArgsBaseline {
  readonly environment: "production" | "dev";
  readonly controller: StubController;
  readonly label: { readonly id: string };
  readonly parentPid: number;
  readonly platform: NodeJS.Platform;
  readonly spawnImpl: (
    command: string,
    args: readonly string[],
    options: unknown,
  ) => { readonly pid: number | undefined; unref: () => void };
  readonly writeImpl: (path: string, body: string) => void;
}

// Most existing tests don't care about helper scheduling - they
// exercise the POSIX path where finalize either succeeds or surfaces
// a manifest-state outcome and the helper isn't invoked. The default
// platform is "linux" so the Windows helper branch stays inert; the
// spawn/write stubs throw if accidentally invoked so a regression
// would be caught.
function defaultArgs(controller: StubController): RestartArgsBaseline {
  return {
    environment: "production",
    controller,
    label: {
      id: "ai.traycer.host.production",
      displayName: "Traycer Host",
      environment: "production",
    } as never,
    parentPid: 4242,
    platform: "linux",
    spawnImpl: (() => {
      throw new Error(
        "spawnImpl should not be invoked on POSIX still-locked path",
      );
    }) as RestartArgsBaseline["spawnImpl"],
    writeImpl: (() => {
      throw new Error(
        "writeImpl should not be invoked on POSIX still-locked path",
      );
    }) as RestartArgsBaseline["writeImpl"],
  };
}

describe("restartWithPendingCliUpgradeFinalize", () => {
  it("stops, finalises the staged binary, then starts (lifecycle order matters)", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
    });

    const calls: StubCalls = { calls: [] };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const result = await restartWithPendingCliUpgradeFinalize(
      defaultArgs(controller) as never,
    );

    expect(calls.calls).toEqual(["stop", "start"]);
    expect(result.finalize.status).toBe("finalised");
    if (result.finalize.status === "finalised") {
      expect(result.finalize.version).toBe("1.5.0");
      expect(result.finalize.previousVersion).toBe("1.4.0");
    }
    expect(result.helper).toBeNull();
    expect(result.helperOwnsServiceStart).toBe(false);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("staged-bytes-1.5.0");
    expect(existsSync(stagedBinaryPath)).toBe(false);
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.version).toBe("1.5.0");
    expect(reread.pendingUpgrade).toBeNull();
  });

  it("returns no-pending and still cycles the service when no upgrade is staged", async () => {
    const cliDir = join(workHome, ".traycer", "cli");
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(cliDir, "manifest.json"),
      JSON.stringify(
        {
          version: "1.5.0",
          installedAt: "2026-05-01T00:00:00Z",
          binaryPath: join(workHome, "bin", "traycer"),
          source: "manual",
          pendingUpgrade: null,
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );

    const calls: StubCalls = { calls: [] };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const result = await restartWithPendingCliUpgradeFinalize(
      defaultArgs(controller) as never,
    );
    expect(result.finalize.status).toBe("no-pending");
    expect(calls.calls).toEqual(["stop", "start"]);
    expect(result.helper).toBeNull();
  });

  it("returns no-manifest when CLI has never been installed and still cycles the service", async () => {
    // Fresh machine: no CLI install manifest on disk. The restart
    // command must still cycle the host service - supervisor users
    // depend on `host restart` even before any CLI upgrade has
    // happened.
    const calls: StubCalls = { calls: [] };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const result = await restartWithPendingCliUpgradeFinalize(
      defaultArgs(controller) as never,
    );
    expect(result.finalize.status).toBe("no-manifest");
    expect(calls.calls).toEqual(["stop", "start"]);
    expect(result.helper).toBeNull();
  });

  it("on Windows still-locked, schedules a detached helper, skips controller.start(), and writes the helper script", async () => {
    // Locked Windows case: the in-process renameSync fails with EACCES
    // (we simulate by stripping write perm on the parent dir, which is
    // how the helper test on POSIX exercises tryReplaceLiveBinary's
    // "locked" branch). The helper must be scheduled, the service
    // start must be deferred to the helper, and the helper script body
    // must contain the parent pid + live binary path so a real
    // PowerShell invocation would do the right thing.
    if (process.platform === "win32") return; // chmod-based simulation not portable to Windows
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses 0o555

    const lockedDir = join(workHome, "locked-bin");
    mkdirSync(lockedDir, { recursive: true });
    const liveBinaryPath = join(lockedDir, "traycer.exe");
    writeFileSync(liveBinaryPath, "live-bytes");
    const stagingDir = join(workHome, "staging");
    mkdirSync(stagingDir, { recursive: true });
    const stagedBinaryPath = join(stagingDir, "traycer-1.5.0.exe");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    writeManifest({ liveBinaryPath, stagedBinaryPath, version: "1.5.0" });

    const { chmodSync } = await import("node:fs");
    chmodSync(lockedDir, 0o555);

    try {
      const calls: StubCalls = { calls: [] };
      const controller = makeStubController(calls);
      const spawnCalls: Array<{
        command: string;
        args: readonly string[];
      }> = [];
      const writeCalls: Array<{ path: string; body: string }> = [];
      const spawnStub: RestartArgsBaseline["spawnImpl"] = (command, args) => {
        spawnCalls.push({ command, args });
        return { pid: 99001, unref: () => undefined };
      };
      const writeStub: RestartArgsBaseline["writeImpl"] = (path, body) => {
        writeCalls.push({ path, body });
      };
      const { restartWithPendingCliUpgradeFinalize } =
        await import("../host-restart");
      const result = await restartWithPendingCliUpgradeFinalize({
        ...defaultArgs(controller),
        platform: "win32",
        spawnImpl: spawnStub,
        writeImpl: writeStub,
      } as never);
      // controller.start() must be skipped - the helper takes over.
      expect(calls.calls).toEqual(["stop"]);
      expect(result.helper).not.toBeNull();
      expect(result.helper?.status).toBe("scheduled");
      expect(result.helper?.helperPid).toBe(99001);
      expect(result.helperOwnsServiceStart).toBe(true);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.command).toBe("powershell.exe");
      expect(spawnCalls[0]?.args).toContain("-File");
      expect(writeCalls).toHaveLength(1);
      const script = writeCalls[0]?.body ?? "";
      expect(script).toContain("$ParentPid = 4242");
      expect(script).toContain(liveBinaryPath);
      expect(script).toContain(stagedBinaryPath);
      // Binary swap + service start hand off to the staged binary's own
      // hidden `cli finalize-upgrade` command (see finalize-helper.ts's
      // module doc comment) rather than this script doing them inline.
      expect(script).toContain("$StagedBinary cli finalize-upgrade");
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  it("on POSIX still-locked, leaves pendingUpgrade visible and does NOT schedule the helper", async () => {
    // POSIX still-locked is a genuine read-only-install case, not a
    // current-process-holds-binary case. There is no benefit to a
    // detached helper there - the next CLI run can retry once the
    // operator fixes the install dir. Doctor still surfaces
    // pendingUpgrade.
    if (process.platform === "win32") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const lockedDir = join(workHome, "ro-bin");
    mkdirSync(lockedDir, { recursive: true });
    const liveBinaryPath = join(lockedDir, "traycer");
    writeFileSync(liveBinaryPath, "live-bytes");
    const stagingDir = join(workHome, "staging-posix");
    mkdirSync(stagingDir, { recursive: true });
    const stagedBinaryPath = join(stagingDir, "traycer-1.5.0");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    writeManifest({ liveBinaryPath, stagedBinaryPath, version: "1.5.0" });

    const { chmodSync } = await import("node:fs");
    chmodSync(lockedDir, 0o555);

    try {
      const calls: StubCalls = { calls: [] };
      const controller = makeStubController(calls);
      const { restartWithPendingCliUpgradeFinalize } =
        await import("../host-restart");
      const result = await restartWithPendingCliUpgradeFinalize(
        defaultArgs(controller) as never,
      );
      expect(result.finalize.status).toBe("still-locked");
      expect(result.helper).toBeNull();
      // POSIX falls through to the normal start() - supervisor not
      // affected by the read-only install dir.
      expect(calls.calls).toEqual(["stop", "start"]);
      const reread = JSON.parse(
        readFileSync(
          join(workHome, ".traycer", "cli", "manifest.json"),
          "utf8",
        ),
      );
      expect(reread.pendingUpgrade.version).toBe("1.5.0");
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  it("applies a prior helper's post-finalize marker (swapped) before cycling the service, clearing pendingUpgrade", async () => {
    // Simulates a Windows machine where the helper from a previous
    // `host restart` invocation succeeded after the CLI exited.
    // The marker file is on disk; this restart cycle reads it,
    // clears pendingUpgrade in the manifest, then proceeds with the
    // standard stop/start cycle.
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    // The helper already moved staged → live, so only the live file
    // exists. We mirror that here.
    writeFileSync(liveBinaryPath, "staged-bytes-1.5.0");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
    });
    // Marker written by a prior helper run.
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          status: "swapped",
          attemptedAt: "2026-05-11T00:00:00Z",
          livePath: liveBinaryPath,
          stagedBinaryPath,
          errorMessage: null,
          serviceStartError: null,
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );

    const calls: StubCalls = { calls: [] };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const result = await restartWithPendingCliUpgradeFinalize(
      defaultArgs(controller) as never,
    );

    expect(result.markerReconcile?.status).toBe("applied-swapped");
    expect(calls.calls).toEqual(["stop", "start"]);
    expect(result.helper).toBeNull();
    // pendingUpgrade is now null and the marker has been consumed.
    expect(existsSync(markerPath)).toBe(false);
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.version).toBe("1.5.0");
    expect(reread.pendingUpgrade).toBeNull();
  });

  it("applies a prior helper's swap-failed marker, consumes the marker, and surfaces the error message", async () => {
    // The previous helper attempt failed during the move. The marker
    // reconcile records the error and consumes the marker so we don't
    // re-apply it next cycle. (Whether the subsequent in-process
    // finalize succeeds depends on the install dir's writability;
    // either way the marker reconcile contract is independent.)
    if (process.platform === "win32") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const lockedDir = join(workHome, "ro-bin");
    mkdirSync(lockedDir, { recursive: true });
    const liveBinaryPath = join(lockedDir, "traycer");
    writeFileSync(liveBinaryPath, "live-bytes");
    const stagingDir = join(workHome, "staging-failed");
    mkdirSync(stagingDir, { recursive: true });
    const stagedBinaryPath = join(stagingDir, "traycer-1.5.0");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
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
      { encoding: "utf8", mode: 0o600 },
    );

    const { chmodSync } = await import("node:fs");
    // Strip parent-dir write so the in-process finalize also returns
    // still-locked. That's the realistic shape for a swap-failed
    // marker: the underlying lock is still in place and the next
    // retry should keep pendingUpgrade visible.
    chmodSync(lockedDir, 0o555);

    try {
      const calls: StubCalls = { calls: [] };
      const controller = makeStubController(calls);
      const { restartWithPendingCliUpgradeFinalize } =
        await import("../host-restart");
      const result = await restartWithPendingCliUpgradeFinalize(
        defaultArgs(controller) as never,
      );
      expect(result.markerReconcile?.status).toBe("applied-swap-failed");
      if (result.markerReconcile?.status === "applied-swap-failed") {
        expect(result.markerReconcile.errorMessage).toContain("Access denied");
      }
      expect(existsSync(markerPath)).toBe(false);
      const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
      // The marker reconcile alone does not clear pendingUpgrade on a
      // swap-failed outcome; the in-process finalize also failed
      // (locked dir), so pendingUpgrade survives.
      expect(reread.pendingUpgrade).not.toBeNull();
      expect(reread.pendingUpgrade.version).toBe("1.5.0");
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });
});
