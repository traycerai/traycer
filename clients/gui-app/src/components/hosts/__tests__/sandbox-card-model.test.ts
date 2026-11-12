import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_SANDBOX_STATES,
  type HostSandboxState,
} from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { formatSandboxDate } from "@/lib/sandboxes/sandbox-row-lines";
import {
  sandboxCardActions,
  sandboxFrozenLine,
  sandboxGuestConfigFailure,
  sandboxIdleLine,
  sandboxBilledPriceField,
  sandboxOperationalLine,
  sandboxSecretsReadiness,
  sandboxStateLine,
  sandboxSuspendKeepsLine,
  sandboxTileOverlay,
  sandboxWithdrawalLine,
  type SandboxCardAction,
  type SandboxPriceField,
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
    createdByAgentName: null,
    createdByTaskTitle: null,
    keptAt: null,
    operation: null,
    regionLabel: null,
    withdrawalEndsAt: null,
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
  released: [],
};

const TEAM_POD_ACTIONS: Record<HostSandboxState, readonly SandboxCardAction[]> =
  {
    ...THAWED_ACTIONS,
    awake: ["stop", "destroy"],
    released: ["start", "destroy"],
  };

describe("sandboxCardActions", () => {
  it("offers each state exactly the verbs the control plane accepts from it", () => {
    for (const state of HOST_SANDBOX_STATES) {
      expect(sandboxCardActions(state, false, "agent", false)).toEqual(
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
    ] as const) {
      expect(sandboxCardActions(state, true, "agent", false)).toEqual([
        "destroy",
      ]);
    }
  });

  it("offers a frozen row in a transitional state nothing", () => {
    for (const state of [
      "creating",
      "resuming",
      "starting",
      "destroying",
      "destroyed",
      "released",
    ] as const) {
      expect(sandboxCardActions(state, true, "agent", false)).toEqual([]);
    }
  });

  it("never offers a wake verb to a frozen row, which would only answer sandbox_frozen", () => {
    for (const state of HOST_SANDBOX_STATES) {
      const actions = sandboxCardActions(state, true, "agent", false);
      expect(actions).not.toContain("resume");
      expect(actions).not.toContain("start");
    }
  });

  it("offers the person's own Automations row no card action in any state, frozen or not", () => {
    for (const state of HOST_SANDBOX_STATES) {
      expect(sandboxCardActions(state, false, "automation", false)).toEqual([]);
      expect(sandboxCardActions(state, true, "automation", false)).toEqual([]);
    }
  });

  it("offers a team pod Stop and Start in place of suspend, with Destroy, in each state", () => {
    for (const state of HOST_SANDBOX_STATES) {
      expect(sandboxCardActions(state, false, "automation", true)).toEqual(
        TEAM_POD_ACTIONS[state],
      );
    }
  });

  it("offers a frozen team pod Destroy and nothing else wherever its state has Destroy", () => {
    for (const state of HOST_SANDBOX_STATES) {
      expect(sandboxCardActions(state, true, "automation", true)).toEqual(
        TEAM_POD_ACTIONS[state].includes("destroy") ? ["destroy"] : [],
      );
    }
  });

  it("leaves an awake agent row suspend, stop and destroy", () => {
    expect(sandboxCardActions("awake", false, "agent", false)).toEqual([
      "suspend",
      "stop",
      "destroy",
    ]);
  });

  it("offers an unknown state nothing, frozen or not", () => {
    expect(sandboxCardActions(null, false, "agent", false)).toEqual([]);
    expect(sandboxCardActions(null, true, "agent", false)).toEqual([]);
  });
});

