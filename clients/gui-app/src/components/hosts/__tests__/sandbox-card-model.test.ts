import { describe, expect, it } from "vitest";
import {
  HOST_SANDBOX_STATES,
  type HostSandboxState,
} from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  formatSandboxDay,
  sandboxCardActions,
  sandboxFrozenLine,
  sandboxGuestConfigFailure,
  sandboxIdleLine,
  sandboxStateLine,
  sandboxSuspendKeepsLine,
  sandboxTileOverlay,
  type SandboxCardAction,
} from "@/components/hosts/sandbox-card-model";
import { frozenDestroyAt } from "@/lib/sandboxes/sandbox-balance";

function summaryOf(overrides: Partial<SandboxSummary>): SandboxSummary {
  return {
    id: "sbx_1",
    hostId: "host-1",
    kind: "agent",
    provider: "tensorlake",
    region: "us-east",
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: 20480,
    displayName: "build-box",
    state: "awake",
    frozen: false,
    failureCode: null,
    idleMinutes: null,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    createdAt: 1_791_000_000_000,
    lastTransitionAt: 1_791_000_010_000,
    lastActivityAt: null,
    destroyedAt: null,
    frozenAt: null,
    guestConfigured: null,
    guestConfigFailureReason: null,
    priceMcPerHour: null,
    ...overrides,
  };
}

const THAWED_ACTIONS: Record<HostSandboxState, readonly SandboxCardAction[]> = {
  creating: [],
  awake: ["suspend", "stop", "destroy"],
  suspending: [],
  suspended: ["resume", "destroy"],
  resuming: [],
  stopping: [],
  stopped: ["start", "destroy"],
  starting: [],
  destroying: [],
  destroyed: [],
  failed: ["destroy"],
  released: ["destroy"],
};

describe("sandboxCardActions", () => {
  it("offers each state exactly the verbs the control plane accepts from it", () => {
    for (const state of HOST_SANDBOX_STATES) {
      expect(sandboxCardActions(state, false)).toEqual(THAWED_ACTIONS[state]);
    }
  });

  it("offers a frozen row Destroy and nothing else wherever its state has Destroy", () => {
    for (const state of [
      "awake",
      "suspended",
      "stopped",
      "failed",
      "released",
    ] as const) {
      expect(sandboxCardActions(state, true)).toEqual(["destroy"]);
    }
  });

  it("offers a frozen row in a transitional state nothing", () => {
    for (const state of [
      "creating",
      "suspending",
      "resuming",
      "stopping",
      "starting",
      "destroying",
      "destroyed",
    ] as const) {
      expect(sandboxCardActions(state, true)).toEqual([]);
    }
  });

  it("never offers a wake verb to a frozen row, which would only answer sandbox_frozen", () => {
    for (const state of HOST_SANDBOX_STATES) {
      const actions = sandboxCardActions(state, true);
      expect(actions).not.toContain("resume");
      expect(actions).not.toContain("start");
    }
  });

  it("offers an unknown state nothing, frozen or not", () => {
    expect(sandboxCardActions(null, false)).toEqual([]);
    expect(sandboxCardActions(null, true)).toEqual([]);
  });
});

describe("sandboxStateLine", () => {
  it("speaks a distinct, non-empty sentence for every state", () => {
    const lines = HOST_SANDBOX_STATES.map((state) =>
      sandboxStateLine(state, false, null),
    );
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(HOST_SANDBOX_STATES.length);
  });

  it("states what awake and suspended are billed at", () => {
    expect(sandboxStateLine("awake", false, null)).toContain("awake rate");
    expect(sandboxStateLine("suspended", false, null)).toContain(
      "storage rate",
    );
  });

  it("leads with the frozen line over every state when frozen", () => {
    for (const state of HOST_SANDBOX_STATES) {
      expect(sandboxStateLine(state, true, null)).toBe(sandboxFrozenLine(null));
    }
  });

  it("carries the frozen row's destroy date through its summary", () => {
    const frozenAt = 1_791_000_000_000;
    expect(
      sandboxStateLine(
        "suspended",
        true,
        summaryOf({ frozenAt, frozen: true }),
      ),
    ).toBe(sandboxFrozenLine(frozenAt));
  });

  it("names the failure code on a failed row and falls back without one", () => {
    expect(
      sandboxStateLine("failed", false, summaryOf({ failureCode: "OOM_BOOT" })),
    ).toContain("(OOM_BOOT)");
    expect(
      sandboxStateLine("failed", false, summaryOf({ failureCode: null })),
    ).toBe(sandboxStateLine("failed", false, null));
    expect(sandboxStateLine("failed", false, null)).not.toContain("(");
  });

  it("says just Sandbox for a state it does not know", () => {
    expect(sandboxStateLine(null, false, null)).toBe("Sandbox");
  });
});

