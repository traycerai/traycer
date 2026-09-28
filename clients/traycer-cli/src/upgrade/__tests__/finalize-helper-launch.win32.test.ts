import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { powershellSingleQuoted } from "@traycer-clients/shared/platform/powershell-quote";
import type {
  HelperArmWaitDeps,
  SpawnImpl,
  SpawnedProcess,
} from "../finalize-helper";

// The real Windows handoff. The seam-based finalize-helper tests prove the
// launcher's shape against a stub; this file proves that a real
// `powershell.exe` launcher actually starts the helper script, that the
// script's first line arms it, and that the helper survives the exit of the
// process that launched it. That last part is the job-object behaviour the
// module doc comment leans on (libuv's KILL_ON_JOB_CLOSE with
// SILENT_BREAKAWAY_OK): only a real Windows process tree can show it.
//
// The helper here runs a marker-only tail - the production first line (BOM
// plus the arm line), then a sleep and a `.survived` file - so nothing
// finalizes or touches the install. The abandoned-helper case runs the whole
// production script, against a `.cmd` stub instead of the staged binary.
//
// `store/paths` binds its home root from `os.homedir()` at module load, and
// scheduling unlinks the post-finalize marker and creates the CLI home dir,
// so every test redirects the home first and imports the modules after it
// (dynamically, behind `vi.resetModules()`). Nothing here touches a real home.
//
// This file only runs on Windows (`describe.skipIf` below) and is wired into
// the `test-windows-cli-exit` job in `.github/workflows/test.yml`.

// `homedir()` is redirected; `tmpdir()` follows the real TEMP/TMP variables.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

// Vitest's default is 5 s; these cases wait on a real PowerShell start (arm
// wait up to 10 s), a 3 s helper tail, a 20 s poll and 30 s spawnSync limits.
const TEST_TIMEOUT_MS = 60_000;

const HELPER_SLEEP_SECONDS = 3;
const SURVIVED_POLL_MS = 20_000;

const ORIGINAL_TEMP = process.env.TEMP;
const ORIGINAL_TMP = process.env.TMP;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workRoot: string;
let workHome: string;

async function loadHelper() {
  return await import("../finalize-helper");
}

const helperPids: number[] = [];

function restoreEnv(
  name: "TEMP" | "TMP" | "HOME" | "USERPROFILE",
  original: string | undefined,
): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

function pointTempAt(dir: string): void {
  process.env.TEMP = dir;
  process.env.TMP = dir;
}

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), "traycer-finalize-launch-test-"));
  pointTempAt(workRoot);
  workHome = join(workRoot, "home");
  mkdirSync(workHome, { recursive: true });
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
});

afterEach(() => {
  for (const pid of helperPids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  restoreEnv("TEMP", ORIGINAL_TEMP);
  restoreEnv("TMP", ORIGINAL_TMP);
  restoreEnv("HOME", ORIGINAL_HOME);
  restoreEnv("USERPROFILE", ORIGINAL_USERPROFILE);
  osHome.current = "";
  rmSync(workRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
});

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  return existsSync(path);
}

// The production first line (BOM + arm line), then a tail that only leaves
// a marker three seconds later.
function markerOnlyScript(
  productionBody: string,
  survivedPath: string,
): string {
  const firstLine = productionBody.split("\n")[0] ?? "";
  return [
    firstLine,
    `Start-Sleep -Seconds ${HELPER_SLEEP_SECONDS}`,
    `[System.IO.File]::WriteAllText(${powershellSingleQuoted(survivedPath)}, 'ok')`,
    "",
  ].join("\n");
}

// The production first line, then a wait (bounded, 60 s) for `goPath`, then
// a marker holding the helper's own pid. The marker can therefore only be
// written once the test creates `goPath`, after the launching process is gone.
function handshakeScript(
  productionBody: string,
  goPath: string,
  survivedPath: string,
): string {
  const firstLine = productionBody.split("\n")[0] ?? "";
  return [
    firstLine,
    "$d = (Get-Date).AddSeconds(60)",
    `while (-not (Test-Path -LiteralPath ${powershellSingleQuoted(goPath)}) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 100 }`,
    `[System.IO.File]::WriteAllText(${powershellSingleQuoted(survivedPath)}, [string]$PID)`,
    "",
  ].join("\n");
}

const NEVER_EXITS: SpawnedProcess["exited"] = new Promise(() => undefined);

function fastClock(): HelperArmWaitDeps {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    waitMs: 1_000,
    pollIntervalMs: 100,
  };
}