describe("sandboxStateLine", () => {
  it("speaks a distinct, non-empty sentence for every state", () => {
    const lines = HOST_SANDBOX_STATES.map((state) =>
      sandboxStateLine(state, null),
    );
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(HOST_SANDBOX_STATES.length);
  });

  it("the suspending line claims no saved state", () => {
    expect(sandboxStateLine("suspending", null)).not.toContain("Saving");
    expect(sandboxStateLine("suspending", null)).toBe(
      "Suspending. Billing moves to storage.",
    );
  });

  it("states what awake and suspended are billed at", () => {
    expect(sandboxStateLine("awake", null)).toContain("awake rate");
    expect(sandboxStateLine("suspended", null)).toContain("storage rate");
  });

  it("says a released row's files are kept and the next shell starts it", () => {
    expect(sandboxStateLine("released", null)).toBe(
      "Not running, files kept. The next shell starts it.",
    );
  });

  it("says an awake Automations row is not billed, and only that row", () => {
    expect(sandboxStateLine("awake", summaryOf({ kind: "automation" }))).toBe(
      "Running. Automations aren't billed.",
    );
    expect(sandboxStateLine("awake", summaryOf({ kind: "agent" }))).toContain(
      "awake rate",
    );
  });

  it("names the failure's support reference on a failed row, never its raw code, and falls back without one", () => {
    const failed = sandboxStateLine(
      "failed",
      summaryOf({ failureCode: "create:kube-create-service-account" }),
    );
    expect(failed).toBe(
      "Failed to start · The sandbox service couldn't start it. · SBX-0412.",
    );
    expect(failed).not.toContain("create:");
    expect(
      sandboxStateLine("failed", summaryOf({ failureCode: "OOM_BOOT" })),
    ).toBe("Failed to start.");
    expect(sandboxStateLine("failed", summaryOf({ failureCode: null }))).toBe(
      "Failed to start.",
    );
    expect(sandboxStateLine("failed", null)).toBe("Failed to start.");
    expect(sandboxStateLine("failed", null)).not.toContain("(");
  });

  it("says a newer-saved sandbox can't start until the next Traycer update", () => {
    expect(
      sandboxStateLine(
        "stopped",
        summaryOf({ failureCode: "chat-store-newer" }),
      ),
    ).toBe(
      "This sandbox's data was saved by a newer version of Traycer, so it can't start yet. Start it again after the next Traycer update.",
    );
  });

  it("names the support reference of a start that did not finish on a stopped row", () => {
    expect(
      sandboxStateLine("stopped", summaryOf({ failureCode: "start:x" })),
    ).toBe("The last start didn't finish (SBX-0508). Start tries again.");
    expect(sandboxStateLine("stopped", summaryOf({ failureCode: "zzz" }))).toBe(
      "The last start didn't finish. Start tries again.",
    );
  });

  it("keeps the plain stopped line for a stopped row with no failure code", () => {
    const plain = sandboxStateLine("stopped", null);
    expect(plain).toBe(
      "Stopped. Disk kept, processes ended. Start boots it again; shells marked relaunch-on-restart come back.",
    );
    expect(sandboxStateLine("stopped", summaryOf({ failureCode: null }))).toBe(
      plain,
    );
  });

  it("keeps the failed-to-start sentence for a failed row with a code", () => {
    expect(
      sandboxStateLine(
        "failed",
        summaryOf({ failureCode: "chat-store-newer" }),
      ),
    ).toBe(
      "Failed to start · The sandbox needs an update to open its saved chats. · SBX-0430.",
    );
  });

  it("says just Sandbox for a state it does not know", () => {
    expect(sandboxStateLine(null, null)).toBe("Sandbox");
  });
});

