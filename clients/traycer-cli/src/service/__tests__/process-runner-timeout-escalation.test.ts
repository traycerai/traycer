import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ProcessTimeoutError,
  runCommand,
  runCommandForBytes,
} from "../process-runner";

// EXPERIMENT (unmodified production code): `runCommand`/
// `runCommandForBytes` (process-runner.ts:22-124 / :141-173) wrap
// `execFile` with `timeout: options.timeoutMs`. Node's own timeout sends
// SIGTERM and destroys the child's stdio streams, but the promisified
// callback fires only on the child's `close` event, which needs the child
// to actually EXIT. A child that traps/ignores SIGTERM - or whose stdout
// pipe is held open by a surviving grandchild - may never close, leaving
// the promise pending long after `timeoutMs`.
//
// REAL processes, REAL timers (no fake timers - the subject is the real OS
// signal/exit/pipe-close interaction, which fake timers cannot stand in
// for). POSIX only.
describe.skipIf(process.platform === "win32")(
  "process-runner timeout escalation (experiment, no production edits)",
  () => {
    const workDir = mkdtempSync(
      join(tmpdir(), "process-runner-timeout-escalation-"),
    );
    const livePids: number[] = [];

    afterEach(() => {
      for (const pid of livePids.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone - nothing to clean up.
        }
      }
    });

    afterAll(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    function pidFilePath(name: string): string {
      return join(workDir, name);
    }

    async function sleep(ms: number): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function readPidFileEventually(
      path: string,
      timeoutMs: number,
    ): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (existsSync(path)) {
          const raw = readFileSync(path, "utf8").trim();
          if (raw.length > 0) {
            const pid = Number.parseInt(raw, 10);
            if (Number.isInteger(pid)) return pid;
          }
        }
        await sleep(20);
      }
      throw new Error(`pid file ${path} was never written`);
    }

    type SettleOutcome<T> =
      | { readonly kind: "pending" }
      | { readonly kind: "fulfilled"; readonly value: T }
      | { readonly kind: "rejected"; readonly reason: unknown };

    /**
     * Race `promise` against a REAL `ms`-long timer. `promise` is given its
     * own `.catch` no-op FIRST, so a rejection that only arrives after this
     * function returns (once `afterEach`'s SIGKILL finally lets the child
     * close) never surfaces as an unhandled rejection.
     */
    async function raceAgainstRealTimeout<T>(
      promise: Promise<T>,
      ms: number,
    ): Promise<SettleOutcome<T>> {
      promise.catch(() => undefined);
      return Promise.race([
        promise.then(
          (value): SettleOutcome<T> => ({ kind: "fulfilled", value }),
          (reason): SettleOutcome<T> => ({ kind: "rejected", reason }),
        ),
        sleep(ms).then((): SettleOutcome<T> => ({ kind: "pending" })),
      ]);
    }

    const TIMEOUT_MS = 200;
    // Mirrors PROCESS_TIMEOUT_KILL_GRACE_MS in service/process-runner.ts (a literal, so this file still loads on pre-fix bytes).
    const KILL_GRACE_MS = 2_000;
    const RACE_MS = TIMEOUT_MS + KILL_GRACE_MS + 1_000;

    it("control c1: a well-behaved child settles as ProcessTimeoutError at ~200ms", async () => {
      const outcome = await raceAgainstRealTimeout(
        runCommand("/bin/sleep", ["30"], {
          env: undefined,
          cwd: undefined,
          timeoutMs: TIMEOUT_MS,
          tolerateNonZeroExit: false,
        }),
        RACE_MS,
      );
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.reason).toBeInstanceOf(ProcessTimeoutError);
      }
    }, 10_000);

    it("(p1) runCommand: a child that traps SIGTERM settles within the SIGKILL grace", async () => {
      const pidFile = pidFilePath("p1-pid");
      const outcomePromise = raceAgainstRealTimeout(
        runCommand(
          "/bin/sh",
          ["-c", 'echo $$ > "$1"; trap "" TERM; exec sleep 30', "sh", pidFile],
          {
            env: undefined,
            cwd: undefined,
            timeoutMs: TIMEOUT_MS,
            tolerateNonZeroExit: false,
          },
        ),
        RACE_MS,
      );
      const pid = await readPidFileEventually(pidFile, RACE_MS);
      livePids.push(pid);

      const outcome = await outcomePromise;
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.reason).toBeInstanceOf(ProcessTimeoutError);
        expect(String(outcome.reason)).toContain("SIGKILL");
      }
    }, 10_000);

    it("(p2) runCommand: the child exits on SIGTERM, but a grandchild holds stdout", async () => {
      const pidFile = pidFilePath("p2-grandchild-pid");
      const outcomePromise = raceAgainstRealTimeout(
        runCommand(
          "/bin/sh",
          [
            "-c",
            '(trap "" TERM; exec sleep 30) & echo $! > "$1"; exec sleep 30',
            "sh",
            pidFile,
          ],
          {
            env: undefined,
            cwd: undefined,
            timeoutMs: TIMEOUT_MS,
            tolerateNonZeroExit: false,
          },
        ),
        RACE_MS,
      );
      const grandchildPid = await readPidFileEventually(pidFile, RACE_MS);
      livePids.push(grandchildPid);

      const outcome = await outcomePromise;
      if (outcome.kind === "rejected") {
        expect(outcome.reason).toBeInstanceOf(ProcessTimeoutError);
      }
      expect(outcome.kind).toBe("rejected");
    }, 10_000);

    it("(p3a) runCommandForBytes: a child that traps SIGTERM settles within the SIGKILL grace", async () => {
      const pidFile = pidFilePath("p3a-pid");
      const outcomePromise = raceAgainstRealTimeout(
        runCommandForBytes(
          "/bin/sh",
          ["-c", 'echo $$ > "$1"; trap "" TERM; exec sleep 30', "sh", pidFile],
          {
            env: undefined,
            cwd: undefined,
            timeoutMs: TIMEOUT_MS,
          },
        ),
        RACE_MS,
      );
      const pid = await readPidFileEventually(pidFile, RACE_MS);
      livePids.push(pid);

      const outcome = await outcomePromise;
      expect(outcome.kind).toBe("rejected");
    }, 10_000);

    it("(p3b) runCommandForBytes: the child exits on SIGTERM, but a grandchild holds stdout", async () => {
      const pidFile = pidFilePath("p3b-grandchild-pid");
      const outcomePromise = raceAgainstRealTimeout(
        runCommandForBytes(
          "/bin/sh",
          [
            "-c",
            '(trap "" TERM; exec sleep 30) & echo $! > "$1"; exec sleep 30',
            "sh",
            pidFile,
          ],
          {
            env: undefined,
            cwd: undefined,
            timeoutMs: TIMEOUT_MS,
          },
        ),
        RACE_MS,
      );
      const grandchildPid = await readPidFileEventually(pidFile, RACE_MS);
      livePids.push(grandchildPid);

      const outcome = await outcomePromise;
      expect(outcome.kind).toBe("rejected");
    }, 10_000);
  },
);
