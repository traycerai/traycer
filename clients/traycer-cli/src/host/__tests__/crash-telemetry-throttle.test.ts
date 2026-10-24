import { describe, expect, it, vi, type Mock } from "vitest";
import type { Environment } from "../../runner/environment";
import {
  buildHostCrashEvent,
  HOST_CRASH_REPORTS_BEFORE_THROTTLE,
  HOST_CRASH_SUMMARY_WINDOW_MS,
  HostCrashReportThrottle,
  parsePersistedHostCrashThrottle,
  serializeHostCrashThrottle,
  type HostCrashEvent,
  type PersistedHostCrashKind,
  type PersistedHostCrashThrottle,
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
    stopRequested: false,
    stderrEmpty: false,
    stderrFatal: "other",
    reportMemory: { heapLimitBytes: null, heapUsedBytes: null, rssBytes: null },
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
  readonly persist: Mock<(state: PersistedHostCrashThrottle) => void>;
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
  const persist = vi.fn<(state: PersistedHostCrashThrottle) => void>();
  const throttle = new HostCrashReportThrottle({
    now: () => currentTimeMs,
    capture,
    captureSummary,
    schedule,
    persist,
  });
  return {
    throttle,
    persist,
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

describe("HostCrashReportThrottle across processes", () => {
  // The state an earlier supervisor left after 3 full reports and 2 held back.
  function leftBehind(at: number): Map<string, PersistedHostCrashKind> {
    const first = createHarness();
    first.advance(at);
    for (let i = 1; i <= 5; i += 1) {
      first.advance(1_000);
      first.throttle.report(kindAEvent(`crash-${i}`));
    }
    return parsePersistedHostCrashThrottle(
      serializeHostCrashThrottle(first.throttle.snapshot()),
    );
  }

  it("carries the spent budget into a new process", () => {
    const persisted = leftBehind(0);
    const next = createHarness();
    next.advance(10_000);
    next.throttle.restore(persisted);
    next.throttle.report(kindAEvent("later"));
    expect(next.capture).not.toHaveBeenCalled();
  });

  it("schedules the open count for the rest of its window, then sends it once", () => {
    const persisted = leftBehind(0);
    const next = createHarness();
    next.advance(10_000);
    next.throttle.restore(persisted);
    expect(next.captureSummary).not.toHaveBeenCalled();
    expect(next.scheduled).toHaveLength(1);
    // Window opened at 4_000 (the first held-back crash).
    expect(next.scheduled[0].delayMs).toBe(
      4_000 + HOST_CRASH_SUMMARY_WINDOW_MS - 10_000,
    );
    next.scheduled[0].callback();
    expect(next.captureSummary).toHaveBeenCalledTimes(1);
    expect(next.captureSummary.mock.calls[0][1]).toBe(2);
    next.scheduled[0].callback();
    expect(next.captureSummary).toHaveBeenCalledTimes(1);
  });

  it("sends an overdue count at once, and then reports the kind in full again", () => {
    const persisted = leftBehind(0);
    const next = createHarness();
    next.advance(3 * HOST_CRASH_SUMMARY_WINDOW_MS);
    next.throttle.restore(persisted);
    expect(next.captureSummary).toHaveBeenCalledTimes(1);
    expect(next.captureSummary.mock.calls[0][1]).toBe(2);
    next.throttle.report(kindAEvent("fresh"));
    expect(next.capture).toHaveBeenCalledTimes(1);
  });

  it("does not let a clock that stepped back mute a kind", () => {
    const persisted = leftBehind(10 * HOST_CRASH_SUMMARY_WINDOW_MS);
    const next = createHarness();
    next.throttle.restore(persisted);
    // Its window opened "in the future": it is sent when one window from now ends.
    expect(next.scheduled).toHaveLength(1);
    expect(next.scheduled[0].delayMs).toBe(HOST_CRASH_SUMMARY_WINDOW_MS);
  });

  it("writes the clamped times back, so the next process counts from them too", () => {
    const persisted = leftBehind(10 * HOST_CRASH_SUMMARY_WINDOW_MS);
    const next = createHarness();
    next.throttle.restore(persisted);
    expect(next.persist).toHaveBeenCalledTimes(1);
    const written = [...next.persist.mock.calls[0][0].values()][0];
    expect(written.lastCrashAt).toBeLessThanOrEqual(next.now());
    expect(written.windowStartedAt).toBeLessThanOrEqual(next.now());
    expect(written.suppressedCount).toBe(2);
  });

  it("writes nothing back for a state that needed no clamping", () => {
    const persisted = leftBehind(0);
    const next = createHarness();
    next.advance(10_000);
    next.throttle.restore(persisted);
    expect(next.persist).not.toHaveBeenCalled();
  });

  it("keeps its own state for a kind it has seen more recently", () => {
    const next = createHarness();
    next.advance(5_000);
    for (let i = 0; i < 3; i += 1) next.throttle.report(kindAEvent("own"));
    next.advance(5_000);
    next.throttle.report(kindAEvent("own-4"));
    const before = next.throttle.snapshot();
    next.throttle.restore(leftBehind(0));
    expect(next.throttle.snapshot()).toEqual(before);
  });

  it("persists after a capture, a held-back crash and a sent summary, but not after a failed capture", () => {
    const h = createHarness();
    h.capture.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });
    expect(() => h.throttle.report(kindAEvent("a"))).toThrow();
    expect(h.persist).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i += 1) h.throttle.report(kindAEvent(`c-${i}`));
    expect(h.persist).toHaveBeenCalledTimes(4);
    h.scheduled[0].callback();
    expect(h.persist).toHaveBeenCalledTimes(5);
    const last = h.persist.mock.calls[4][0];
    expect([...last.values()][0].suppressedCount).toBe(0);
  });

  it("carries on when persisting throws", () => {
    const h = createHarness();
    h.persist.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => h.throttle.report(kindAEvent("a"))).not.toThrow();
    expect(h.capture).toHaveBeenCalledTimes(1);
  });
});