describe("sandboxOperationalLine", () => {
  const OPERATIONAL_LINE: Record<HostSandboxState, string | null> = {
    creating: "This takes about 10 seconds once capacity is found.",
    awake: null,
    suspending: null,
    suspended: "Resumes on your next action.",
    resuming: null,
    stopping: "Its disk is kept; running processes end.",
    stopped:
      "Disk kept, processes ended. Start boots it again; shells marked relaunch-on-restart come back.",
    starting: null,
    destroying: "Its disk is being deleted.",
    destroyed: "Its disk is gone.",
    failed: null,
    released: "Files kept. The next shell starts it.",
  };

  it.each(HOST_SANDBOX_STATES)("speaks the fixed line for %s", (state) => {
    expect(sandboxOperationalLine(state, false)).toBe(OPERATIONAL_LINE[state]);
  });

  it("speaks no line for an unknown state or a frozen sandbox", () => {
    expect(sandboxOperationalLine(null, false)).toBeNull();
    for (const state of HOST_SANDBOX_STATES) {
      expect(sandboxOperationalLine(state, true)).toBeNull();
    }
  });
});

describe("sandboxFrozenLine", () => {
  const BASE = "Out of credits. Top up to resume.";

  it("omits the date when the server did not say when the row froze", () => {
    expect(sandboxFrozenLine(null)).toBe(BASE);
  });

  it("names the day thirty days after frozenAt when it did", () => {
    const frozenAt = new Date(2026, 9, 9, 12, 0, 0).getTime();
    const line = sandboxFrozenLine(frozenAt);
    expect(line).toBe(
      `${BASE} Will be removed on ${formatSandboxDate(frozenDestroyAt(frozenAt), false)}.`,
    );
    // The line names the removal day without a time.
    expect(formatSandboxDate(frozenDestroyAt(frozenAt), false)).toBe(
      formatSandboxDate(new Date(2026, 10, 8, 12, 0, 0).getTime(), false),
    );
  });
});

describe("sandboxWithdrawalLine", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is null while no withdrawal is announced", () => {
    expect(sandboxWithdrawalLine(null, null)).toBeNull();
  });

  // `destroyAt` is the day the row actually ends, so it wins the sentence:
  // the announced day goes unnamed rather than contradicting it. The two
  // cases share every other word, which is what makes the date the only
  // thing under test.
  it("names no day once the row carries a destroy deadline of its own, keeping the rest of the sentence", () => {
    const endsAt = Date.UTC(2026, 11, 1);
    const withDeadline = sandboxWithdrawalLine(endsAt, Date.UTC(2026, 10, 8));

    expect(withDeadline).toBe(
      "This sandbox stops running and is rebuilt from your environment. Files outside the repository are lost.",
    );
    // Same row, no deadline of its own: the day is named. Which day, and in
    // which zone, is pinned by the case below.
    expect(sandboxWithdrawalLine(endsAt, null)).toContain("stops running on ");
  });

  // `withdrawalEndsAt` is an announced UTC calendar day, and the sentence has
  // to read it in UTC whatever zone the runtime is in. Two things make that a
  // real pin rather than a passing case:
  //
  // - the zone is PINNED to one that is not UTC. Left to the runner's own
  //   zone, the case is vacuous on a UTC runner, where a local read and a UTC
  //   read name the same day, and nothing in this repository pins a non-UTC
  //   zone for tests;
  // - the expected day is COMPUTED, in the runtime's own default locale,
  //   rather than written out. `formatSandboxUtcDay` formats in that default
  //   locale, so a literal `Dec 1, 2026` would fail under any other one while
  //   the UTC reading was perfectly correct.
  //
  // Lose the UTC reading and the line carries the local rendering, a day
  // earlier in this zone, failing both assertions on any runner.
  it("names the UTC day, never the runtime's own zone's day, pinned to a zone that is not UTC", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    // The pin itself has to take, or the case proves nothing.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      "America/Los_Angeles",
    );

    const endsAt = Date.UTC(2026, 11, 1);
    const dayOptions: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      year: "numeric",
    };
    const utcDay = new Date(endsAt).toLocaleDateString(undefined, {
      ...dayOptions,
      timeZone: "UTC",
    });
    const localDay = new Date(endsAt).toLocaleDateString(undefined, dayOptions);
    // The pin only proves anything if the two readings actually diverge for
    // this instant and zone; a runner where they coincide would pass this
    // case for the wrong reason.
    expect(utcDay).not.toBe(localDay);

    const line = sandboxWithdrawalLine(endsAt, null);
    expect(line).toContain(utcDay);
    expect(line).not.toContain(localDay);
  });
});

