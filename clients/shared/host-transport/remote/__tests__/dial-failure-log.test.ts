/**
 * `DialFailureLog` exists between two failure modes, and both are real bugs
 * that shipped: logging every attempt of a forever-retrying loop (~120
 * lines/hour of the same line), and logging nothing at all (the staging
 * desktop dialed a relay hostname with no DNS record for weeks and wrote not
 * one diagnostic line). These tests pin both edges, plus the recovery line.
 * Mirrors the host-side `UplinkFailureLog` suite - the two halves of the
 * tunnel log under the same contract.
 */
import { describe, expect, it } from "vitest";
import { DialFailureLog } from "../dial-failure-log";

interface Captured {
  readonly warns: string[];
  readonly infos: string[];
}

/** A hand-cranked clock, so "5 minutes later" costs no wall time. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

const REPEAT_MS = 5 * 60 * 1000;

function build(): {
  log: DialFailureLog;
  captured: Captured;
  advance: (ms: number) => void;
} {
  const warns: string[] = [];
  const infos: string[] = [];
  const time = clock();
  return {
    captured: { warns, infos },
    advance: time.advance,
    log: new DialFailureLog({
      label: "remote session (host h-1)",
      now: time.now,
      repeatIntervalMs: REPEAT_MS,
      warn: (message) => warns.push(message),
      info: (message) => infos.push(message),
    }),
  };
}

describe("DialFailureLog", () => {
  it("logs the first failure with its cause and retry delay", () => {
    const { log, captured } = build();
    log.recordFailure({
      cause: "could not mint an attach grant: authn answered HTTP 500",
      context: "",
      retryInMs: 1000,
    });
    expect(captured.warns).toHaveLength(1);
    expect(captured.warns[0]).toContain("remote session (host h-1) is down");
    expect(captured.warns[0]).toContain("authn answered HTTP 500");
    expect(captured.warns[0]).toContain("retrying in 1000ms");
  });

  it("suppresses an unchanged cause instead of writing a line per attempt", () => {
    const { log, captured, advance } = build();
    for (let i = 0; i < 60; i += 1) {
      log.recordFailure({
        cause: "the relay socket closed (code=1006)",
        context: "",
        retryInMs: 30_000,
      });
      advance(30_000); // the settled reconnect cadence: 30 minutes of outage
    }
    // 30 minutes at the repeat interval is the first line plus ~5
    // restatements, NOT 60 lines.
    expect(captured.warns.length).toBeLessThanOrEqual(7);
    expect(captured.warns.length).toBeGreaterThan(1);
  });

  it("re-states an unchanged cause on the interval, so a mid-outage log tail still shows it", () => {
    const { log, captured, advance } = build();
    log.recordFailure({
      cause: "the relay socket closed (code=1006)",
      context: "",
      retryInMs: 30_000,
    });
    expect(captured.warns).toHaveLength(1);

    // Four attempts inside the window: silent.
    for (let i = 0; i < 4; i += 1) {
      advance(30_000);
      log.recordFailure({
        cause: "the relay socket closed (code=1006)",
        context: "",
        retryInMs: 30_000,
      });
    }
    expect(captured.warns).toHaveLength(1);

    // Crossing the interval re-states it, WITH the outage's shape.
    advance(REPEAT_MS);
    log.recordFailure({
      cause: "the relay socket closed (code=1006)",
      context: "",
      retryInMs: 30_000,
    });
    expect(captured.warns).toHaveLength(2);
    expect(captured.warns[1]).toContain(
      "still down after 6 consecutive failures",
    );
    expect(captured.warns[1]).toContain("the relay socket closed (code=1006)");
    expect(captured.warns[1]).toContain("4 identical failures not logged");
  });

  it("logs immediately when the cause changes - a new fault is news", () => {
    const { log, captured } = build();
    log.recordFailure({
      cause: "could not mint an attach grant: no user bearer available",
      context: "",
      retryInMs: 1000,
    });
    log.recordFailure({
      cause: "the relay socket closed (code=1006) before attach_ack",
      context: "",
      retryInMs: 2000,
    });
    expect(captured.warns).toHaveLength(2);
    expect(captured.warns[1]).toContain("before attach_ack");
  });

  it("prints context but never dedups on it, so a countdown cannot defeat the throttle", () => {
    const { log, captured } = build();
    log.recordFailure({
      cause: "mint failed",
      context: "grant expires in ~90s",
      retryInMs: 1000,
    });
    expect(captured.warns[0]).toContain("(grant expires in ~90s)");
    // Same cause, moving countdown: still one line.
    log.recordFailure({
      cause: "mint failed",
      context: "grant expires in ~85s",
      retryInMs: 1000,
    });
    log.recordFailure({
      cause: "mint failed",
      context: "grant expires in ~80s",
      retryInMs: 1000,
    });
    expect(captured.warns).toHaveLength(1);
  });

  it("reports recovery once, with the outage's length, then goes quiet", () => {
    const { log, captured, advance } = build();
    log.recordFailure({ cause: "mint failed", context: "", retryInMs: 1000 });
    advance(120_000);
    log.recordFailure({ cause: "mint failed", context: "", retryInMs: 30_000 });

    log.recordSuccess();
    expect(captured.infos).toHaveLength(1);
    expect(captured.infos[0]).toContain(
      "remote session (host h-1) recovered after 2 consecutive failures",
    );
    expect(captured.infos[0]).toContain("120s");

    // A healthy session never repeats it.
    log.recordSuccess();
    log.recordSuccess();
    expect(captured.infos).toHaveLength(1);
  });

  it("stays silent on a success that followed no failure - a clean first open logs nothing", () => {
    const { log, captured } = build();
    log.recordSuccess();
    expect(captured.infos).toHaveLength(0);
    expect(captured.warns).toHaveLength(0);
  });

  it("concludes a mid-outage teardown with one 'closed while down' line, so the tail's silence cannot read as recovery", () => {
    const { log, captured, advance } = build();
    log.recordFailure({ cause: "mint failed", context: "", retryInMs: 1000 });
    advance(90_000);
    log.recordFailure({ cause: "mint failed", context: "", retryInMs: 30_000 });

    // The cache retired the session (linger expiry / supersession) while the
    // loop was still failing: without a terminal line the tail reads
    // "...retrying in 30000ms" then nothing - the log's own failure mode 2.
    log.recordAbandoned();
    expect(captured.warns).toHaveLength(2);
    expect(captured.warns[1]).toContain(
      "closed while still down after 2 consecutive failures",
    );
    expect(captured.warns[1]).toContain("90s");
    expect(captured.warns[1]).toContain("the retry loop has ended");

    // One line, and a healthy close logs nothing at all.
    log.recordAbandoned();
    expect(captured.warns).toHaveLength(2);
  });

  it("stays silent on an abandonment that followed no failure - closing a healthy session logs nothing", () => {
    const { log, captured } = build();
    log.recordAbandoned();
    expect(captured.warns).toHaveLength(0);
    expect(captured.infos).toHaveLength(0);
  });

  it("treats a post-recovery failure as fresh news, not a continuation", () => {
    const { log, captured } = build();
    log.recordFailure({ cause: "mint failed", context: "", retryInMs: 1000 });
    log.recordSuccess();
    log.recordFailure({ cause: "mint failed", context: "", retryInMs: 1000 });
    // Same cause as before, but a NEW outage - it must not be suppressed as a
    // repeat of the one that already ended.
    expect(captured.warns).toHaveLength(2);
    expect(captured.warns[1]).toContain("is down");
  });
});
