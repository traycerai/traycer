import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sandboxRoot = "";

// Lets one test force `stat` to fail for a specific path (simulating an
// unreadable/unverifiable age - the directory vanished, a transient
// stat error) without needing a flaky real-world reproduction. Every
// other path proxies straight through to the real implementation.
const mocks = vi.hoisted(() => ({
  forceStatFailureForPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (path: PathLike) => {
      if (path === mocks.forceStatFailureForPath) {
        throw Object.assign(new Error("simulated stat failure"), {
          code: "EIO",
        });
      }
      return actual.stat(path);
    },
  };
});

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  type Environment = "dev" | "production";
  const stagingRootFor = (environment: Environment): string =>
    join(sandboxRoot, "host", environment, "install-staging");
  return {
    ...actual,
    hostStagingRoot: (environment: Environment) => stagingRootFor(environment),
    ensureHostStagingRoot: async (environment: Environment) => {
      mkdirSync(stagingRootFor(environment), { recursive: true });
    },
  };
});

import { createOwnedTempDir, sweepOwnedTempDirs } from "../owned-temp";
import { isProcessAlive } from "../process-identity";

const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function ageDir(path: string, ms: number): void {
  const old = new Date(Date.now() - ms);
  utimesSync(path, old, old);
}

describe("createOwnedTempDir / sweepOwnedTempDirs", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-owned-temp-test-"));
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("stamps a fresh temp dir with this process's own identity token", async () => {
    const { path } = await createOwnedTempDir("production", "dl-");
    const token = JSON.parse(readFileSync(join(path, ".owner.json"), "utf8"));
    expect(token.pid).toBe(process.pid);
  });

  it("spares a self-owned temp dir regardless of age", async () => {
    const { path } = await createOwnedTempDir("production", "dl-");
    ageDir(path, TWENTY_FIVE_HOURS_MS * 10);
    const swept = await sweepOwnedTempDirs("production");
    expect(swept).not.toContain(path);
  });

  it("sweeps a token-less temp dir once past the 24h fallback", async () => {
    const stagingRoot = join(
      sandboxRoot,
      "host",
      "production",
      "install-staging",
    );
    mkdirSync(stagingRoot, { recursive: true });
    const legacyDir = join(stagingRoot, "stage-legacy");
    mkdirSync(legacyDir);
    ageDir(legacyDir, TWENTY_FIVE_HOURS_MS);
    const swept = await sweepOwnedTempDirs("production");
    expect(swept).toContain(legacyDir);
  });

  it("spares a token-less temp dir with an unreadable age, never deletes on an unverifiable stat", async () => {
    const stagingRoot = join(
      sandboxRoot,
      "host",
      "production",
      "install-staging",
    );
    mkdirSync(stagingRoot, { recursive: true });
    const unverifiableDir = join(stagingRoot, "stage-unverifiable");
    mkdirSync(unverifiableDir);
    mocks.forceStatFailureForPath = unverifiableDir;
    try {
      const swept = await sweepOwnedTempDirs("production");
      expect(swept).not.toContain(unverifiableDir);
    } finally {
      mocks.forceStatFailureForPath = null;
    }
  });

  it("spares a token-less temp dir younger than the 24h fallback", async () => {
    const stagingRoot = join(
      sandboxRoot,
      "host",
      "production",
      "install-staging",
    );
    mkdirSync(stagingRoot, { recursive: true });
    const freshDir = join(stagingRoot, "stage-fresh");
    mkdirSync(freshDir);
    ageDir(freshDir, ONE_HOUR_MS);
    const swept = await sweepOwnedTempDirs("production");
    expect(swept).not.toContain(freshDir);
  });

  it("sweeps a dead-owner temp dir immediately, even though it is younger than 24h", async () => {
    const stagingRoot = join(
      sandboxRoot,
      "host",
      "production",
      "install-staging",
    );
    mkdirSync(stagingRoot, { recursive: true });
    const deadDir = join(stagingRoot, "dl-dead");
    mkdirSync(deadDir);
    writeFileSync(
      join(deadDir, ".owner.json"),
      JSON.stringify({ pid: 999999, startedAtMs: Date.now() }),
    );
    ageDir(deadDir, ONE_HOUR_MS);
    if (isProcessAlive(999999)) {
      // Best-effort: skip if 999999 happens to be alive on this machine.
      return;
    }
    const swept = await sweepOwnedTempDirs("production");
    expect(swept).toContain(deadDir);
  });

  it("ignores non-directory entries under the staging root", async () => {
    const stagingRoot = join(
      sandboxRoot,
      "host",
      "production",
      "install-staging",
    );
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(join(stagingRoot, "stray-file.txt"), "not a temp dir");
    await expect(sweepOwnedTempDirs("production")).resolves.toEqual([]);
  });

  describe.skipIf(process.platform === "win32")(
    "two-process identity mismatch",
    () => {
      let child: ChildProcessWithoutNullStreams | null = null;

      afterEach(() => {
        child?.kill();
        child = null;
      });

      it("sweeps a temp dir whose owner token identity mismatches a real live process, even though it is young", async () => {
        const proc = spawn("sleep", ["5"]);
        child = proc;
        const pid = await new Promise<number>((resolve, reject) => {
          proc.once("spawn", () => {
            if (proc.pid === undefined) {
              reject(new Error("spawned sleep process has no pid"));
              return;
            }
            resolve(proc.pid);
          });
          proc.once("error", reject);
        });
        const stagingRoot = join(
          sandboxRoot,
          "host",
          "production",
          "install-staging",
        );
        mkdirSync(stagingRoot, { recursive: true });
        const mismatchedDir = join(stagingRoot, "dl-mismatched");
        mkdirSync(mismatchedDir);
        writeFileSync(
          join(mismatchedDir, ".owner.json"),
          JSON.stringify({
            pid,
            // Deliberately far from the real process's actual start time.
            startedAtMs: Date.now() - 10 * 60 * 1000,
          }),
        );
        const swept = await sweepOwnedTempDirs("production");
        expect(swept).toContain(mismatchedDir);
      });
    },
  );
});
