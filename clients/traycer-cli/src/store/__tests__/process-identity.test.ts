import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  __parseElapsedSecondsForTest as parseElapsedSeconds,
  computeProcessIdentityVerdict,
  currentProcessIdentityToken,
  isProcessAlive,
  readProcessStartIdentity,
  readProcessStartTimeMs,
  verifyProcessIdentity,
  type ProcessIdentityToken,
} from "../process-identity";

describe("parseElapsedSeconds (ps -o etime= format)", () => {
  it("parses mm:ss", () => {
    expect(parseElapsedSeconds("05:23")).toBe(5 * 60 + 23);
    expect(parseElapsedSeconds("00:00")).toBe(0);
  });

  it("parses hh:mm:ss", () => {
    expect(parseElapsedSeconds("02:05:23")).toBe(2 * 3600 + 5 * 60 + 23);
  });

  it("parses dd-hh:mm:ss", () => {
    expect(parseElapsedSeconds("3-02:05:23")).toBe(
      3 * 86400 + 2 * 3600 + 5 * 60 + 23,
    );
  });

  it("returns null for unparseable input", () => {
    expect(parseElapsedSeconds("")).toBeNull();
    expect(parseElapsedSeconds("not-an-etime")).toBeNull();
    expect(parseElapsedSeconds("1:2:3:4")).toBeNull();
  });
});

describe("computeProcessIdentityVerdict (pure decision logic)", () => {
  // Tokens are compared only against each other, never against
  // `process.platform`, so a fixed tag keeps these rows identical on every
  // runner.
  const A = "linux:boot-a 1000";
  const B = "linux:boot-a 9999";

  it("returns dead when liveness is dead, regardless of identities", () => {
    expect(computeProcessIdentityVerdict("dead", A, A)).toBe("dead");
    expect(computeProcessIdentityVerdict("dead", null, null)).toBe("dead");
  });

  // Deliberately does NOT short-circuit on indeterminate liveness: the
  // liveness probe (kill/tasklist) and the identity probe (/proc, ps,
  // Get-Process) are independent OS queries, so an identity read can
  // still succeed and carry positive evidence even when liveness itself
  // couldn't be established (item B, Fixup round-2 ticket).
  it("still derives a verdict from the identity comparison when liveness itself is indeterminate", () => {
    // A successful, matching identity read is positive evidence of
    // "still there", even without independent liveness confirmation.
    expect(computeProcessIdentityVerdict("indeterminate", A, A)).toBe(
      "alive-same",
    );
    // A successful, mismatching read is positive evidence the recorded
    // holder is gone (dead/recycled) - breakable.
    expect(computeProcessIdentityVerdict("indeterminate", A, B)).toBe(
      "alive-different",
    );
    // No recorded identity to compare against, or a failed identity
    // read (`null`), stays indeterminate - nothing positive either way.
    expect(computeProcessIdentityVerdict("indeterminate", null, A)).toBe(
      "indeterminate",
    );
    expect(computeProcessIdentityVerdict("indeterminate", A, null)).toBe(
      "indeterminate",
    );
    expect(computeProcessIdentityVerdict("indeterminate", null, null)).toBe(
      "indeterminate",
    );
  });

  it("returns indeterminate when alive but either identity is unknown", () => {
    expect(computeProcessIdentityVerdict("alive", null, A)).toBe(
      "indeterminate",
    );
    expect(computeProcessIdentityVerdict("alive", A, null)).toBe(
      "indeterminate",
    );
    expect(computeProcessIdentityVerdict("alive", null, null)).toBe(
      "indeterminate",
    );
  });

  it("returns alive-same only for byte-identical identities", () => {
    expect(computeProcessIdentityVerdict("alive", A, A)).toBe("alive-same");
  });

  it("returns alive-different when alive but the identities positively differ (recycled pid)", () => {
    expect(computeProcessIdentityVerdict("alive", A, B)).toBe(
      "alive-different",
    );
    expect(computeProcessIdentityVerdict("alive", B, A)).toBe(
      "alive-different",
    );
  });

  /*
   * The comparison used to be a 5s tolerance over two epoch-millisecond
   * start times, each derived as `Date.now() - <elapsed since start>`. Any
   * `CLOCK_REALTIME` step wider than the tolerance between recording a token
   * and verifying it moved one operand and not the other, so a LIVE holder
   * read as "alive-different" - which every caller here treats as licence to
   * break its lock or sweep its temp dir. Identities are recorded once by the
   * kernel and only read back, so there is no clock in the comparison and no
   * tolerance to tune: two nearby-but-distinct stamps are different, full
   * stop.
   */
  it("has no tolerance window a clock step could fall inside", () => {
    expect(
      computeProcessIdentityVerdict(
        "alive",
        "linux:boot-a 1",
        "linux:boot-a 2",
      ),
    ).toBe("alive-different");
  });

  // A record that travelled between machines, or a broken reader. Knowing
  // less is the answer; "different" would be positive evidence we do not have.
  it("stays indeterminate across platform tags rather than claiming difference", () => {
    expect(
      computeProcessIdentityVerdict("alive", A, "darwin:Sun Jul 27 2026"),
    ).toBe("indeterminate");
  });
});

