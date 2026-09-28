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
import { powershellSingleQuoted } from "@traycer-clients/shared/platform/powershell-quote";

// Coverage for the detached pending-CLI-upgrade finalize helper:
//
//  - scheduleFinalizationHelper writes a platform-appropriate script,
//    launches it (Windows: an awaited, non-detached launcher), waits for
//    the script's first line to write its armed sentinel, and returns a
//    structured result that is `armed` only once that file exists.
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
// `tmpdir()` is redirected the same way: the helper's script, sentinel and
// abandoned files land under it.
const osHome = vi.hoisted(() => ({ current: "" }));
const osTmp = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => osHome.current || actual.tmpdir(),
    tmpdir: () => osTmp.current || actual.tmpdir(),
  };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  osTmp.current = "";
  workHome = mkdtempSync(join(tmpdir(), "traycer-finalize-helper-test-"));
  osHome.current = workHome;
  osTmp.current = join(workHome, "tmp");
  mkdirSync(osTmp.current, { recursive: true });
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
});

afterEach(() => {
  osTmp.current = "";
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

// A clock the arm wait runs on without waiting: `sleep` advances `now`.
function fakeArmWait(waitMs: number): {
  readonly deps: {
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly waitMs: number;
    readonly pollIntervalMs: number;
  };
  readonly elapsedMs: () => number;
} {
  let t = 0;
  return {
    deps: {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      waitMs,
      pollIntervalMs: 100,
    },
    elapsedMs: () => t,
  };
}

interface LauncherExit {
  readonly exitCode: number | null;
  readonly errorMessage: string | null;
}

const LAUNCHER_OK: LauncherExit = { exitCode: 0, errorMessage: null };

// Records every spawn and write. When `sentinel` is not null the spawn
// plays the helper script's first line: it writes that text into the
// `.armed` file beside the script the CLI just wrote.
function makeHarness(opts: {
  readonly sentinel: string | null;
  readonly exited: Promise<LauncherExit>;
}) {
  const spawnCalls: Array<{
    command: string;
    args: readonly string[];
    options: {
      readonly detached?: boolean;
      readonly stdio?: unknown;
      readonly windowsHide?: boolean;
    };
  }> = [];
  const writeCalls: Array<{ path: string; body: string }> = [];
  const killed = { count: 0 };
  const unrefed = { count: 0 };
  return {
    spawnCalls,
    writeCalls,
    killed,
    unrefed,
    spawnImpl: (
      command: string,
      args: readonly string[],
      options: {
        readonly detached?: boolean;
        readonly stdio?: unknown;
        readonly windowsHide?: boolean;
      },
    ) => {
      spawnCalls.push({ command, args, options });
      const scriptPath = writeCalls[0]?.path ?? "";
      if (opts.sentinel !== null) {
        writeFileSync(
          scriptPath.replace(/\.(ps1|sh)$/, ".armed"),
          opts.sentinel,
        );
      }
      return {
        pid: 55000,
        unref: () => {
          unrefed.count += 1;
        },
        kill: () => {
          killed.count += 1;
        },
        exited: opts.exited,
      };
    },
    writeImpl: async (path: string, body: string) => {
      writeCalls.push({ path, body });
    },
  };
}

function decodeLauncher(args: readonly string[]): string {
  const idx = args.indexOf("-EncodedCommand");
  expect(idx).toBeGreaterThan(-1);
  return Buffer.from(args[idx + 1] ?? "", "base64").toString("utf16le");
}

const BASE_OPTIONS = {
  environment: "production",
  stagedBinaryPath: "C:/Users/dev/AppData/.traycer/cli/traycer-1.5.0.exe",
  livePath: "C:/Users/dev/AppData/.traycer/cli/traycer.exe",
  parentPid: 4242,
  parentExitTimeoutSeconds: 60,
} as const;

describe("scheduleFinalizationHelper", () => {
  it("renders a PowerShell script with parent pid + paths, launches it through an awaited non-detached powershell.exe on Windows, and reports it armed", async () => {
    let resolveExited: (exit: LauncherExit) => void = () => undefined;
    const exited = new Promise<LauncherExit>((resolve) => {
      resolveExited = resolve;
    });
    const harness = makeHarness({ sentinel: "4321", exited });
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    // The clock never runs out, so only the launcher's exit can settle it.
    const armWait = {
      now: () => 0,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      waitMs: 10_000,
      pollIntervalMs: 100,
    };
    let settled = false;
    const pending = scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "win32",
      spawnImpl: harness.spawnImpl,
      writeImpl: harness.writeImpl,
      armWait,
    }).then((r) => {
      settled = true;
      return r;
    });

    // Ticks pass with the launcher still running: the CLI keeps waiting.
    for (let i = 0; i < 20; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(settled).toBe(false);

    resolveExited(LAUNCHER_OK);
    const result = await pending;

    expect(result.status).toBe("armed");
    expect(result.helperPid).toBe(4321);
    expect(result.platform).toBe("win32");
    expect(result.armedPath).toBe(
      harness.writeCalls[0]?.path.replace(/\.ps1$/, ".armed"),
    );

    expect(harness.spawnCalls).toHaveLength(1);
    const spawnCall = harness.spawnCalls[0];
    expect(spawnCall?.command).toBe("powershell.exe");
    expect(spawnCall?.args).toContain("-NoProfile");
    expect(spawnCall?.args).toContain("-NonInteractive");
    expect(spawnCall?.args).toContain("-ExecutionPolicy");
    expect(spawnCall?.args).toContain("-EncodedCommand");
    expect(spawnCall?.args).not.toContain("-File");
    expect(spawnCall?.options.detached).toBe(false);
    expect(spawnCall?.options.stdio).toBe("ignore");
    expect(spawnCall?.options.windowsHide).toBe(true);

    // The launcher hands the script to a second, hidden PowerShell.
    const launcher = decodeLauncher(spawnCall?.args ?? []);
    expect(launcher).toContain("Start-Process");
    expect(launcher).toContain("-WindowStyle Hidden");
    expect(launcher).toContain("-PassThru");
    expect(launcher).toContain(
      powershellSingleQuoted(harness.writeCalls[0]?.path ?? ""),
    );

    expect(harness.writeCalls).toHaveLength(1);
    const body = harness.writeCalls[0]?.body ?? "";
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

  it("reports failed within the wait bound, and abandons the helper, when the script never writes its armed sentinel", async () => {
    const harness = makeHarness({
      sentinel: null,
      exited: Promise.resolve(LAUNCHER_OK),
    });
    const clock = fakeArmWait(10_000);
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "win32",
      spawnImpl: harness.spawnImpl,
      writeImpl: harness.writeImpl,
      armWait: clock.deps,
    });

    expect(result.status).toBe("failed");
    expect(result.helperPid).toBeNull();
    expect(clock.elapsedMs()).toBeGreaterThanOrEqual(10_000);
    expect(clock.elapsedMs()).toBeLessThanOrEqual(10_500);
    // The script, then the abandoned file the late helper checks.
    const scriptPath = harness.writeCalls[0]?.path ?? "";
    expect(harness.writeCalls.map((c) => c.path)).toEqual([
      scriptPath,
      scriptPath.replace(/\.ps1$/, ".abandoned"),
    ]);
  });

  it("reports armed with the pid the script wrote into its sentinel", async () => {
    const harness = makeHarness({
      sentinel: "4321",
      exited: Promise.resolve(LAUNCHER_OK),
    });
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "win32",
      spawnImpl: harness.spawnImpl,
      writeImpl: harness.writeImpl,
      armWait: fakeArmWait(10_000).deps,
    });
    expect(result.status).toBe("armed");
    expect(result.helperPid).toBe(4321);
    // Armed: nothing is abandoned.
    expect(harness.writeCalls).toHaveLength(1);
  });

  it("reports failed without waiting for the deadline when the launcher exits non-zero", async () => {
    const harness = makeHarness({
      sentinel: null,
      exited: Promise.resolve({ exitCode: 1, errorMessage: null }),
    });
    const clock = fakeArmWait(10_000);
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "win32",
      spawnImpl: harness.spawnImpl,
      writeImpl: harness.writeImpl,
      armWait: clock.deps,
    });
    expect(result.status).toBe("failed");
    expect(clock.elapsedMs()).toBeLessThan(10_000);
  });

  it("kills the launcher and reports failed when it has not exited by the deadline", async () => {
    const harness = makeHarness({
      sentinel: null,
      exited: new Promise<LauncherExit>(() => undefined),
    });
    const clock = fakeArmWait(10_000);
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "win32",
      spawnImpl: harness.spawnImpl,
      writeImpl: harness.writeImpl,
      armWait: clock.deps,
    });
    expect(result.status).toBe("failed");
    expect(harness.killed.count).toBe(1);
    expect(clock.elapsedMs()).toBeLessThanOrEqual(10_500);
  });

  it("keeps the arm wait bounded when the wall clock is set back", async () => {
    let wallTime = 1_000_000;
    let elapsedMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => wallTime);
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    const harness = makeHarness({
      sentinel: null,
      exited: new Promise<LauncherExit>(() => undefined),
    });
    const { scheduleFinalizationHelper, defaultHelperArmWaitDeps } =
      await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "win32",
      spawnImpl: harness.spawnImpl,
      writeImpl: harness.writeImpl,
      // The production clock, with only the sleeping replaced. The wall
      // clock is stepped back a minute during the first sleep.
      armWait: {
        ...defaultHelperArmWaitDeps,
        sleep: async (ms) => {
          if (elapsedMs === 0) wallTime -= 60_000;
          elapsedMs += ms;
          wallTime += ms;
        },
      },
    });
    expect(result.status).toBe("failed");
    expect(harness.killed.count).toBe(1);
    expect(elapsedMs).toBeLessThanOrEqual(10_500);
  });

  it("writes the Windows helper script to disk with a UTF-8 BOM, then the line that arms it", async () => {
    const harness = makeHarness({
      sentinel: "4321",
      exited: Promise.resolve(LAUNCHER_OK),
    });
    const { scheduleFinalizationHelper, defaultWriteImpl } =
      await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "win32",
      spawnImpl: harness.spawnImpl,
      writeImpl: async (path, body) => {
        await harness.writeImpl(path, body);
        await defaultWriteImpl(path, body);
      },
      armWait: fakeArmWait(10_000).deps,
    });
    expect(result.scriptPath).not.toBeNull();
    const bytes = readFileSync(result.scriptPath ?? "");
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const firstLine = bytes.subarray(3).toString("utf8").split("\n")[0];
    expect(firstLine).toBe(
      `[System.IO.File]::WriteAllText(${powershellSingleQuoted(
        result.armedPath ?? "",
      )}, [string]$PID)`,
    );
  });

  it("carries a script path with an apostrophe and non-ASCII characters through the encoded launcher unchanged", async () => {
    const oddDir = join(workHome, "O'Brien-Zoë-日本");
    mkdirSync(oddDir, { recursive: true });
    osTmp.current = oddDir;
    const harness = makeHarness({
      sentinel: "4321",
      exited: Promise.resolve(LAUNCHER_OK),
    });
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "win32",
      spawnImpl: harness.spawnImpl,
      writeImpl: harness.writeImpl,
      armWait: fakeArmWait(10_000).deps,
    });

    const scriptPath = harness.writeCalls[0]?.path ?? "";
    expect(scriptPath.startsWith(oddDir)).toBe(true);
    const args = harness.spawnCalls[0]?.args ?? [];
    const launcher = decodeLauncher(args);
    // The single-quoted literal between the concatenated pieces.
    const literal = /-File "' \+ '((?:[^']|'')*)' \+ '"'\)/.exec(launcher);
    expect(literal).not.toBeNull();
    const undoubled = (literal?.[1] ?? "").replace(/(['‘-‛])\1/g, "$1");
    expect(undoubled).toBe(scriptPath);
    // The base64 is the launcher's UTF-16LE bytes, with nothing lost.
    const encoded = args[args.indexOf("-EncodedCommand") + 1] ?? "";
    expect(Buffer.from(launcher, "utf16le").toString("base64")).toBe(encoded);
  });

  const SMART_QUOTES = ["\u2018", "\u2019", "\u201A", "\u201B"];

  it.each(SMART_QUOTES)(
    "doubles PowerShell single-quote %s in the Windows helper path literals",
    async (quoteChar: string) => {
      const harness = makeHarness({
        sentinel: "4321",
        exited: Promise.resolve(LAUNCHER_OK),
      });
      const { scheduleFinalizationHelper } = await import("../finalize-helper");
      const staged = `C:\\Users\\O${quoteChar}Brien\\cli\\traycer-1.5.0.exe`;
      const live = `C:\\Users\\O${quoteChar}Brien\\cli\\traycer.exe`;
      await scheduleFinalizationHelper({
        ...BASE_OPTIONS,
        stagedBinaryPath: staged,
        livePath: live,
        platform: "win32",
        spawnImpl: harness.spawnImpl,
        writeImpl: harness.writeImpl,
        armWait: fakeArmWait(10_000).deps,
      });
      const body = harness.writeCalls[0]?.body ?? "";
      expect(body).toContain(
        `$StagedBinary = 'C:\\Users\\O${quoteChar}${quoteChar}Brien\\cli\\traycer-1.5.0.exe'`,
      );
      expect(body).toContain(
        `$LiveBinary = 'C:\\Users\\O${quoteChar}${quoteChar}Brien\\cli\\traycer.exe'`,
      );
    },
  );

  it("renders a POSIX shell script with parent pid + paths, spawns /bin/sh detached on linux, and reports it armed", async () => {
    const harness = makeHarness({
      sentinel: "88001",
      exited: new Promise<LauncherExit>(() => undefined),
    });
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      environment: "production",
      stagedBinaryPath: "/usr/local/share/traycer/cli/traycer-1.5.0",
      livePath: "/usr/local/share/traycer/cli/traycer",
      parentPid: 4242,
      parentExitTimeoutSeconds: 60,
      platform: "linux",
      spawnImpl: harness.spawnImpl,
      writeImpl: harness.writeImpl,
      armWait: fakeArmWait(10_000).deps,
    });
    expect(result.status).toBe("armed");
    expect(result.helperPid).toBe(88001);
    expect(harness.spawnCalls[0]?.command).toBe("/bin/sh");
    expect(harness.spawnCalls[0]?.options.detached).toBe(true);
    expect(harness.unrefed.count).toBe(1);
    const body = harness.writeCalls[0]?.body ?? "";
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

  it("reports failed when the POSIX script never writes its armed sentinel", async () => {
    const harness = makeHarness({
      sentinel: null,
      exited: new Promise<LauncherExit>(() => undefined),
    });
    const clock = fakeArmWait(10_000);
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "linux",
      spawnImpl: harness.spawnImpl,
      writeImpl: harness.writeImpl,
      armWait: clock.deps,
    });
    expect(result.status).toBe("failed");
    expect(clock.elapsedMs()).toBeLessThanOrEqual(10_500);
  });

  it("returns status='failed' when the write stub throws and never invokes spawn", async () => {
    const spawnCalls: Array<{ command: string }> = [];
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "win32",
      spawnImpl: (command) => {
        spawnCalls.push({ command });
        return {
          pid: 1,
          unref: () => undefined,
          kill: () => undefined,
          exited: Promise.resolve(LAUNCHER_OK),
        };
      },
      writeImpl: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
      armWait: fakeArmWait(10_000).deps,
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/ENOSPC/);
    expect(spawnCalls).toHaveLength(0);
  });

  it("returns status='failed' when spawn throws", async () => {
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    const result = await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      platform: "win32",
      spawnImpl: () => {
        throw new Error("EPERM: permission denied to spawn child");
      },
      writeImpl: async () => undefined,
      armWait: fakeArmWait(10_000).deps,
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

    const harness = makeHarness({
      sentinel: "1",
      exited: new Promise<LauncherExit>(() => undefined),
    });
    const { scheduleFinalizationHelper } = await import("../finalize-helper");
    await scheduleFinalizationHelper({
      ...BASE_OPTIONS,
      stagedBinaryPath: "/tmp/staged",
      livePath: "/tmp/live",
      platform: "linux",
      spawnImpl: harness.spawnImpl,
      writeImpl: harness.writeImpl,
      armWait: fakeArmWait(10_000).deps,
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

  // The corruption this correlation exists to prevent. A helper that swapped
  // 1.5.0 can leave its marker behind unconsumed; a later `cli upgrade` then
  // records pendingUpgrade 1.6.0 next to it. Applying the stale marker would
  // promote 1.6.0 to installed and clear the pending record without 1.6.0's
  // staged binary ever reaching the live path - the manifest would claim a
  // version the bytes on disk are not, with nothing left to detect it from.
  //
  // Doctor refuses the same stale marker and routes the user to `host
  // restart`, i.e. straight into this function, so the read side alone would
  // not have been enough.
  it("on a 'swapped' marker for a DIFFERENT staged upgrade, discards it without touching the manifest", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const pendingStagedPath = join(workHome, "bin", "traycer-1.6.0");
    const staleStagedPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes");
    writeFileSync(pendingStagedPath, "staged-1.6.0-bytes");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath: pendingStagedPath,
      version: "1.6.0",
      currentVersion: "1.4.0",
    });
    const manifestBefore = readFileSync(manifestPath, "utf8");
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swapped",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        // Belongs to the PRIOR 1.5.0 swap, not the pending 1.6.0 one.
        stagedBinaryPath: staleStagedPath,
        errorMessage: null,
        serviceStartError: null,
      }),
    );

    const { reconcilePostFinalizeMarker } = await import("../finalize-helper");
    const outcome = await reconcilePostFinalizeMarker({
      environment: "production",
    });

    expect(outcome.status).toBe("stale-marker-discarded");
    if (outcome.status === "stale-marker-discarded") {
      expect(outcome.markerStagedBinaryPath).toBe(staleStagedPath);
      expect(outcome.pendingStagedBinaryPath).toBe(pendingStagedPath);
    }
    // The pending 1.6.0 upgrade is untouched and still pending - the whole
    // point, since it genuinely has not been applied.
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.version).toBe("1.4.0");
    expect(reread.pendingUpgrade?.version).toBe("1.6.0");
    // The stale marker is removed: it describes a swap nobody is waiting on,
    // and leaving it would re-pose the same question to every future caller.
    expect(existsSync(markerPath)).toBe(false);
  });

  // The staged filename carries the version, so it alone defeats a stale-
  // VERSION marker - but not a re-anchor. `cli re-anchor` repoints
  // `manifest.binaryPath` without deleting the marker, so a SAME-version retry
  // produces the same deterministic staged filename and would match on staged
  // path alone, promoting a version whose bytes never reached the re-anchored
  // destination.
  it("discards a same-version marker whose livePath predates a 'cli re-anchor'", async () => {
    const reanchoredLivePath = join(workHome, "bin", "traycer-cli");
    const oldLivePath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(reanchoredLivePath, "live-bytes");
    writeFileSync(stagedBinaryPath, "staged-bytes");
    const manifestPath = writeManifest({
      liveBinaryPath: reanchoredLivePath,
      stagedBinaryPath,
      version: "1.5.0",
      currentVersion: "1.4.0",
    });
    const manifestBefore = readFileSync(manifestPath, "utf8");
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swapped",
        attemptedAt: "2026-05-11T00:00:00Z",
        // Same staged path (same version), but the PRE-re-anchor destination.
        livePath: oldLivePath,
        stagedBinaryPath,
        errorMessage: null,
        serviceStartError: null,
      }),
    );

    const { reconcilePostFinalizeMarker } = await import("../finalize-helper");
    const outcome = await reconcilePostFinalizeMarker({
      environment: "production",
    });

    expect(outcome.status).toBe("stale-marker-discarded");
    if (outcome.status === "stale-marker-discarded") {
      expect(outcome.markerLivePath).toBe(oldLivePath);
      expect(outcome.manifestBinaryPath).toBe(reanchoredLivePath);
    }
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
    expect(existsSync(markerPath)).toBe(false);
  });

  // BOTH paths are reusable by design, so matching them is not identity.
  // `cli re-anchor` supports replacing the binary at the same path, and
  // `cli upgrade` derives the staged filename deterministically from the
  // version - so retrying the same version reproduces the exact tuple a prior
  // marker carries. Only the ordering separates them: a marker written BEFORE
  // the pending upgrade was staged cannot be describing it.
  it("discards a path-identical marker that predates the pending upgrade's staging", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes");
    writeFileSync(stagedBinaryPath, "freshly-staged-bytes");
    // `writeManifest` stamps stagedAt = 2026-05-10T00:00:00Z.
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
      currentVersion: "1.4.0",
    });
    const manifestBefore = readFileSync(manifestPath, "utf8");
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swapped",
        // A DAY EARLIER than the pending staging - so this marker belongs to
        // an earlier attempt that happened to use the same two paths.
        attemptedAt: "2026-05-09T00:00:00Z",
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

    expect(outcome.status).toBe("stale-marker-discarded");
    if (outcome.status === "stale-marker-discarded") {
      expect(outcome.markerAttemptedAt).toBe("2026-05-09T00:00:00Z");
      expect(outcome.pendingStagedAt).toBe("2026-05-10T00:00:00Z");
    }
    // The freshly staged 1.5.0 is still pending - it genuinely has not been
    // applied, and stamping it from the old marker is the corruption.
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("on 'swap-failed' marker, preserves the swap and service-start errors", async () => {
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
        serviceStartError: "schtasks /Run failed: service already stopped",
      }),
    );

    const { reconcilePostFinalizeMarker } = await import("../finalize-helper");
    const outcome = await reconcilePostFinalizeMarker({
      environment: "production",
    });
    expect(outcome.status).toBe("applied-swap-failed");
    if (outcome.status === "applied-swap-failed") {
      expect(outcome.errorMessage).toContain("Access denied");
      expect(outcome.serviceStartError).toBe(
        "schtasks /Run failed: service already stopped",
      );
    }
    expect(existsSync(markerPath)).toBe(false);
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.pendingUpgrade).not.toBeNull();
    expect(reread.pendingUpgrade.version).toBe("1.5.0");
    expect(reread.version).toBe("1.4.0");
  });

  it.each([
    ["null", { serviceStartError: null }],
    ["omitted", {}],
  ])(
    "normalises an %s swap-failed serviceStartError to null",
    async (_label, markerExtra) => {
      const liveBinaryPath = join(workHome, "bin", "traycer");
      const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
      mkdirSync(join(workHome, "bin"), { recursive: true });
      writeFileSync(liveBinaryPath, "live-bytes");
      writeFileSync(stagedBinaryPath, "staged-bytes");
      writeManifest({
        liveBinaryPath,
        stagedBinaryPath,
        version: "1.5.0",
        currentVersion: "1.4.0",
      });
      const markerPath = join(
        workHome,
        ".traycer",
        "cli",
        "post-finalize.json",
      );
      writeFileSync(
        markerPath,
        JSON.stringify({
          status: "swap-failed",
          attemptedAt: "2026-05-11T00:00:00Z",
          livePath: liveBinaryPath,
          stagedBinaryPath,
          errorMessage: "MoveFileEx error 5: Access denied",
          ...markerExtra,
        }),
      );

      const { reconcilePostFinalizeMarker } =
        await import("../finalize-helper");
      const outcome = await reconcilePostFinalizeMarker({
        environment: "production",
      });
      expect(outcome.status).toBe("applied-swap-failed");
      if (outcome.status === "applied-swap-failed") {
        expect(outcome.serviceStartError).toBeNull();
      }
    },
  );

  it("preserves serviceStartError when swap-failed has no pending manifest", async () => {
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
    writeFileSync(
      join(cliDir, "post-finalize.json"),
      JSON.stringify({
        status: "swap-failed",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: join(workHome, "bin", "traycer"),
        stagedBinaryPath: join(workHome, "bin", "traycer-1.5.0"),
        errorMessage: "MoveFileEx error 5: Access denied",
        serviceStartError: "schtasks /Run failed: service already stopped",
      }),
    );

    const { reconcilePostFinalizeMarker } = await import("../finalize-helper");
    const outcome = await reconcilePostFinalizeMarker({
      environment: "production",
    });
    expect(outcome.status).toBe("applied-swap-failed");
    if (outcome.status === "applied-swap-failed") {
      expect(outcome.serviceStartError).toBe(
        "schtasks /Run failed: service already stopped",
      );
    }
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
