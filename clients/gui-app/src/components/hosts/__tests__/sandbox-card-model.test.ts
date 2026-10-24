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
  sandboxSecretsReadiness,
  sandboxStateLine,
  sandboxSuspendKeepsLine,
  sandboxTileOverlay,
  type SandboxCardAction,
} from "@/components/hosts/sandbox-card-model";
import {
  HOST_HEALTH_TONE,
  type HostHealthState,
} from "@/components/settings/host-scope/host-health";
import { frozenDestroyAt } from "@/lib/sandboxes/sandbox-balance";

/** Every host health state, read off the exhaustive tone table. */
const HOST_HEALTH_STATES: readonly HostHealthState[] = Object.keys(
  HOST_HEALTH_TONE,
).filter((key): key is HostHealthState => key in HOST_HEALTH_TONE);

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
    phase: null,
    routes: null,
    priceMcPerHour: null,
    environmentId: null,
    createdBy: null,
    wakePayer: null,
    keptBy: null,
    restingSince: null,
    destroyAfterRestingMinutes: null,
    destroyAt: null,
    createdByTaskId: null,
    ...overrides,
  };
}

const THAWED_ACTIONS: Record<HostSandboxState, readonly SandboxCardAction[]> = {
  creating: [],
  awake: ["suspend", "stop", "destroy"],
  suspending: ["destroy"],
  suspended: ["resume", "destroy"],
  resuming: [],
  stopping: ["destroy"],
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
      expect(sandboxCardActions(state, false, "agent")).toEqual(
        THAWED_ACTIONS[state],
      );
    }
  });

  it("offers a frozen row Destroy and nothing else wherever its state has Destroy", () => {
    for (const state of [
      "awake",
      "suspending",
      "suspended",
      "stopping",
      "stopped",
      "failed",
      "released",
    ] as const) {
      expect(sandboxCardActions(state, true, "agent")).toEqual(["destroy"]);
    }
  });

  it("offers a frozen row in a transitional state nothing", () => {
    for (const state of [
      "creating",
      "resuming",
      "starting",
      "destroying",
      "destroyed",
    ] as const) {
      expect(sandboxCardActions(state, true, "agent")).toEqual([]);
    }
  });

  it("never offers a wake verb to a frozen row, which would only answer sandbox_frozen", () => {
    for (const state of HOST_SANDBOX_STATES) {
      const actions = sandboxCardActions(state, true, "agent");
      expect(actions).not.toContain("resume");
      expect(actions).not.toContain("start");
    }
  });

  it("offers the Automations row stop/destroy awake and start/destroy released, never suspend", () => {
    expect(sandboxCardActions("awake", false, "automation")).toEqual([
      "stop",
      "destroy",
    ]);
    expect(sandboxCardActions("released", false, "automation")).toEqual([
      "start",
      "destroy",
    ]);
    for (const state of HOST_SANDBOX_STATES) {
      expect(sandboxCardActions(state, false, "automation")).not.toContain(
        "suspend",
      );
    }
  });

  it("keeps the frozen rule for the Automations row", () => {
    expect(sandboxCardActions("released", true, "automation")).toEqual([
      "destroy",
    ]);
    expect(sandboxCardActions("creating", true, "automation")).toEqual([]);
  });

  it("leaves an agent row's released offer at destroy only", () => {
    expect(sandboxCardActions("released", false, "agent")).toEqual(["destroy"]);
  });

  it("offers an unknown state nothing, frozen or not", () => {
    expect(sandboxCardActions(null, false, "agent")).toEqual([]);
    expect(sandboxCardActions(null, true, "agent")).toEqual([]);
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

  it("the suspending line claims no saved state", () => {
    expect(sandboxStateLine("suspending", false, null)).not.toContain("Saving");
    expect(sandboxStateLine("suspending", false, null)).toBe(
      "Suspending. Billing moves to storage.",
    );
  });

  it("states what awake and suspended are billed at", () => {
    expect(sandboxStateLine("awake", false, null)).toContain("awake rate");
    expect(sandboxStateLine("suspended", false, null)).toContain(
      "storage rate",
    );
  });

  it("says an awake Automations row is not billed, and only that row", () => {
    expect(
      sandboxStateLine("awake", false, summaryOf({ kind: "automation" })),
    ).toBe("Running. Automations aren't billed.");
    expect(
      sandboxStateLine("awake", false, summaryOf({ kind: "agent" })),
    ).toContain("awake rate");
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

  it("says a newer-saved sandbox can't start until the next Traycer update", () => {
    expect(
      sandboxStateLine(
        "stopped",
        false,
        summaryOf({ failureCode: "chat-store-newer" }),
      ),
    ).toBe(
      "This sandbox's data was saved by a newer version of Traycer, so it can't start yet. Start it again after the next Traycer update.",
    );
  });

  it("names the code of a start that did not finish on a stopped row", () => {
    expect(
      sandboxStateLine(
        "stopped",
        false,
        summaryOf({ failureCode: "wake-timeout:no-phase" }),
      ),
    ).toBe(
      "The last start didn't finish (wake-timeout:no-phase). Start tries again.",
    );
  });

  it("keeps the plain stopped line for a stopped row with no failure code", () => {
    const plain = sandboxStateLine("stopped", false, null);
    expect(plain).toBe(
      "Stopped. Disk kept, processes ended. Start boots it again; shells marked relaunch-on-restart come back.",
    );
    expect(
      sandboxStateLine("stopped", false, summaryOf({ failureCode: null })),
    ).toBe(plain);
  });

  it("keeps the failed-to-start sentence for a failed row with a code", () => {
    expect(
      sandboxStateLine(
        "failed",
        false,
        summaryOf({ failureCode: "chat-store-newer" }),
      ),
    ).toBe(
      "Failed to start (chat-store-newer). Nothing is billed for a sandbox that never woke.",
    );
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
  it("states the release rule for an Automations row, not its idle period", () => {
    expect(
      sandboxIdleLine(summaryOf({ kind: "automation", idleMinutes: 30 })),
    ).toBe("Released after a day with no shell");
  });

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

  it("offers a released row a Start overlay", () => {
    expect(sandboxTileOverlay("released", false)).toEqual({
      kind: "asleep",
      message: "Released",
      verb: "start",
      label: "Start",
    });
  });

  it("shows none for the states the tile already renders itself", () => {
    for (const state of [
      "creating",
      "awake",
      "destroying",
      "destroyed",
      "failed",
    ] as const) {
      expect(sandboxTileOverlay(state, false)).toBeNull();
    }
    expect(sandboxTileOverlay(null, false)).toBeNull();
  });
});

describe("sandboxSecretsReadiness", () => {
  it("is null when the summary reports no phase", () => {
    expect(
      sandboxSecretsReadiness(
        "awake",
        false,
        summaryOf({ phase: null }),
        "online",
      ),
    ).toBeNull();
  });

  it("is null unless the sandbox is awake", () => {
    const summary = summaryOf({ phase: "ready" });
    for (const state of HOST_SANDBOX_STATES) {
      if (state === "awake") continue;
      expect(
        sandboxSecretsReadiness(state, false, summary, "online"),
      ).toBeNull();
    }
    expect(sandboxSecretsReadiness(null, false, summary, "online")).toBeNull();
  });

  it("is null once the host is not reachable, whatever it last reported", () => {
    const summary = summaryOf({ phase: "ready" });
    expect(HOST_HEALTH_STATES).toContain("offline");
    for (const hostState of HOST_HEALTH_STATES) {
      if (hostState === "online" || hostState === "reported-reachable") {
        continue;
      }
      expect(
        sandboxSecretsReadiness("awake", false, summary, hostState),
      ).toBeNull();
    }
  });

  it("keeps the line for a host the account heard from but this window never dialled", () => {
    expect(
      sandboxSecretsReadiness(
        "awake",
        false,
        summaryOf({ phase: "ready" }),
        "reported-reachable",
      )?.tone,
    ).toBe("ready");
  });

  it("is null while the sandbox is frozen", () => {
    expect(
      sandboxSecretsReadiness(
        "awake",
        true,
        summaryOf({ phase: "ready" }),
        "online",
      ),
    ).toBeNull();
  });

  it("is null for a phase this build does not know, never ready", () => {
    expect(
      sandboxSecretsReadiness(
        "awake",
        false,
        summaryOf({ phase: "teleporting" }),
        "online",
      ),
    ).toBeNull();
  });

  it.each(["proxy-reachable", "ready"])("reads %s as ready", (phase) => {
    expect(
      sandboxSecretsReadiness("awake", false, summaryOf({ phase }), "online")
        ?.tone,
    ).toBe("ready");
  });

  it.each(["enrolling", "proving", "attaching"])(
    "reads %s as pending",
    (phase) => {
      expect(
        sandboxSecretsReadiness("awake", false, summaryOf({ phase }), "online")
          ?.tone,
      ).toBe("pending");
    },
  );

  it("reads degraded(hop) as degraded and names the hop", () => {
    const readiness = sandboxSecretsReadiness(
      "awake",
      false,
      summaryOf({ phase: "degraded(gateway)" }),
      "online",
    );
    expect(readiness?.tone).toBe("degraded");
    expect(readiness?.text).toContain("gateway");
  });

  it("reads degraded() as degraded without an empty hop", () => {
    const readiness = sandboxSecretsReadiness(
      "awake",
      false,
      summaryOf({ phase: "degraded()" }),
      "online",
    );
    expect(readiness?.tone).toBe("degraded");
    expect(readiness?.text).not.toContain("at :");
    expect(readiness?.text).not.toContain("  ");
  });
});