describe("isProcessAlive", () => {
  it("returns true for a real, currently-running pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for an invalid pid without probing", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

describe("verifyProcessIdentity", () => {
  it("returns alive-same when the recorded identity matches our own creation stamp", () => {
    const ownIdentity = readProcessStartIdentity(process.pid);
    // Best-effort: if this machine's probe can't read our own stamp, there's
    // nothing to construct a matching token from.
    if (ownIdentity === null) return;
    const token: ProcessIdentityToken = {
      pid: process.pid,
      startedAtMs: readProcessStartTimeMs(process.pid),
      startIdentity: ownIdentity,
    };
    expect(verifyProcessIdentity(token)).toBe("alive-same");
  });

  it("returns dead when a recorded identity under our own pid mismatches (pid recycled onto us)", () => {
    const ownIdentity = readProcessStartIdentity(process.pid);
    if (ownIdentity === null) return;
    const token: ProcessIdentityToken = {
      pid: process.pid,
      startedAtMs: readProcessStartTimeMs(process.pid),
      // A well-formed stamp from this platform that is positively not ours -
      // a dead predecessor's token surviving under a pid the OS has since
      // recycled onto this process.
      startIdentity: `${ownIdentity} 0`,
    };
    expect(verifyProcessIdentity(token)).toBe("dead");
  });

  it("returns indeterminate when the recorded identity has no creation stamp to compare", () => {
    const token: ProcessIdentityToken = {
      pid: process.pid,
      startedAtMs: readProcessStartTimeMs(process.pid),
      startIdentity: null,
    };
    expect(verifyProcessIdentity(token)).toBe("indeterminate");
  });

  it("returns dead for a pid that is provably not running", () => {
    // 999999 is not guaranteed unassigned on every OS, but combined with a
    // fabricated recent startedAtMs this mirrors the cli-lock dead-holder
    // fixture and only needs *some* not-currently-alive pid.
    const token: ProcessIdentityToken = {
      pid: 999999,
      startedAtMs: Date.now(),
      startIdentity: "linux:boot-a 1",
    };
    // Best-effort: if 999999 happens to be alive on this machine, skip
    // rather than assert a false failure.
    if (isProcessAlive(999999)) return;
    expect(verifyProcessIdentity(token)).toBe("dead");
  });
});

describe("currentProcessIdentityToken", () => {
  it("captures this process's own pid and a plausible start time", () => {
    const token = currentProcessIdentityToken();
    expect(token.pid).toBe(process.pid);
    if (token.startedAtMs !== null) {
      expect(token.startedAtMs).toBeLessThanOrEqual(Date.now());
    }
  });
});

// Real two-process scenarios: a genuinely separate OS process (not the
// `pid === process.pid` shortcut) must be independently identified as
// alive-same across two reads, and correctly read as dead once it exits.
// Windows is skipped here (matching the existing cli-lock.test.ts
// convention for platform-specific probes) - `sleep` isn't available and
// the PowerShell path has no equivalent light-weight fixture process.
describe.skipIf(process.platform === "win32")(
  "process start-time probing against a real spawned process",
  () => {
    let child: ChildProcessWithoutNullStreams | null = null;

    afterEach(() => {
      child?.kill();
      child = null;
    });

    function spawnSleeper(seconds: number): Promise<number> {
      const proc = spawn("sleep", [String(seconds)]);
      child = proc;
      return new Promise((resolve, reject) => {
        proc.once("spawn", () => {
          if (proc.pid === undefined) {
            reject(new Error("spawned sleep process has no pid"));
            return;
          }
          resolve(proc.pid);
        });
        proc.once("error", reject);
      });
    }

    it("reads a plausible start time and verifies as alive-same across independent reads", async () => {
      const pid = await spawnSleeper(5);
      const first = readProcessStartTimeMs(pid);
      expect(first).not.toBeNull();
      expect(Math.abs(Date.now() - (first as number))).toBeLessThan(15_000);

      const token: ProcessIdentityToken = {
        pid,
        startedAtMs: first,
        startIdentity: readProcessStartIdentity(pid),
      };
      // A second, independent observation of the same still-running
      // process - the "two-process" scenario the cli-lock hardening
      // tests build on.
      expect(verifyProcessIdentity(token)).toBe("alive-same");
    });

    it("reports dead once the process has exited", async () => {
      const pid = await spawnSleeper(30);
      const startedAtMs = readProcessStartTimeMs(pid);
      const startIdentity = readProcessStartIdentity(pid);
      const exited = new Promise<void>((resolve) => {
        child?.once("exit", () => resolve());
      });
      child?.kill();
      await exited;
      expect(verifyProcessIdentity({ pid, startedAtMs, startIdentity })).toBe(
        "dead",
      );
    });
  },
);
