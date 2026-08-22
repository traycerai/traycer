import { describe, expect, it } from "vitest";
import type { HostRestartBusyVerdict } from "@traycer/protocol/host/restart/index";
import {
  busyRestartMessage,
  busyRestartVerdictSentence,
} from "@/components/host/host-restart-copy";

describe("busyRestartVerdictSentence", () => {
  it("names the plural session count when blockers is null", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 2,
      blockers: null,
      busyBreakdown: null,
    };
    expect(busyRestartVerdictSentence(verdict)).toBe(
      "2 sessions are still keeping this host busy.",
    );
  });

  it("names a singular session count with the singular verb", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 1,
      blockers: null,
      busyBreakdown: null,
    };
    expect(busyRestartVerdictSentence(verdict)).toBe(
      "1 session is still keeping this host busy.",
    );
  });

  it("names agent work alone when only workingAgents is set", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 0,
      blockers: { workingAgents: true, runningTerminals: false },
      busyBreakdown: null,
    };
    expect(busyRestartVerdictSentence(verdict)).toBe(
      "Agent work is still keeping this host busy.",
    );
  });

  it("joins agent work and open terminals with 'and' when both blockers are set", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 0,
      blockers: { workingAgents: true, runningTerminals: true },
      busyBreakdown: null,
    };
    expect(busyRestartVerdictSentence(verdict)).toBe(
      "Agent work and open terminals are still keeping this host busy.",
    );
  });

  it("joins all three subjects with commas and a trailing 'and'", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 2,
      blockers: { workingAgents: true, runningTerminals: true },
      busyBreakdown: null,
    };
    expect(busyRestartVerdictSentence(verdict)).toBe(
      "2 sessions, agent work, and open terminals are still keeping this host busy.",
    );
  });

  // The original bug: a busy verdict with count 0 must NOT render "0
  // sessions are still working" - a count-zero, blockers-null (or all-false)
  // verdict has nothing nameable, so the sentence falls back to naming the
  // host rather than fabricating a subject.
  it("falls back to the host-level sentence for a zero count with blockers null", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 0,
      blockers: null,
      busyBreakdown: null,
    };
    expect(busyRestartVerdictSentence(verdict)).toBe(
      "The host is still finishing other work.",
    );
  });

  it("falls back to the host-level sentence for a zero count with both blockers false", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 0,
      blockers: { workingAgents: false, runningTerminals: false },
      busyBreakdown: null,
    };
    expect(busyRestartVerdictSentence(verdict)).toBe(
      "The host is still finishing other work.",
    );
  });
});

describe("busyRestartMessage", () => {
  it("appends the force sentence when forceOffered is true", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 2,
      blockers: null,
      busyBreakdown: null,
    };
    expect(busyRestartMessage(verdict, true)).toBe(
      "2 sessions are still keeping this host busy. Nothing was interrupted; " +
        "try again when the work finishes. Force restart ends it immediately.",
    );
  });

  it("names agent work and open terminals together, without a force sentence when forceOffered is false", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 0,
      blockers: { workingAgents: true, runningTerminals: true },
      busyBreakdown: null,
    };
    expect(busyRestartMessage(verdict, false)).toBe(
      "Agent work and open terminals are still keeping this host busy. " +
        "Nothing was interrupted; try again when the work finishes.",
    );
  });

  it("states a singular session count without a force sentence when forceOffered is false", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 1,
      blockers: null,
      busyBreakdown: null,
    };
    expect(busyRestartMessage(verdict, false)).toBe(
      "1 session is still keeping this host busy. Nothing was interrupted; " +
        "try again when the work finishes.",
    );
  });
});
