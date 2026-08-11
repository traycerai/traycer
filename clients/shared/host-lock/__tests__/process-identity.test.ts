import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __processStartTimeMsFromElapsedSecondsForTest,
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartIdentityReaderForTest,
  __setAsyncProcessStartTimeReaderForTest,
  getPublishedProcessIdentityVerdict,
  readLiveProcessStartTimeMs,
  readProcessStartIdentity,
  verifyProcessIdentity,
} from "../process-identity";

const NOW_MS = Date.parse("2026-07-22T00:00:00.000Z");

// Tokens are compared only against each other, never against
// `process.platform`, so a fixed tag keeps these rows identical on every CI
// runner instead of branching on the host OS.
const PUBLISHED_IDENTITY = "linux:boot-a 4242";
const SAME_IDENTITY = "linux:boot-a 4242";
const OTHER_IDENTITY = "linux:boot-a 9999";

describe("POSIX elapsed-time validation", () => {
  it("converts a plausible elapsed time into an epoch start time", () => {
    expect(
      __processStartTimeMsFromElapsedSecondsForTest(30, NOW_MS, 3_600),
    ).toBe(NOW_MS - 30_000);
  });

  it("allows one-second ps resolution slack but rejects the next second", () => {
    expect(
      __processStartTimeMsFromElapsedSecondsForTest(3_601, NOW_MS, 3_600),
    ).toBe(NOW_MS - 3_601_000);
    expect(
      __processStartTimeMsFromElapsedSecondsForTest(3_602, NOW_MS, 3_600),
    ).toBeNull();
  });

  it("rejects the absurd elapsed value observed on loaded GitHub runners", () => {
    const observedDriftMs = 38_109_073_018_720_000;
    expect(
      __processStartTimeMsFromElapsedSecondsForTest(
        observedDriftMs / 1_000,
        NOW_MS,
        3_600,
      ),
    ).toBeNull();
  });
});

afterEach(() => {
  __setAsyncProcessLivenessReaderForTest(null);
  __setAsyncProcessStartIdentityReaderForTest(null);
  __setAsyncProcessStartTimeReaderForTest(null);
  vi.useRealTimers();
});

describe("getPublishedProcessIdentityVerdict", () => {
  it("reports current for a live PID whose recorded identity still matches", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "alive");
    __setAsyncProcessStartIdentityReaderForTest(async () => SAME_IDENTITY);

    await expect(
      getPublishedProcessIdentityVerdict(1234, PUBLISHED_IDENTITY),
    ).resolves.toBe("current");
  });

  it("reports dead as positive evidence even when no identity can be read", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "dead");
    __setAsyncProcessStartIdentityReaderForTest(async () => null);

    await expect(
      getPublishedProcessIdentityVerdict(999_999, PUBLISHED_IDENTITY),
    ).resolves.toBe("dead");
  });

  it("reports dead before considering a missing recorded identity", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "dead");

    await expect(
      getPublishedProcessIdentityVerdict(999_999, null),
    ).resolves.toBe("dead");
  });

  it("reports mismatch for a live recycled PID whose identity positively differs", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "alive");
    __setAsyncProcessStartIdentityReaderForTest(async () => OTHER_IDENTITY);

    await expect(
      getPublishedProcessIdentityVerdict(1234, PUBLISHED_IDENTITY),
    ).resolves.toBe("mismatch");
  });

  it("keeps a failed liveness probe indeterminate instead of treating it as down", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "indeterminate");
    __setAsyncProcessStartIdentityReaderForTest(async () => null);

    await expect(
      getPublishedProcessIdentityVerdict(1234, PUBLISHED_IDENTITY),
    ).resolves.toBe("indeterminate");
  });

  /*
   * traycerai/traycer#740. A pid.json written by a host that predates
   * `processStartIdentity` gives this function nothing to compare. The old
   * code fell back to a wall-clock causality check and could answer
   * "mismatch"; both consumers read that as positive evidence - the liveness
   * gate turned it into "dead" and dropped the never-kill shield, and the
   * reachability predicate turned it into "unreachable" for a host that had
   * just completed a handshake. There is no fallback now: no operands means
   * no answer.
   */
  it("stays indeterminate for a legacy pid.json rather than inventing a mismatch", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "alive");
    __setAsyncProcessStartIdentityReaderForTest(async () => SAME_IDENTITY);

    await expect(getPublishedProcessIdentityVerdict(1234, null)).resolves.toBe(
      "indeterminate",
    );
  });

  it("stays indeterminate when the platform probe cannot read an identity", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "alive");
    __setAsyncProcessStartIdentityReaderForTest(async () => null);

    await expect(
      getPublishedProcessIdentityVerdict(1234, PUBLISHED_IDENTITY),
    ).resolves.toBe("indeterminate");
  });

  it("refuses to compare tokens from different platforms instead of calling them different", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "alive");
    __setAsyncProcessStartIdentityReaderForTest(
      async () => "darwin:Sun Jul 27 15:04:05 2026",
    );

    await expect(
      getPublishedProcessIdentityVerdict(1234, PUBLISHED_IDENTITY),
    ).resolves.toBe("indeterminate");
  });
});