interface RecordedLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly detached: boolean | undefined;
  readonly stdio: unknown;
  readonly windowsHide: boolean | undefined;
}

describe.skipIf(process.platform !== "win32")(
  "the finalize helper's real PowerShell handoff",
  () => {
    it(
      "arms through the real launcher from a temp directory with an apostrophe and non-ASCII characters",
      async () => {
        const oddDir = join(workRoot, "O'Brien-Zoë-日本");
        mkdirSync(oddDir, { recursive: true });
        pointTempAt(oddDir);
        const {
          scheduleFinalizationHelper,
          defaultSpawnImpl,
          defaultWriteImpl,
          defaultHelperArmWaitDeps,
        } = await loadHelper();
        let survivedPath = "";
        const result = await scheduleFinalizationHelper({
          environment: "production",
          stagedBinaryPath: join(oddDir, "staged.exe"),
          livePath: join(oddDir, "live.exe"),
          parentPid: process.pid,
          parentExitTimeoutSeconds: 60,
          platform: "win32",
          spawnImpl: defaultSpawnImpl,
          writeImpl: async (path, body) => {
            if (!path.endsWith(".ps1")) {
              await defaultWriteImpl(path, body);
              return;
            }
            survivedPath = path.replace(/\.ps1$/, ".survived");
            await defaultWriteImpl(path, markerOnlyScript(body, survivedPath));
          },
          armWait: defaultHelperArmWaitDeps,
        });

        expect(result.status).toBe("armed");
        expect(typeof result.helperPid).toBe("number");
        if (result.helperPid !== null) helperPids.push(result.helperPid);
        expect(existsSync(result.armedPath ?? "")).toBe(true);
        // The launcher has exited by now; the helper it started has not.
        expect(() => process.kill(result.helperPid ?? 0, 0)).not.toThrow();
        expect(await waitForFile(survivedPath, SURVIVED_POLL_MS)).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "keeps running after the process that launched it exits",
      async () => {
        const recorded: RecordedLaunch[] = [];
        const recordingSpawn: SpawnImpl = (command, args, options) => {
          recorded.push({
            command,
            args,
            detached: options.detached,
            stdio: options.stdio,
            windowsHide: options.windowsHide,
          });
          return {
            pid: undefined,
            unref: () => undefined,
            kill: () => undefined,
            exited: Promise.resolve({ exitCode: 0, errorMessage: null }),
          };
        };
        const { scheduleFinalizationHelper, defaultWriteImpl } =
          await loadHelper();
        let goPath = "";
        let survivedPath = "";
        const result = await scheduleFinalizationHelper({
          environment: "production",
          stagedBinaryPath: join(workRoot, "staged.exe"),
          livePath: join(workRoot, "live.exe"),
          parentPid: process.pid,
          parentExitTimeoutSeconds: 60,
          platform: "win32",
          spawnImpl: recordingSpawn,
          writeImpl: async (path, body) => {
            if (!path.endsWith(".ps1")) {
              await defaultWriteImpl(path, body);
              return;
            }
            goPath = path.replace(/\.ps1$/, ".go");
            survivedPath = path.replace(/\.ps1$/, ".survived");
            await defaultWriteImpl(
              path,
              handshakeScript(body, goPath, survivedPath),
            );
          },
          armWait: fastClock(),
        });
        // Nothing was launched, so the CLI side gave up; the script it wrote
        // is what the separate process below launches.
        expect(result.status).toBe("failed");
        expect(recorded).toHaveLength(1);

        // A separate node process plays the CLI: it spawns the recorded
        // launcher the way libuv does for the CLI (non-detached, so in its
        // job object), waits for the launcher, and exits.
        const parentScript = [
          'const { spawn } = require("node:child_process");',
          "const d = JSON.parse(process.env.LAUNCH_DESCRIPTOR);",
          "const child = spawn(d.command, d.args, {",
          "  stdio: d.stdio, windowsHide: d.windowsHide, detached: d.detached,",
          "});",
          'child.on("error", () => process.exit(4));',
          'child.on("exit", (code) => process.exit(code === 0 ? 0 : 3));',
        ].join("\n");
        const parent = spawnSync(process.execPath, ["-e", parentScript], {
          env: {
            ...process.env,
            LAUNCH_DESCRIPTOR: JSON.stringify(recorded[0]),
          },
          timeout: 30_000,
        });
        expect(parent.status).toBe(0);

        // The parent and its launcher are gone. The helper armed with its own
        // pid, is still alive, and has not yet written its marker: it is
        // waiting for the go file.
        const armedPath = result.armedPath ?? "";
        expect(await waitForFile(armedPath, SURVIVED_POLL_MS)).toBe(true);
        const helperPid = Number.parseInt(readFileSync(armedPath, "utf8"), 10);
        expect(Number.isSafeInteger(helperPid)).toBe(true);
        helperPids.push(helperPid);
        expect(existsSync(survivedPath)).toBe(false);
        expect(() => process.kill(helperPid, 0)).not.toThrow();

        // Release it: what it writes now was written after the parent exited,
        // by the process that armed.
        writeFileSync(goPath, "");
        expect(await waitForFile(survivedPath, SURVIVED_POLL_MS)).toBe(true);
        expect(readFileSync(survivedPath, "utf8").trim()).toBe(
          String(helperPid),
        );
      },
      TEST_TIMEOUT_MS,
    );

    describe("a helper that arms after the CLI gave up", () => {
      // Runs the production script under real PowerShell, not detached.
      async function runAbandonedScript(opts: { readonly abandoned: boolean }) {
        const reachedPath = join(workRoot, "staged-reached");
        const stagedBinaryPath = join(workRoot, "staged-stub.cmd");
        writeFileSync(
          stagedBinaryPath,
          `@echo off\r\ntype nul > "${reachedPath}"\r\n`,
        );
        const exitedParent = spawnSync("cmd.exe", ["/c", "exit", "0"]);
        if (exitedParent.pid === undefined) {
          throw new Error("could not spawn cmd.exe to get an exited pid");
        }
        const { scheduleFinalizationHelper, defaultWriteImpl } =
          await loadHelper();
        const { cliPostFinalizeMarkerPath } = await import("../../store/paths");
        const result = await scheduleFinalizationHelper({
          environment: "production",
          stagedBinaryPath,
          livePath: join(workRoot, "live.exe"),
          parentPid: exitedParent.pid,
          parentExitTimeoutSeconds: 2,
          platform: "win32",
          spawnImpl: () => ({
            pid: undefined,
            unref: () => undefined,
            kill: () => undefined,
            exited: NEVER_EXITS,
          }),
          writeImpl: defaultWriteImpl,
          armWait: fastClock(),
        });
        expect(result.status).toBe("failed");
        const scriptPath = result.scriptPath ?? "";
        const abandonedPath = scriptPath.replace(/\.ps1$/, ".abandoned");
        expect(existsSync(abandonedPath)).toBe(true);
        if (!opts.abandoned) unlinkSync(abandonedPath);

        const run = spawnSync(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
          { timeout: 30_000 },
        );
        const markerPath = cliPostFinalizeMarkerPath("production");
        expect(markerPath.startsWith(workHome)).toBe(true);
        return {
          status: run.status,
          armed: existsSync(result.armedPath ?? ""),
          reached: existsSync(reachedPath),
          markerWritten: existsSync(markerPath),
        };
      }

      it(
        "exits without finalizing once the CLI has abandoned it",
        async () => {
          const run = await runAbandonedScript({ abandoned: true });
          expect(run.armed).toBe(true);
          expect(run.status).toBe(0);
          expect(run.reached).toBe(false);
          expect(run.markerWritten).toBe(false);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "finalizes through the staged binary when nothing abandoned it",
        async () => {
          const run = await runAbandonedScript({ abandoned: false });
          expect(run.armed).toBe(true);
          expect(run.status).toBe(0);
          expect(run.reached).toBe(true);
        },
        TEST_TIMEOUT_MS,
      );
    });
  },
);
