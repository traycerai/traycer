import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// `execFileSync` copies a failing child's stderr straight into THIS
// process's stderr unless `stdio` is given - so the parent's own fd 2 is
// exactly what a production caller's fix must keep clean. That fd cannot be
// observed from inside the SAME process (it is not routed through
// `process.stderr.write`, which is the only stream vitest's reporter can
// see), so this suite runs the real production functions in a real Bun
// SUBPROCESS and captures THAT subprocess's stderr from the outside, via
// `spawnSync`. A fake `ps` on PATH stands in for the real one: it writes a
// unique marker to its own stderr and exits 1, so the production function's
// `execFileSync` call is guaranteed to fail and (pre-fix) would have leaked
// exactly that marker.
//
// POSIX only - `describe.skipIf(process.platform === "win32")` below.
// Windows is proven on a real host separately (this repo's CI has no
// Windows sandbox for a suite that needs to fabricate a fake `ps`/`tasklist`
// on PATH and inspect real subprocess stderr).
const STDERR_MARKER = "T08-FAKE-PS-STDERR";
const RESULT_PREFIX = "RESULT:";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(THIS_DIR, "fixtures");
const PRODUCTION_WORKER = join(FIXTURES_DIR, "exec-sync-stderr-worker.ts");
const RAW_CONTROL_WORKER = join(
  FIXTURES_DIR,
  "exec-sync-stderr-raw-control-worker.ts",
);

let sandboxDir = "";
let fakePsLogPath = "";

beforeEach(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), "traycer-exec-sync-stderr-"));
  const fakePsPath = join(sandboxDir, "ps");
  writeFileSync(
    fakePsPath,
    [
      "#!/bin/sh",
      `echo "${STDERR_MARKER}" >&2`,
      'echo "invoked $$ $(date +%s)" >> "$FAKE_PS_INVOKED_LOG"',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // `writeFileSync`'s `mode` only applies at CREATE time on some platforms;
  // set it explicitly so the fake `ps` is always executable.
  chmodSync(fakePsPath, 0o755);
  fakePsLogPath = join(sandboxDir, "invoked.log");
  writeFileSync(fakePsLogPath, "");
});

afterEach(() => {
  rmSync(sandboxDir, { recursive: true, force: true });
});

interface WorkerRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runWorker(
  scriptPath: string,
  extraEnv: Readonly<Record<string, string>>,
): WorkerRun {
  const result = spawnSync("bun", ["run", scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Fake `ps` first on PATH: whatever the worker (or the production code
      // it calls) resolves as `ps` is this script, never the real binary.
      PATH: `${sandboxDir}:${process.env.PATH ?? ""}`,
      FAKE_PS_INVOKED_LOG: fakePsLogPath,
      ...extraEnv,
    },
  });
  // A worker that failed to launch at all must not be read as "produced no
  // marker" - that would pass every negative assertion below vacuously.
  if (result.error !== undefined) {
    throw new Error(
      `worker failed to launch at ${scriptPath}: ${result.error.message}`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readResultLine(stdout: string): unknown {
  const line = stdout.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
  expect(
    line,
    `worker produced no ${RESULT_PREFIX} line; stdout was:\n${stdout}`,
  ).toBeDefined();
  const definedLine = line;
  if (definedLine === undefined) {
    throw new Error("unreachable: asserted above");
  }
  return JSON.parse(definedLine.slice(RESULT_PREFIX.length));
}

/** Real proof the fake `ps` actually ran, not just that nothing crashed. */
function fakePsInvocationCount(): number {
  return readFileSync(fakePsLogPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

describe.skipIf(process.platform === "win32")(
  "a stderr-writing ps that execFileSync spawns reaches nothing on the parent's stderr",
  () => {
    beforeAll(() => {
      const result = spawnSync("bun", ["--version"]);
      if (result.error !== undefined || result.status !== 0) {
        throw new Error(
          "this suite spawns worker fixtures with Bun; install Bun 1.3.14 (repo toolchain)",
        );
      }
    });

    it("clients/shared/host-lock/process-identity.ts: readProcessStartTimeMs never forwards the child's stderr", () => {
      const { status, stdout, stderr } = runWorker(PRODUCTION_WORKER, {
        WORKER_TARGET: "shared",
      });
      expect(status).toBe(0);
      expect(stderr).not.toContain(STDERR_MARKER);
      // The function really ran the fake `ps`, got its exit-1 failure, and
      // returned the documented failure value - never a stale/mocked result.
      expect(readResultLine(stdout)).toBeNull();
      expect(fakePsInvocationCount()).toBeGreaterThan(0);
    });

    // `queryPidStartFingerprint` (protocol/src/config/credentials-lock.ts)
    // shells out to `ps` via `psLstart` only on a POSIX platform that is NOT
    // Linux - Linux reads `/proc/<pid>/stat` directly and never spawns
    // anything, so this fake-`ps`-on-PATH harness cannot observe it there.
    // Proven on darwin/BSD instead of skipped outright; the case above
    // already proves the shared-package function on every POSIX platform
    // including Linux, since `readPosixProcessStartTimeMs` shells out to
    // `ps` unconditionally on every non-Windows platform.
    it.skipIf(process.platform === "linux")(
      "protocol/src/config/credentials-lock.ts: ownPidStartFingerprint never forwards the child's stderr",
      () => {
        const { status, stdout, stderr } = runWorker(PRODUCTION_WORKER, {
          WORKER_TARGET: "protocol",
        });
        expect(status).toBe(0);
        expect(stderr).not.toContain(STDERR_MARKER);
        expect(readResultLine(stdout)).toBeNull();
        expect(fakePsInvocationCount()).toBeGreaterThan(0);
      },
    );

    // Non-vacuity control: the SAME harness (fake `ps` first on PATH, the
    // same subprocess-stderr capture) running a raw `execFileSync("ps", ...)`
    // WITHOUT `stdio` - plain inline code, never production - DOES show the
    // marker. Without this, a harness bug that captured nothing at all (a
    // wrong fd, a PATH override that never took) would make the two
    // negative assertions above pass for the wrong reason.
    it("control: a raw execFileSync without `stdio` DOES leak the child's stderr into the worker's own stderr", () => {
      const { status, stdout, stderr } = runWorker(RAW_CONTROL_WORKER, {});
      expect(status).toBe(0);
      expect(stderr).toContain(STDERR_MARKER);
      expect(readResultLine(stdout)).toBeNull();
      expect(fakePsInvocationCount()).toBeGreaterThan(0);
    });
  },
);
