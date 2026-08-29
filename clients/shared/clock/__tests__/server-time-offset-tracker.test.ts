import { describe, expect, it } from "vitest";
import {
  clockSkewStreamReason,
  describeClockOffset,
  DEFAULT_SKEW_ENTER_MS,
  DEFAULT_SKEW_EXIT_MS,
  ServerTimeOffsetTracker,
  type ServerClockState,
} from "../server-time-offset-tracker";

/**
 * A scriptable pair of clocks. `wallMs` is the machine clock under suspicion
 * (the one a user can set); `monotonicMs` is the reference that only elapses.
 * Advancing them independently is exactly what a clock being SET looks like.
 */
class FakeClocks {
  wallMs = 1_700_000_000_000;
  monotonicMs = 0;

  /** Time passing normally: both advance together. */
  elapse(ms: number): void {
    this.wallMs += ms;
    this.monotonicMs += ms;
  }

  /** Somebody sets the wall clock: only it moves. */
  setWallBy(ms: number): void {
    this.wallMs += ms;
  }
}

function makeTracker(clocks: FakeClocks): ServerTimeOffsetTracker {
  return new ServerTimeOffsetTracker({
    nowMs: () => clocks.wallMs,
    monotonicNowMs: () => clocks.monotonicMs,
    enterSkewMs: DEFAULT_SKEW_ENTER_MS,
    exitSkewMs: DEFAULT_SKEW_EXIT_MS,
  });
}

