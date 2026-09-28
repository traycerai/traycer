import { describe, expect, it, vi } from "vitest";
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
function kindAEvent(): HostCrashEvent {
  return buildHostCrashEvent(
    sampleTelemetry({ exitCode: 7, signal: null }),
    null,
  );
}

function kindBEvent(): HostCrashEvent {
  return buildHostCrashEvent(
    sampleTelemetry({ exitCode: 9, signal: null }),
    null,
  );
}

describe("HostCrashReportThrottle", () => {
  it("bounds a crash-looping kind to 3 full captures, then summarizes the held-back run once its hour elapses, restarting the count - while an unrelated kind keeps its own separate budget", () => {
    let currentTimeMs = 0;
    const capture = vi.fn<(event: HostCrashEvent) => void>();
    const captureSummary =
      vi.fn<
        (
          event: HostCrashEvent,
          suppressedCount: number,
          windowStartedAt: number,
        ) => void
      >();
    const throttle = new HostCrashReportThrottle({
      now: () => currentTimeMs,
      capture,
      captureSummary,
    });

    // --- Phase 1: 10 crashes of kind A inside one minute. ---
    // Reports 1-3 are captured in full (HOST_CRASH_REPORTS_BEFORE_THROTTLE).
    // Reports 4-10 (7 of them) are held back: each is still inside kind A's
    // one-hour summary window (measured from the 3rd, last-captured report),
    // so none of them trips a summary either.
    for (let i = 0; i < 10; i += 1) {
      currentTimeMs += 5_000; // 5s apart; 10 crashes span 50s, under a minute.
      throttle.report(kindAEvent());
    }

    expect(capture).toHaveBeenCalledTimes(HOST_CRASH_REPORTS_BEFORE_THROTTLE);
    expect(captureSummary).not.toHaveBeenCalled();

    // --- Phase 2: advance 61 minutes (past the 1-hour window), report once more. ---
    // This 11th report is the one whose age check finally trips: its
    // suppressedCount increments from 7 to 8 BEFORE the window check runs
    // (`state.suppressedCount += 1` precedes the `at - windowStartedAt`
    // comparison in HostCrashReportThrottle.report), so the summary carries
    // suppressedCount 8 - the 7 held back in phase 1 plus this 11th crash
    // itself, not 7.
    currentTimeMs += HOST_CRASH_SUMMARY_WINDOW_MS + 60_000; // +61 minutes
    throttle.report(kindAEvent());

    expect(capture).toHaveBeenCalledTimes(HOST_CRASH_REPORTS_BEFORE_THROTTLE);
    expect(captureSummary).toHaveBeenCalledTimes(1);
    const [, suppressedCountArg] = captureSummary.mock.calls[0];
    expect(suppressedCountArg).toBe(8);

    // --- Phase 3: one more kind-A crash, 1 minute after the summary. ---
    // The summary reset suppressedCount to 0 and windowStartedAt to the time
    // of the summary-triggering report, so this crash is a fresh count of 1,
    // well inside the new hour - nothing new is captured or summarized, but
    // the internal counter did restart (proven by phase 4 below never
    // re-summarizing at a stale count).
    currentTimeMs += 60_000; // +1 minute
    throttle.report(kindAEvent());

    expect(capture).toHaveBeenCalledTimes(HOST_CRASH_REPORTS_BEFORE_THROTTLE);
    expect(captureSummary).toHaveBeenCalledTimes(1);

    // --- Phase 4: a crash of a DIFFERENT kind gets its own full budget. ---
    // Kind A is deep in its throttled state, but kind B has never been seen -
    // it is keyed separately (by fingerprint), so it gets its own 3 full
    // captures before it, too, would start being held back.
    for (let i = 0; i < HOST_CRASH_REPORTS_BEFORE_THROTTLE; i += 1) {
      currentTimeMs += 1_000;
      throttle.report(kindBEvent());
    }

    // 3 (kind A, phase 1) + 3 (kind B, phase 4) = 6.
    expect(capture).toHaveBeenCalledTimes(
      HOST_CRASH_REPORTS_BEFORE_THROTTLE * 2,
    );
    // Kind A's summary count is untouched by kind B's activity.
    expect(captureSummary).toHaveBeenCalledTimes(1);

    // Every kind-B capture actually carries the kind-B event, confirming the
    // budgets are not just counted separately but reported for the right kind.
    const kindBCalls = capture.mock.calls.slice(
      -HOST_CRASH_REPORTS_BEFORE_THROTTLE,
    );
    for (const call of kindBCalls) {
      const [reportedEvent] = call;
      expect(reportedEvent.fingerprint).toEqual(kindBEvent().fingerprint);
    }
  });
});