describe("sandboxIdleLine", () => {
  it("states the release rule for an Automations row on its idle period, files kept", () => {
    expect(
      sandboxIdleLine(
        summaryOf({ kind: "automation", idleMinutes: 30 }),
        "awake",
      ),
    ).toBe("Stops after 30 min idle · files kept · the next shell starts it");
  });

  it("keeps only the period for a released Automations row, whose state line says the rest", () => {
    expect(
      sandboxIdleLine(
        summaryOf({ kind: "automation", idleMinutes: 30 }),
        "released",
      ),
    ).toBe("Stops after 30 min idle");
  });

  it("says Suspends for a normal row and Destroyed for a burst row", () => {
    expect(
      sandboxIdleLine(summaryOf({ burst: false, idleMinutes: 30 }), "awake"),
    ).toBe("Suspends after 30 min idle");
    expect(
      sandboxIdleLine(summaryOf({ burst: true, idleMinutes: 30 }), "awake"),
    ).toBe("Destroyed after 30 min idle");
  });

  it("takes the 30-minute default when the row sets no idle period", () => {
    expect(sandboxIdleLine(summaryOf({ idleMinutes: null }), "awake")).toBe(
      "Suspends after 30 min idle",
    );
    expect(
      sandboxIdleLine(summaryOf({ burst: true, idleMinutes: null }), "awake"),
    ).toBe("Destroyed after 30 min idle");
  });

  it("words an hour boundary, a whole number of hours and a fractional one", () => {
    expect(sandboxIdleLine(summaryOf({ idleMinutes: 59 }), "awake")).toContain(
      "59 min",
    );
    expect(sandboxIdleLine(summaryOf({ idleMinutes: 60 }), "awake")).toContain(
      "1 h",
    );
    expect(sandboxIdleLine(summaryOf({ idleMinutes: 120 }), "awake")).toContain(
      "2 h",
    );
    expect(sandboxIdleLine(summaryOf({ idleMinutes: 90 }), "awake")).toContain(
      "1.5 h",
    );
  });
});

describe("sandboxSuspendKeepsLine", () => {
  it("states what each fidelity keeps and nothing for one this build does not know", () => {
    expect(sandboxSuspendKeepsLine("memory")).toBe("keeps memory");
    expect(sandboxSuspendKeepsLine("disk")).toBe(
      "keeps disk only · processes restart on resume",
    );
    expect(sandboxSuspendKeepsLine("none")).toBe("restarts from its image");
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
      "Settings did not apply. Agents can't start here until they do.";
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
    ).toBe("Settings did not apply: broker unreachable");
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
        message:
          state === "suspending"
            ? "Suspending, resumes on your next action"
            : "Suspended, resumes on your next action",
      });
    }
    for (const state of ["stopping", "stopped"] as const) {
      expect(sandboxTileOverlay(state, false)).toMatchObject({
        kind: "asleep",
        verb: "start",
        label: "Start",
        message: state === "stopping" ? "Stopping" : "Stopped",
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
      message: "Not running",
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

describe("sandboxBilledPriceField", () => {
  const BILLED: Record<HostSandboxState, SandboxPriceField | null> = {
    creating: null,
    awake: "awakeMc",
    suspending: "suspendedMc",
    suspended: "suspendedMc",
    resuming: "awakeMc",
    stopping: "stoppedMc",
    stopped: "stoppedMc",
    starting: "awakeMc",
    destroying: null,
    destroyed: null,
    failed: null,
    released: null,
  };

  it.each(HOST_SANDBOX_STATES)("names the price %s accrues", (state) => {
    expect(sandboxBilledPriceField(state)).toBe(BILLED[state]);
  });
});