/** A JWT with the given `iat`, unsigned - the tracker never verifies one. */
function tokenWithIat(iatSeconds: number): string {
  const encode = (value: object): string =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode({ iat: iatSeconds })}.sig`;
}

const SEVEN_HOURS_MS = 7 * 3_600_000;

describe("ServerTimeOffsetTracker classification", () => {
  it("starts `unknown` so nothing reads absence of a sample as a healthy clock", () => {
    const tracker = makeTracker(new FakeClocks());
    expect(tracker.currentState()).toEqual({
      verdict: "unknown",
      offsetMs: null,
    });
    expect(tracker.isSkewed()).toBe(false);
  });

  it("stays `ok` for offsets inside the enter threshold", () => {
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    // A minute off is NTP-jitter territory and tolerated by a 15-minute token.
    tracker.recordServerTimeMs(clocks.wallMs + 60_000, clocks.wallMs);
    expect(tracker.currentState().verdict).toBe("ok");
  });

  it("declares `skewed` with the signed offset when the clock is hours ahead", () => {
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    // The incident: local clock 7h AHEAD, so server − local is negative.
    tracker.recordServerTimeMs(clocks.wallMs - SEVEN_HOURS_MS, clocks.wallMs);
    expect(tracker.currentState()).toEqual({
      verdict: "skewed",
      offsetMs: -SEVEN_HOURS_MS,
    });
    expect(tracker.isSkewed()).toBe(true);
  });

  it("reads the HTTP `Date` header, and ignores an absent or unparseable one", () => {
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    tracker.recordServerDateHeader(null);
    tracker.recordServerDateHeader("not-a-date");
    expect(tracker.currentState().verdict).toBe("unknown");

    tracker.recordServerDateHeader(
      new Date(clocks.wallMs - SEVEN_HOURS_MS).toUTCString(),
    );
    expect(tracker.currentState().verdict).toBe("skewed");
    // Header granularity is one second; the assertion allows for it rather
    // than pretending the sample is exact.
    expect(
      Math.abs((tracker.currentState().offsetMs ?? 0) + SEVEN_HOURS_MS),
    ).toBeLessThan(1_000);
  });

  it("reads `iat` off a freshly issued token, and ignores a non-JWT", () => {
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    tracker.recordFreshlyIssuedToken("opaque-not-a-jwt");
    expect(tracker.currentState().verdict).toBe("unknown");

    tracker.recordFreshlyIssuedToken(
      tokenWithIat(Math.floor((clocks.wallMs - SEVEN_HOURS_MS) / 1000)),
    );
    expect(tracker.currentState().verdict).toBe("skewed");
  });
});

describe("ServerTimeOffsetTracker hysteresis", () => {
  it("holds `skewed` between the exit and enter thresholds", () => {
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    tracker.recordServerTimeMs(clocks.wallMs - SEVEN_HOURS_MS, clocks.wallMs);
    expect(tracker.currentState().verdict).toBe("skewed");

    // 3 minutes: under the 5-minute ENTER bound but over the 2-minute EXIT
    // bound. A tracker without hysteresis would call this `ok` and unpark
    // every session, only to re-park on the next sample.
    tracker.recordServerTimeMs(clocks.wallMs - 180_000, clocks.wallMs);
    expect(tracker.currentState().verdict).toBe("skewed");

    tracker.recordServerTimeMs(clocks.wallMs - 60_000, clocks.wallMs);
    expect(tracker.currentState().verdict).toBe("ok");
  });

  it("fires the recovery edge only on `skewed → ok`", () => {
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    let recoveries = 0;
    tracker.subscribeToRecovery(() => {
      recoveries += 1;
    });

    tracker.recordServerTimeMs(clocks.wallMs + 1_000, clocks.wallMs);
    expect(recoveries).toBe(0); // `unknown → ok` is not a recovery.

    tracker.recordServerTimeMs(clocks.wallMs - SEVEN_HOURS_MS, clocks.wallMs);
    tracker.recordServerTimeMs(
      clocks.wallMs - SEVEN_HOURS_MS + 1,
      clocks.wallMs,
    );
    expect(recoveries).toBe(0); // still skewed, magnitude changed only.

    tracker.recordServerTimeMs(clocks.wallMs, clocks.wallMs);
    expect(recoveries).toBe(1);
  });

  it("publishes state changes to subscribers and stops after unsubscribe", () => {
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    const seen: ServerClockState[] = [];
    const unsubscribe = tracker.subscribe((state) => {
      seen.push(state);
    });
    tracker.recordServerTimeMs(clocks.wallMs - SEVEN_HOURS_MS, clocks.wallMs);
    unsubscribe();
    tracker.recordServerTimeMs(clocks.wallMs, clocks.wallMs);
    expect(seen).toEqual([{ verdict: "skewed", offsetMs: -SEVEN_HOURS_MS }]);
  });
});

describe("ServerTimeOffsetTracker wall-clock divergence", () => {
  it("recovers immediately when a skewed clock is corrected, with no new sample", () => {
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    let recoveries = 0;
    tracker.subscribeToRecovery(() => {
      recoveries += 1;
    });
    tracker.recordServerTimeMs(clocks.wallMs - SEVEN_HOURS_MS, clocks.wallMs);
    tracker.noteWallClockTick();

    // The user sets the clock back 7h; monotonic time barely moved.
    clocks.elapse(10_000);
    clocks.setWallBy(-SEVEN_HOURS_MS);
    tracker.noteWallClockTick();

    expect(tracker.currentState().verdict).toBe("ok");
    expect(recoveries).toBe(1);
  });

  it("never CREATES a skew verdict from a jump - it only invalidates a stale sample", () => {
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    tracker.recordServerTimeMs(clocks.wallMs, clocks.wallMs);
    expect(tracker.currentState().verdict).toBe("ok");
    tracker.noteWallClockTick();

    // A suspend/resume can diverge wall and monotonic with no clock change at
    // all. Reading that as "skewed" would fabricate the diagnosis the banner
    // and the park state both act on.
    clocks.elapse(10_000);
    clocks.setWallBy(SEVEN_HOURS_MS);
    tracker.noteWallClockTick();

    expect(tracker.currentState()).toEqual({
      verdict: "unknown",
      offsetMs: null,
    });
  });

  it("ignores ordinary elapsed time and sub-threshold jitter", () => {
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    tracker.recordServerTimeMs(clocks.wallMs - SEVEN_HOURS_MS, clocks.wallMs);
    tracker.noteWallClockTick();

    clocks.elapse(600_000);
    tracker.noteWallClockTick();
    clocks.elapse(10_000);
    clocks.setWallBy(5_000); // an NTP nudge, not a correction
    tracker.noteWallClockTick();

    expect(tracker.currentState().verdict).toBe("skewed");
  });

  it("cannot detect wrong-from-boot skew, which is why it is not the detector", () => {
    // This incident's clock was already 7h off at process start and never
    // jumped in-process. With no server sample, ticking forever proves nothing.
    const clocks = new FakeClocks();
    const tracker = makeTracker(clocks);
    for (let tick = 0; tick < 10; tick += 1) {
      clocks.elapse(10_000);
      tracker.noteWallClockTick();
    }
    expect(tracker.currentState().verdict).toBe("unknown");
  });
});

describe("clock copy", () => {
  it("names magnitude and direction, with `ahead` for a fast local clock", () => {
    expect(describeClockOffset(-SEVEN_HOURS_MS)).toBe("~7h ahead");
    expect(describeClockOffset(SEVEN_HOURS_MS)).toBe("~7h behind");
    expect(describeClockOffset(-9 * 60_000)).toBe("~9m ahead");
    expect(describeClockOffset(-50 * 3_600_000)).toBe("~2.1d ahead");
  });

  it("builds a stream reason that blames the clock, not the credential", () => {
    const reason = clockSkewStreamReason({
      verdict: "skewed",
      offsetMs: -SEVEN_HOURS_MS,
    });
    expect(reason).toContain("System clock is wrong");
    expect(reason).toContain("~7h ahead");
    expect(reason).not.toContain("suspension");
  });
});
