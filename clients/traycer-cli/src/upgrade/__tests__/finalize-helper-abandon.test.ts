import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A finalize helper that arms after the CLI gave up on it must not
// finalize. The ordering pinned here: the CLI writes `.abandoned` before it
// returns `failed` (so before it relaunches the host and exits), and the
// script looks for it after its parent-exit wait. The POSIX script is
// executed for real, as the late helper would run it.

// `store/paths` binds its home root from `os.homedir()` at module load.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-finalize-abandon-test-"));
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

// Vitest's default is 5 s; the late helper runs under a 15 s spawnSync limit.
const TEST_TIMEOUT_MS = 30_000;

function exitedPid(): number {
  const done = spawnSync(process.execPath, ["-e", ""]);
  if (done.pid === undefined) {
    throw new Error("could not spawn node to get an exited pid");
  }
  return done.pid;
}

interface AbandonFixture {
  readonly scriptPath: string;
  readonly armedPath: string;
  readonly abandonedPath: string;
  readonly reachedPath: string;
  readonly markerPath: string;
}

// The CLI side: schedules a helper whose launch starts nothing, so it
// gives up and reports `failed`.
async function scheduleUnlaunchedHelper(): Promise<AbandonFixture> {
  const reachedPath = join(workHome, "staged-reached");
  const stagedBinaryPath = join(workHome, "staged-stub.sh");
  writeFileSync(stagedBinaryPath, `#!/bin/sh\n: > "${reachedPath}"\n`);
  chmodSync(stagedBinaryPath, 0o755);

  const { scheduleFinalizationHelper, defaultWriteImpl } =
    await import("../finalize-helper");
  let now = 0;
  const result = await scheduleFinalizationHelper({
    environment: "production",
    stagedBinaryPath,
    livePath: join(workHome, "live-binary"),
    parentPid: exitedPid(),
    parentExitTimeoutSeconds: 2,
    platform: process.platform,
    spawnImpl: () => ({
      pid: undefined,
      unref: () => undefined,
      kill: () => undefined,
      exited: new Promise(() => undefined),
    }),
    writeImpl: defaultWriteImpl,
    armWait: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      waitMs: 1_000,
      pollIntervalMs: 100,
    },
  });
  expect(result.status).toBe("failed");
  expect(result.scriptPath).not.toBeNull();
  const scriptPath = result.scriptPath ?? "";
  return {
    scriptPath,
    armedPath: scriptPath.replace(/\.sh$/, ".armed"),
    abandonedPath: scriptPath.replace(/\.sh$/, ".abandoned"),
    reachedPath,
    markerPath: join(workHome, ".traycer", "cli", "post-finalize.json"),
  };
}

// The late helper: the script the CLI wrote, run to completion.
function runLateHelper(fixture: AbandonFixture): number | null {
  return spawnSync("/bin/sh", [fixture.scriptPath], { timeout: 15_000 }).status;
}

describe.skipIf(process.platform === "win32")(
  "a finalize helper that arms after the CLI gave up",
  () => {
    it(
      "exits without finalizing once the CLI has abandoned it",
      async () => {
        const fixture = await scheduleUnlaunchedHelper();
        expect(existsSync(fixture.abandonedPath)).toBe(true);

        const status = runLateHelper(fixture);

        // It did arm, so this is the late-arm case, not a helper that never ran.
        expect(existsSync(fixture.armedPath)).toBe(true);
        expect(status).toBe(0);
        expect(existsSync(fixture.reachedPath)).toBe(false);
        expect(existsSync(fixture.markerPath)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "finalizes through the staged binary when nothing abandoned it",
      async () => {
        const fixture = await scheduleUnlaunchedHelper();
        unlinkSync(fixture.abandonedPath);

        const status = runLateHelper(fixture);

        expect(existsSync(fixture.armedPath)).toBe(true);
        expect(status).toBe(0);
        expect(existsSync(fixture.reachedPath)).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
