const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-rotation-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Real `execFileSync`/`spawnSync` behavior, just call-counted - this is the
// same seam `readProcessStartIdentity` (below) and `hostIsLive` both go
// through, so the count is evidence about a SYNCHRONOUS OS probe having run,
// not a mocked stand-in for one.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

const { hostHomeDir, hostLogPath, hostPidMetadataPath } =
  await import("../../store/paths");
const { readProcessStartIdentity } =
  await import("../../store/process-identity");
const { MAX_HOST_LOG_BYTES, rotateHostLogIfOversized } =
  await import("../host-log-rotation");

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  // `hostHomeDir` resolves under the mocked `homedir()` - confirms this suite
  // cannot reach the real `~/.traycer` before any fixture is written.
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

const ENVIRONMENT = "dev";

describe("rotateHostLogIfOversized - async liveness guard", () => {
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child !== null && child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone - nothing left to clean up.
      }
    }
    child = null;
    vi.mocked(execFileSync).mockClear();
    await rm(hostHomeDir(ENVIRONMENT), { recursive: true, force: true });
  });

  // The supervisor's log rotation guard, over a real live holder.
  // `hostIsLive` -> `publishedHostProcessGone` -> `matchLiveProcessStartIdentity`
  // reads the live child's identity via a SYNCHRONOUS `execFileSync("ps", ...)`
  // spawn on macOS - blocking the event loop on every oversized-log check
  // against a live host, which is exactly what the async fix removes.
  it("consults a live host's identity without a synchronous execFileSync spawn", async () => {
    child = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child?.once("spawn", () => resolve());
      child?.once("error", reject);
    });
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error("expected the sleep child to have a pid");
    }

    // Real kernel creation stamp for the live holder, read BEFORE the mock's
    // call count is reset - this read itself spawns `ps` and must not count
    // against the assertion below.
    const startIdentity = readProcessStartIdentity(pid);
    expect(startIdentity).not.toBeNull();

    await mkdir(hostHomeDir(ENVIRONMENT), { recursive: true });
    await writeFile(
      hostPidMetadataPath(ENVIRONMENT),
      JSON.stringify({
        pid,
        hostId: "row4-live-host",
        version: "1.0.0",
        websocketUrl: "ws://127.0.0.1:7100/rpc",
        startedAt: new Date().toISOString(),
        processStartIdentity: startIdentity,
      }),
    );
    await writeFile(
      hostLogPath(ENVIRONMENT),
      "x".repeat(MAX_HOST_LOG_BYTES + 1),
    );

    vi.mocked(execFileSync).mockClear();

    const result = await rotateHostLogIfOversized(ENVIRONMENT);

    // (a) The liveness check must not block the event loop with a sync spawn.
    expect(execFileSync).toHaveBeenCalledTimes(0);
    // (b) A live host's log is never rotated out from under its open fd.
    expect(result).toBe("skipped");
  });
});