describe("sandboxFrozenLine", () => {
  const BASE = "Frozen: out of credits. Top up to resume.";

  it("omits the date when the server did not say when the row froze", () => {
    expect(sandboxFrozenLine(null)).toBe(BASE);
  });

  it("names the day thirty days after frozenAt when it did", () => {
    const frozenAt = new Date(2026, 9, 9, 12, 0, 0).getTime();
    const line = sandboxFrozenLine(frozenAt);
    expect(line).toBe(
      `${BASE} Destroyed on ${formatSandboxDay(frozenDestroyAt(frozenAt))}.`,
    );
    expect(formatSandboxDay(frozenDestroyAt(frozenAt))).toBe(
      formatSandboxDay(new Date(2026, 10, 8, 12, 0, 0).getTime()),
    );
  });
});

describe("sandboxIdleLine", () => {
  it("says Suspends for a normal row and Destroyed for a burst row", () => {
    expect(sandboxIdleLine(summaryOf({ burst: false, idleMinutes: 30 }))).toBe(
      "Suspends after 30 min idle",
    );
    expect(sandboxIdleLine(summaryOf({ burst: true, idleMinutes: 30 }))).toBe(
      "Destroyed after 30 min idle",
    );
  });

  it("takes the 30-minute default when the row sets no idle period", () => {
    expect(sandboxIdleLine(summaryOf({ idleMinutes: null }))).toBe(
      "Suspends after 30 min idle",
    );
    expect(sandboxIdleLine(summaryOf({ burst: true, idleMinutes: null }))).toBe(
      "Destroyed after 30 min idle",
    );
  });

  it("words an hour boundary, a whole number of hours and a fractional one", () => {
    expect(sandboxIdleLine(summaryOf({ idleMinutes: 59 }))).toContain("59 min");
    expect(sandboxIdleLine(summaryOf({ idleMinutes: 60 }))).toContain("1 h");
    expect(sandboxIdleLine(summaryOf({ idleMinutes: 120 }))).toContain("2 h");
    expect(sandboxIdleLine(summaryOf({ idleMinutes: 90 }))).toContain("1.5 h");
  });
});

describe("sandboxSuspendKeepsLine", () => {
  it("states what each fidelity keeps and nothing for one this build does not know", () => {
    expect(sandboxSuspendKeepsLine("memory")).toContain("keeps memory");
    expect(sandboxSuspendKeepsLine("disk")).toContain("disk only");
    expect(sandboxSuspendKeepsLine("none")).toContain("keeps nothing");
    expect(sandboxSuspendKeepsLine("holographic")).toBeNull();
  });
});

describe("sandboxGuestConfigFailure", () => {
  it("is null before any report and when the guest is configured", () => {
    expect(
      sandboxGuestConfigFailure(summaryOf({ guestConfigured: null })),
    ).toBeNull();
    expect(
      sandboxGuestConfigFailure(
        summaryOf({
          guestConfigured: true,
          guestConfigFailureReason: "stale reason",
        }),
      ),
    ).toBeNull();
  });

  it("gives the generic sentence for a failure with a null or blank reason", () => {
    const generic =
      "Guest setup failed. Agents can't start here until it succeeds.";
    expect(
      sandboxGuestConfigFailure(
        summaryOf({ guestConfigured: false, guestConfigFailureReason: null }),
      ),
    ).toBe(generic);
    expect(
      sandboxGuestConfigFailure(
        summaryOf({ guestConfigured: false, guestConfigFailureReason: "  \n" }),
      ),
    ).toBe(generic);
  });

  it("appends the guest's reason when it gave one", () => {
    expect(
      sandboxGuestConfigFailure(
        summaryOf({
          guestConfigured: false,
          guestConfigFailureReason: "broker unreachable",
        }),
      ),
    ).toBe("Guest setup failed: broker unreachable");
  });
});

describe("sandboxTileOverlay", () => {
  it("is the frozen overlay for a frozen row, over every state", () => {
    for (const state of HOST_SANDBOX_STATES) {
      expect(sandboxTileOverlay(state, true)).toEqual({ kind: "frozen" });
    }
  });

  it("offers Resume for a suspended or suspending row and Start for a stopped or stopping one", () => {
    for (const state of ["suspending", "suspended"] as const) {
      expect(sandboxTileOverlay(state, false)).toMatchObject({
        kind: "asleep",
        verb: "resume",
        label: "Resume",
      });
    }
    for (const state of ["stopping", "stopped"] as const) {
      expect(sandboxTileOverlay(state, false)).toMatchObject({
        kind: "asleep",
        verb: "start",
        label: "Start",
      });
    }
  });

  it("shows a moving overlay while a row resumes or starts", () => {
    expect(sandboxTileOverlay("resuming", false)).toEqual({
      kind: "moving",
      message: "Resuming",
    });
    expect(sandboxTileOverlay("starting", false)).toEqual({
      kind: "moving",
      message: "Starting",
    });
  });

  it("shows none for the states the tile already renders itself", () => {
    for (const state of [
      "creating",
      "awake",
      "destroying",
      "destroyed",
      "failed",
      "released",
    ] as const) {
      expect(sandboxTileOverlay(state, false)).toBeNull();
    }
    expect(sandboxTileOverlay(null, false)).toBeNull();
  });
});
