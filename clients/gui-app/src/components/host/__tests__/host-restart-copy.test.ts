import { describe, expect, it } from "vitest";
import type { HostRestartBusyVerdict } from "@traycer/protocol/host/restart/index";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import {
  busyRestartMessage,
  busyRestartVerdictSentence,
  busyWorkPhrase,
  describeHostBusy,
} from "@/components/host/host-restart-copy";

const ZERO: HostBusyBreakdown = {
  workingAgents: 0,
  activeTerminalAgents: 0,
  busyTerminals: 0,
};

describe("describeHostBusy", () => {
  it("names mixed agents and terminals with a middle-dot label", () => {
    const copy = describeHostBusy({
      breakdown: {
        workingAgents: 2,
        activeTerminalAgents: 0,
        busyTerminals: 1,
      },
      busySessionCount: 3,
      busy: true,
    });
    expect(copy.label).toBe("2 agents · 1 terminal working");
    expect(copy.sentence).toBe(
      "It reports 2 agents and 1 terminal, and re-registering will end them.",
    );
  });

  it("names a single agent", () => {
    const copy = describeHostBusy({
      breakdown: {
        workingAgents: 1,
        activeTerminalAgents: 0,
        busyTerminals: 0,
      },
      busySessionCount: 1,
      busy: true,
    });
    expect(copy.label).toBe("1 agent working");
    expect(copy.sentence).toBe(
      "It reports 1 agent, and re-registering will end it.",
    );
  });

  it("names a single terminal agent", () => {
    const copy = describeHostBusy({
      breakdown: {
        workingAgents: 0,
        activeTerminalAgents: 1,
        busyTerminals: 0,
      },
      busySessionCount: 1,
      busy: true,
    });
    expect(copy.label).toBe("1 terminal agent working");
  });

  it("names a single terminal", () => {
    const copy = describeHostBusy({
      breakdown: {
        workingAgents: 0,
        activeTerminalAgents: 0,
        busyTerminals: 1,
      },
      busySessionCount: 1,
      busy: true,
    });
    expect(copy.label).toBe("1 terminal working");
  });

  it("joins all three kinds and pluralizes each", () => {
    const copy = describeHostBusy({
      breakdown: {
        workingAgents: 2,
        activeTerminalAgents: 3,
        busyTerminals: 1,
      },
      busySessionCount: 6,
      busy: true,
    });
    expect(copy.label).toBe(
      "2 agents · 3 terminal agents · 1 terminal working",
    );
    expect(copy.sentence).toBe(
      "It reports 2 agents, 3 terminal agents, and 1 terminal, and re-registering will end them.",
    );
  });

  it("treats a zero breakdown as Idle, never as sessions", () => {
    const copy = describeHostBusy({
      breakdown: ZERO,
      busySessionCount: 0,
      busy: false,
    });
    expect(copy.label).toBe("Idle");
    expect(copy.sentence).toBe(
      "It reports no work, so nothing should be interrupted.",
    );
    expect(copy.label).not.toMatch(/session/i);
  });

  it("says Busy, not Idle, for a busy host with an all-zero breakdown", () => {
    // pendingCreates is not a breakdown field: the host can be busy with
    // count 0 and {0,0,0} while a terminal create is in flight.
    const copy = describeHostBusy({
      breakdown: ZERO,
      busySessionCount: 0,
      busy: true,
    });
    expect(copy.label).toBe("Busy");
    expect(copy.sentence).toBe(
      "It reports it is busy, and re-registering will end that work.",
    );
  });

  it("falls back to N sessions for a @1.1 host with a count and no breakdown", () => {
    const copy = describeHostBusy({
      breakdown: null,
      busySessionCount: 2,
      busy: true,
    });
    expect(copy.label).toBe("2 sessions");
    expect(copy.sentence).toBe(
      "It reports 2 sessions, and re-registering will end them.",
    );
  });

  it("singularizes the @1.1 count fallback", () => {
    expect(
      describeHostBusy({
        breakdown: null,
        busySessionCount: 1,
        busy: true,
      }).label,
    ).toBe("1 session");
  });

  it("says Busy when an old host is busy and named no count", () => {
    expect(
      describeHostBusy({
        breakdown: null,
        busySessionCount: null,
        busy: true,
      }),
    ).toEqual({
      label: "Busy",
      sentence: "It reports it is busy, and re-registering will end that work.",
    });
  });

  it("says Busy when an old host is busy with a reported zero count", () => {
    expect(
      describeHostBusy({
        breakdown: null,
        busySessionCount: 0,
        busy: true,
      }).label,
    ).toBe("Busy");
  });

  it("says Idle for a known-zero count that is not busy", () => {
    expect(
      describeHostBusy({
        breakdown: null,
        busySessionCount: 0,
        busy: false,
      }).label,
    ).toBe("Idle");
  });

  it("makes no claim when everything is unknown", () => {
    expect(
      describeHostBusy({
        breakdown: null,
        busySessionCount: null,
        busy: false,
      }),
    ).toEqual({ label: null, sentence: null });
  });
});

describe("busyWorkPhrase", () => {
  it("returns the and-joined phrase used by the drain-gate force", () => {
    expect(
      busyWorkPhrase({
        workingAgents: 2,
        activeTerminalAgents: 0,
        busyTerminals: 1,
      }),
    ).toBe("2 agents and 1 terminal");
  });

  it("returns null for a zero breakdown", () => {
    expect(busyWorkPhrase(ZERO)).toBeNull();
  });
});

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

  it("names the breakdown and ignores count+blockers when the split is present", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 3,
      blockers: { workingAgents: true, runningTerminals: true },
      busyBreakdown: {
        workingAgents: 2,
        activeTerminalAgents: 0,
        busyTerminals: 1,
      },
    };
    expect(busyRestartVerdictSentence(verdict)).toBe(
      "2 agents and 1 terminal are still keeping this host busy.",
    );
    expect(busyRestartVerdictSentence(verdict)).not.toMatch(/session/i);
  });

  it("names a single agent from the breakdown with the singular verb", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 1,
      blockers: { workingAgents: true, runningTerminals: false },
      busyBreakdown: {
        workingAgents: 1,
        activeTerminalAgents: 0,
        busyTerminals: 0,
      },
    };
    expect(busyRestartVerdictSentence(verdict)).toBe(
      "1 agent is still keeping this host busy.",
    );
  });

  it("falls through to blockers when the breakdown is present but all zeros", () => {
    const verdict: HostRestartBusyVerdict = {
      busySessionCount: 0,
      blockers: { workingAgents: true, runningTerminals: false },
      busyBreakdown: ZERO,
    };
    expect(busyRestartVerdictSentence(verdict)).toBe(
      "Agent work is still keeping this host busy.",
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