describe("HostCrashReportThrottle.snapshot", () => {
  function kindEvent(exitCode: number): HostCrashEvent {
    return buildHostCrashEvent(
      sampleTelemetry({ exitCode, signal: null }),
      null,
    );
  }

  it("leaves out a kind that has been quiet for a whole window, and keeps one with a count open", () => {
    const h = createHarness();
    h.throttle.report(kindEvent(1));
    for (let i = 0; i < 4; i += 1) h.throttle.report(kindEvent(2));
    h.advance(HOST_CRASH_SUMMARY_WINDOW_MS - 1);
    expect(h.throttle.snapshot().size).toBe(2);
    h.advance(1);
    // Kind 1 is quiet; kind 2 still has an unsent count.
    const kept = [...h.throttle.snapshot().values()];
    expect(kept).toHaveLength(1);
    expect(kept[0].suppressedCount).toBe(1);
  });

  it("keeps the most recently crashed kinds when there are more than it will write", () => {
    const h = createHarness();
    for (let code = 1; code <= 40; code += 1) {
      h.advance(1_000);
      h.throttle.report(kindEvent(code));
    }
    const kept = h.throttle.snapshot();
    expect(kept.size).toBe(32);
    const newest = kindEvent(40).fingerprint.join("|");
    const oldest = kindEvent(1).fingerprint.join("|");
    expect(kept.has(newest)).toBe(true);
    expect(kept.has(oldest)).toBe(false);
  });
});

describe("parsePersistedHostCrashThrottle", () => {
  const kind = {
    reported: 3,
    lastCrashAt: 10,
    suppressedCount: 0,
    windowStartedAt: 5,
    lastSuppressed: null,
  };

  it("round-trips what the throttle writes", () => {
    const h = createHarness();
    for (let i = 0; i < 5; i += 1) h.throttle.report(kindAEvent(`c-${i}`));
    const parsed = parsePersistedHostCrashThrottle(
      serializeHostCrashThrottle(h.throttle.snapshot()),
    );
    expect(parsed).toEqual(h.throttle.snapshot());
  });

  it("cuts a tag longer than the cap instead of dropping the kind", () => {
    const longVersion = "local-" + "x".repeat(600);
    const parsed = parsePersistedHostCrashThrottle(
      JSON.stringify({
        version: 1,
        kinds: {
          k: {
            ...kind,
            suppressedCount: 2,
            lastSuppressed: {
              message: "Host crashed: 1",
              level: "error",
              fingerprint: ["host-crash", "linux", "1"],
              hostId: null,
              tags: { host_version: longVersion },
            },
          },
        },
      }),
    );
    const held = parsed.get("k")?.lastSuppressed;
    expect(parsed.get("k")?.suppressedCount).toBe(2);
    expect(held?.tags.host_version).toBe(longVersion.slice(0, 256));
  });

  it.each([
    ["empty", ""],
    ["torn", '{"version":1,"kinds":{"a|b":{"reported":3'],
    ["not an object", "[1,2]"],
    ["other version", JSON.stringify({ version: 2, kinds: { k: kind } })],
    ["kinds an array", JSON.stringify({ version: 1, kinds: [kind] })],
    ["oversized", " ".repeat(300 * 1024)],
  ])("reads %s as no state", (_name, text) => {
    expect(parsePersistedHostCrashThrottle(text).size).toBe(0);
  });

  it("drops only the kinds that are malformed", () => {
    const parsed = parsePersistedHostCrashThrottle(
      JSON.stringify({
        version: 1,
        kinds: {
          good: kind,
          negative: { ...kind, reported: -1 },
          fractional: { ...kind, suppressedCount: 1.5 },
          text: { ...kind, lastCrashAt: "10" },
          countWithoutEvent: { ...kind, suppressedCount: 2 },
          badEvent: {
            ...kind,
            suppressedCount: 2,
            lastSuppressed: { message: 1 },
          },
        },
      }),
    );
    expect([...parsed.keys()]).toEqual(["good"]);
  });
});
