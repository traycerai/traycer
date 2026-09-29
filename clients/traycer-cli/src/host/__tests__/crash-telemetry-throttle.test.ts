import { describe, expect, it, vi, type Mock } from "vitest";
import type { Environment } from "../../runner/environment";
import {
  buildHostCrashEvent,
  HOST_CRASH_REPORTS_BEFORE_THROTTLE,
  HOST_CRASH_SUMMARY_WINDOW_MS,
  HostCrashReportThrottle,
  type HostCrashEvent,
  type HostCrashTelemetry,
} from "../crash-telemetry";

const TEST_ENVIRONMENT: Environment = "production";

function sampleTelemetry(
  overrides: Partial<HostCrashTelemetry>,
): HostCrashTelemetry {
  return {
    environment: TEST_ENVIRONMENT,
    attemptId: "attempt-1",
    supervisorPid: 4242,
    childPid: 4242,
    hostVersion: "1.2.3",
    exitCode: 7,
    signal: null,
    exitMeaning: "some crash meaning",
    hasDiagnosticReport: true,
    uptimeMs: 1500,
    ...overrides,
  };
}

// Two distinct "kinds": crashKindToken prefers the signal, then falls back to
// the exit code, so a different exit code (with no signal) is a different
// token and therefore a different fingerprint - exactly the (platform, kind)
// key the throttle is documented to key its budget by.
function kindAEvent(attemptId: string): HostCrashEvent {
  return buildHostCrashEvent(
    sampleTelemetry({ exitCode: 7, signal: null, attemptId }),
    null,
  );
}

function kindBEvent(attemptId: string): HostCrashEvent {
  return buildHostCrashEvent(
    sampleTelemetry({ exitCode: 9, signal: null, attemptId }),
    null,
  );
}

interface ScheduledCall {
  readonly callback: () => void;
  readonly delayMs: number;
}

interface Harness {
  readonly throttle: HostCrashReportThrottle;
  readonly capture: Mock<(event: HostCrashEvent) => void>;
  readonly captureSummary: Mock<
    (
      event: HostCrashEvent,
      suppressedCount: number,
      windowStartedAt: number,
    ) => void
  >;
  readonly schedule: Mock<(callback: () => void, delayMs: number) => void>;
  readonly scheduled: ScheduledCall[];
  advance(deltaMs: number): void;
  now(): number;
}

function createHarness(): Harness {
  let currentTimeMs = 0;
  const scheduled: ScheduledCall[] = [];
  const capture = vi.fn<(event: HostCrashEvent) => void>();
  const captureSummary =
    vi.fn<
      (
        event: HostCrashEvent,
        suppressedCount: number,
        windowStartedAt: number,
      ) => void
    >();
  const schedule = vi.fn<(callback: () => void, delayMs: number) => void>(
    (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
    },
  );
  const throttle = new HostCrashReportThrottle({
    now: () => currentTimeMs,
    capture,
    captureSummary,
    schedule,
  });
  return {
    throttle,
    capture,
    captureSummary,
    schedule,
    scheduled,
    advance(deltaMs: number) {
      currentTimeMs += deltaMs;
    },
    now() {
      return currentTimeMs;
    },
  };
}