/*
 * `verifyProcessIdentity` backs lock breaking (`cross-process-lock`) and temp
 * sweeping (`owned-temp`), so a wrong "this holder is gone" lets two
 * processes into the same critical section. It used to compare two
 * wall-clock-derived start times with a 5s tolerance, which a `CLOCK_REALTIME`
 * step could push apart for a perfectly live holder.
 *
 * These two rows pin that the timestamp is no longer an input at all, and
 * they fail against the retired implementation in OPPOSITE directions: the
 * first would have read "dead" off the absurd `startedAtMs`, the second would
 * have read "alive-same" off the correct one. Neither can pass by accident.
 */
describe("verifyProcessIdentity reads the creation stamp, not the timestamp", () => {
  it("verifies a token whose startedAtMs is nonsense but whose stamp matches", () => {
    const identity = readProcessStartIdentity(process.pid);
    expect(identity).not.toBeNull();

    expect(
      verifyProcessIdentity({
        pid: process.pid,
        // Absurd on purpose: nine hours of skew, far outside any tolerance
        // the old comparison used.
        startedAtMs: Date.now() - 9 * 60 * 60 * 1000,
        startIdentity: identity,
      }),
    ).toBe("alive-same");
  });

  it("still rejects a token whose stamp differs even when startedAtMs is exact", () => {
    const identity = readProcessStartIdentity(process.pid);
    expect(identity).not.toBeNull();

    expect(
      verifyProcessIdentity({
        pid: process.pid,
        startedAtMs: readLiveProcessStartTimeMs(process.pid),
        // Same platform tag, positively not ours - a dead predecessor's token
        // surviving under a pid the OS recycled onto us.
        startIdentity: `${String(identity)} 0`,
      }),
    ).toBe("dead");
  });
});

/*
 * The property the whole mechanism rests on, exercised against the real OS
 * rather than a stub: the identity a reader observes for a given process must
 * not move when the wall clock does.
 *
 * The second assertion is the control. `readLiveProcessStartTimeMs` is the
 * derivation this replaced - `Date.now()` minus an elapsed time measured from
 * boot - and it shifts by the full size of the clock step, which is precisely
 * how a healthy WSL2 host came to look like a recycled pid. Keeping both in
 * one test means a future "simplification" of the identity reader back onto a
 * clock-anchored derivation cannot pass.
 */
describe("start identity survives a wall-clock step", () => {
  const CLOCK_STEP_MS = 6 * 60 * 60 * 1000;

  it("reads identical bytes before and after the clock jumps, where the timestamp reader does not", () => {
    const identityBefore = readProcessStartIdentity(process.pid);
    const derivedBefore = readLiveProcessStartTimeMs(process.pid);
    expect(identityBefore).not.toBeNull();
    expect(derivedBefore).not.toBeNull();

    // `shouldAdvanceTime` keeps the child-process probes' own timeouts live;
    // only the observed wall clock moves.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.now() + CLOCK_STEP_MS));

    expect(readProcessStartIdentity(process.pid)).toBe(identityBefore);

    const derivedAfter = readLiveProcessStartTimeMs(process.pid);
    expect(derivedAfter).not.toBeNull();
    if (derivedBefore === null || derivedAfter === null) return;
    expect(derivedAfter - derivedBefore).toBeGreaterThan(CLOCK_STEP_MS / 2);
  });
});