describe("HostCrashReportThrottle", () => {
  it("captures the first 3 crashes of a kind in full, holds the rest back, and schedules exactly one summary for the window", () => {
    const h = createHarness();

    // Crashes 1-3: full reports (HOST_CRASH_REPORTS_BEFORE_THROTTLE).
    for (let i = 1; i <= 3; i += 1) {
      h.advance(1_000);
      h.throttle.report(kindAEvent(`crash-${i}`));
    }
    expect(h.capture).toHaveBeenCalledTimes(HOST_CRASH_REPORTS_BEFORE_THROTTLE);
    expect(h.schedule).not.toHaveBeenCalled();

    // Crash 4 opens the window and is the first held-back crash.
    h.advance(1_000);
    h.throttle.report(kindAEvent("crash-4"));
    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(h.schedule.mock.calls[0][1]).toBe(HOST_CRASH_SUMMARY_WINDOW_MS);
    const windowStartedAt = h.now();

    // Crashes 5-10 (6 more) stay in the same window: no new schedule call.
    let lastEvent: HostCrashEvent = kindAEvent("crash-4");
    for (let i = 5; i <= 10; i += 1) {
      h.advance(1_000);
      lastEvent = kindAEvent(`crash-${i}`);
      h.throttle.report(lastEvent);
    }
    expect(h.capture).toHaveBeenCalledTimes(HOST_CRASH_REPORTS_BEFORE_THROTTLE);
    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(h.captureSummary).not.toHaveBeenCalled();

    // Firing the scheduled callback sends one summary: 7 held-back crashes
    // (4 through 10), the 7th (last) one as the carried event, and the
    // window's start time (crash 4's time).
    h.scheduled[0].callback();
    expect(h.captureSummary).toHaveBeenCalledTimes(1);
    const [summaryEvent, suppressedCount, summaryWindowStartedAt] =
      h.captureSummary.mock.calls[0];
    expect(summaryEvent).toBe(lastEvent);
    expect(suppressedCount).toBe(7);
    expect(summaryWindowStartedAt).toBe(windowStartedAt);
  });

  it("sends the summary at the window boundary with no further crash, and a second firing sends nothing", () => {
    const h = createHarness();
    for (let i = 1; i <= 3; i += 1) {
      h.advance(1_000);
      h.throttle.report(kindAEvent(`crash-${i}`));
    }
    h.advance(1_000);
    h.throttle.report(kindAEvent("crash-4"));
    expect(h.scheduled).toHaveLength(1);

    h.scheduled[0].callback();
    expect(h.captureSummary).toHaveBeenCalledTimes(1);

    // Firing again (stale re-invocation) sends nothing: the count was reset.
    h.scheduled[0].callback();
    expect(h.captureSummary).toHaveBeenCalledTimes(1);
  });

  it("restarts the counter for the same kind after a summary, scheduling and sending a fresh count", () => {
    const h = createHarness();
    for (let i = 1; i <= 3; i += 1) {
      h.advance(1_000);
      h.throttle.report(kindAEvent(`crash-${i}`));
    }
    h.advance(1_000);
    h.throttle.report(kindAEvent("crash-4"));
    h.scheduled[0].callback();
    expect(h.captureSummary).toHaveBeenCalledTimes(1);

    // 2 more kind-A crashes inside the next hour: still throttled (reported
    // is already at the budget), each held back.
    h.advance(30 * 60 * 1000);
    h.throttle.report(kindAEvent("crash-5"));
    h.advance(1_000);
    h.throttle.report(kindAEvent("crash-6"));

    expect(h.capture).toHaveBeenCalledTimes(HOST_CRASH_REPORTS_BEFORE_THROTTLE);
    expect(h.schedule).toHaveBeenCalledTimes(2);

    h.scheduled[1].callback();
    expect(h.captureSummary).toHaveBeenCalledTimes(2);
    const [, suppressedCount] = h.captureSummary.mock.calls[1];
    expect(suppressedCount).toBe(2);
  });

  it("propagates a capture throw on the first crash without recording it, and still grants a full budget of 3 successes afterward", () => {
    const h = createHarness();
    h.capture.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });

    expect(() => h.throttle.report(kindAEvent("crash-1"))).toThrow(
      "capture failed",
    );
    // The failed attempt recorded no state: the next crash is captured again
    // as if it were the first.
    for (let i = 2; i <= 5; i += 1) {
      h.advance(1_000);
      h.throttle.report(kindAEvent(`crash-${i}`));
    }

    // 1 failing call + 3 successful captures (crashes 2-4) = 4 capture calls;
    // crash 5 is the first held back (budget of 3 successes was granted from
    // crash 2 onward).
    expect(h.capture).toHaveBeenCalledTimes(4);
    expect(h.schedule).toHaveBeenCalledTimes(1);
  });

  it("swallows a captureSummary throw, keeps the count, and carries it into the next window", () => {
    const h = createHarness();
    for (let i = 1; i <= 3; i += 1) {
      h.advance(1_000);
      h.throttle.report(kindAEvent(`crash-${i}`));
    }
    h.advance(1_000);
    h.throttle.report(kindAEvent("crash-4"));
    h.advance(1_000);
    h.throttle.report(kindAEvent("crash-5"));
    expect(h.scheduled).toHaveLength(1);

    h.captureSummary.mockImplementationOnce(() => {
      throw new Error("summary failed");
    });
    expect(() => h.scheduled[0].callback()).not.toThrow();
    expect(h.captureSummary).toHaveBeenCalledTimes(1);

    // Next held-back crash schedules a new window; firing it sends the old
    // count plus the new one.
    h.advance(1_000);
    h.throttle.report(kindAEvent("crash-6"));
    expect(h.schedule).toHaveBeenCalledTimes(2);

    h.scheduled[1].callback();
    expect(h.captureSummary).toHaveBeenCalledTimes(2);
    const [, suppressedCount] = h.captureSummary.mock.calls[1];
    // crashes 4, 5 (kept after the failed summary) + crash 6 = 3.
    expect(suppressedCount).toBe(3);
  });

  it("reports in full again after a whole window of quiet, but a crash just under the window is still held back", () => {
    const h = createHarness();
    for (let i = 1; i <= 3; i += 1) {
      h.advance(1_000);
      h.throttle.report(kindAEvent(`crash-${i}`));
    }
    h.advance(1_000);
    h.throttle.report(kindAEvent("crash-4"));
    h.scheduled[0].callback();
    expect(h.captureSummary).toHaveBeenCalledTimes(1);
    expect(h.capture).toHaveBeenCalledTimes(HOST_CRASH_REPORTS_BEFORE_THROTTLE);

    // A crash 59 minutes after the last one (crash 4) is still within the
    // window and is held back, not reported in full.
    h.advance(59 * 60 * 1000);
    h.throttle.report(kindAEvent("crash-5"));
    expect(h.capture).toHaveBeenCalledTimes(HOST_CRASH_REPORTS_BEFORE_THROTTLE);
    expect(h.schedule).toHaveBeenCalledTimes(2);

    h.scheduled[1].callback();
    expect(h.captureSummary).toHaveBeenCalledTimes(2);

    // Now a whole window (>= HOST_CRASH_SUMMARY_WINDOW_MS) passes quiet since
    // crash 5, with the count at zero and no summary scheduled: the next
    // crash gets a fresh full budget.
    h.advance(HOST_CRASH_SUMMARY_WINDOW_MS);
    h.throttle.report(kindAEvent("crash-6"));
    expect(h.capture).toHaveBeenCalledTimes(
      HOST_CRASH_REPORTS_BEFORE_THROTTLE + 1,
    );
  });

  it("gives two different kinds independent budgets and schedules", () => {
    const h = createHarness();
    for (let i = 1; i <= HOST_CRASH_REPORTS_BEFORE_THROTTLE; i += 1) {
      h.advance(1_000);
      h.throttle.report(kindAEvent(`a-crash-${i}`));
    }
    h.advance(1_000);
    h.throttle.report(kindAEvent("a-crash-4"));
    expect(h.schedule).toHaveBeenCalledTimes(1);

    for (let i = 1; i <= HOST_CRASH_REPORTS_BEFORE_THROTTLE; i += 1) {
      h.advance(1_000);
      h.throttle.report(kindBEvent(`b-crash-${i}`));
    }
    h.advance(1_000);
    h.throttle.report(kindBEvent("b-crash-4"));

    expect(h.capture).toHaveBeenCalledTimes(
      HOST_CRASH_REPORTS_BEFORE_THROTTLE * 2,
    );
    expect(h.schedule).toHaveBeenCalledTimes(2);

    const kindBCalls = h.capture.mock.calls.slice(
      -HOST_CRASH_REPORTS_BEFORE_THROTTLE,
    );
    for (const call of kindBCalls) {
      const [reportedEvent] = call;
      expect(reportedEvent.fingerprint).toEqual(kindBEvent("b").fingerprint);
    }

    // Firing kind A's summary does not touch kind B's budget or schedule.
    h.scheduled[0].callback();
    expect(h.captureSummary).toHaveBeenCalledTimes(1);
    expect(h.schedule).toHaveBeenCalledTimes(2);
  });
});
