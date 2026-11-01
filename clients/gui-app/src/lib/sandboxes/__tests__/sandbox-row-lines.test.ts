import { describe, expect, it } from "vitest";
import type {
  SandboxCost,
  SandboxOperation,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import {
  agentSessionFixture,
  liveSessionReport,
  sandboxSummaryFixture,
  terminalSessionFixture,
} from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  SANDBOX_ROW_FILTER_NONE,
  sandboxClockLine,
  sandboxDestroyAllIdleOffered,
  sandboxReleasedChatLine,
  sandboxFilterCount,
  sandboxFrozenClock,
  sandboxIdleRefusal,
  sandboxListHeader,
  sandboxAgentSessionName,
  sandboxRegionLabel,
  sandboxSessionPills,
  sandboxShapeAndCostLine,
  sandboxPaidByLabel,
  sandboxRowActions,
  sandboxRowMatches,
  sandboxSessionsLine,
  sandboxStartedByLabel,
  sandboxSupportReferenceLine,
  type SandboxRowAction,
  type SandboxPageConfiguration,
  sandboxTodayCost,
  formatSandboxDate,
} from "@/lib/sandboxes/sandbox-row-lines";

const NOW = 1_791_100_000_000;

interface MatrixCase {
  readonly name: string;
  readonly summary: Partial<SandboxSummary>;
  readonly unreachable: boolean;
  readonly frozenNeedsOwnCredits: boolean;
  readonly settingsFailed: boolean;
  readonly primary: SandboxRowAction | null;
  readonly menu: readonly SandboxRowAction[];
}

const AWAKE_MENU: readonly SandboxRowAction[] = [
  "open-tab",
  "open-terminal",
  "rename",
  "idle-settings",
  "stop",
  "destroy",
];

const MATRIX: readonly MatrixCase[] = [
  {
    name: "awake",
    summary: { state: "awake" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "suspend",
    menu: AWAKE_MENU,
  },
  {
    name: "awake agent",
    summary: { state: "awake", burst: true },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "keep",
    menu: AWAKE_MENU,
  },
  {
    name: "stopped agent",
    summary: { state: "stopped", burst: true },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "start",
    menu: ["rename", "idle-settings", "destroy"],
  },
  {
    name: "awake agent, kept",
    summary: {
      state: "awake",
      burst: false,
      keptBy: { userId: "u-priya", displayName: "Priya" },
    },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "suspend",
    menu: AWAKE_MENU,
  },
  {
    name: "suspended",
    summary: { state: "suspended" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "resume",
    menu: ["open-tab", "open-terminal", "rename", "idle-settings", "destroy"],
  },
  {
    name: "stopped",
    summary: { state: "stopped" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "start",
    menu: ["rename", "idle-settings", "destroy"],
  },
  {
    name: "frozen",
    summary: { state: "suspended", frozen: true },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "resume-paying",
    menu: ["rename", "destroy"],
  },
  {
    name: "frozen, viewer's own credits short",
    summary: { state: "suspended", frozen: true },
    unreachable: false,
    frozenNeedsOwnCredits: true,
    settingsFailed: false,
    primary: "add-credits",
    menu: ["rename", "destroy"],
  },
  {
    name: "failed",
    summary: { state: "failed" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "retry",
    menu: ["destroy"],
  },
  {
    // Its Retry would create a kept sandbox in place of the agent's.
    name: "failed agent",
    summary: { state: "failed", burst: true },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: null,
    menu: ["destroy"],
  },
  {
    name: "awake but unreachable",
    summary: { state: "awake" },
    unreachable: true,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "stop",
    menu: ["rename", "destroy"],
  },
  {
    name: "awake, settings did not apply",
    summary: { state: "awake", guestConfigured: false },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "retry-applying",
    menu: ["open-terminal", "rename", "stop", "destroy"],
  },
  {
    // The guest is fine; the environment's settings are what did not apply.
    name: "awake, environment settings did not apply",
    summary: { state: "awake", guestConfigured: true },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: true,
    primary: "retry-applying",
    menu: ["open-terminal", "rename", "stop", "destroy"],
  },
  {
    name: "automations",
    summary: { state: "awake", kind: "automation" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "open-terminal",
    menu: ["rename"],
  },
  {
    name: "released automations",
    summary: { state: "stopped", kind: "automation" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: "open-terminal",
    menu: ["rename"],
  },
  {
    name: "suspending",
    summary: { state: "suspending" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: null,
    menu: ["destroy"],
  },
  {
    name: "resuming",
    summary: { state: "resuming" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    settingsFailed: false,
    primary: null,
    menu: [],
  },
];

describe("sandboxRowActions (Flow 6 matrix)", () => {
  it.each(MATRIX)("$name", (row) => {
    expect(
      sandboxRowActions({
        summary: sandboxSummaryFixture(row.summary),
        unreachable: row.unreachable,
        frozenNeedsOwnCredits: row.frozenNeedsOwnCredits,
        settingsFailed: row.settingsFailed,
      }),
    ).toEqual({ primary: row.primary, menu: row.menu });
  });
});

describe("sandboxRowActions, the Automations row", () => {
  const actionsOf = (summary: Partial<SandboxSummary>) =>
    sandboxRowActions({
      summary: sandboxSummaryFixture({ kind: "automation", ...summary }),
      unreachable: false,
      frozenNeedsOwnCredits: false,
      settingsFailed: false,
    });

  it.each(["awake", "released", "starting", "creating"] as const)(
    "makes Open terminal the primary and Rename the whole menu while %s",
    (state) => {
      expect(actionsOf({ state })).toEqual({
        primary: "open-terminal",
        menu: ["rename"],
      });
    },
  );

  it("makes Retry the primary and Rename the whole menu once it failed", () => {
    expect(actionsOf({ state: "failed" })).toEqual({
      primary: "retry",
      menu: ["rename"],
    });
  });
});

describe("sandbox row filters", () => {
  const agent = sandboxSummaryFixture({
    id: "a",
    displayName: "Agent Box",
    burst: true,
    state: "suspended",
    createdByTaskId: "task-77",
  });
  const mine = sandboxSummaryFixture({ id: "m", state: "awake" });

  it("counts the groups off their default", () => {
    expect(sandboxFilterCount(SANDBOX_ROW_FILTER_NONE)).toBe(0);
    expect(
      sandboxFilterCount({
        ...SANDBOX_ROW_FILTER_NONE,
        kind: "agent",
        state: "suspended",
        search: "x",
      }),
    ).toBe(2);
  });

  it("matches on kind, state, starter and the name or task search", () => {
    const only = (patch: Partial<typeof SANDBOX_ROW_FILTER_NONE>) =>
      [agent, mine]
        .filter((row) =>
          sandboxRowMatches(
            row,
            { ...SANDBOX_ROW_FILTER_NONE, ...patch },
            null,
          ),
        )
        .map((row) => row.id);
    expect(only({})).toEqual(["a", "m"]);
    expect(only({ kind: "agent" })).toEqual(["a"]);
    expect(only({ state: "awake" })).toEqual(["m"]);
    expect(only({ startedBy: "agent" })).toEqual(["a"]);
    expect(only({ search: " agent box " })).toEqual(["a"]);
    expect(only({ search: "TASK-77" })).toEqual(["a"]);
  });

  it("offers Destroy all idle for both idle states regardless of Kind", () => {
    const filter = { ...SANDBOX_ROW_FILTER_NONE };
    expect(sandboxDestroyAllIdleOffered(filter)).toBe(false);
    expect(sandboxDestroyAllIdleOffered({ ...filter, kind: "agent" })).toBe(
      false,
    );
    expect(
      sandboxDestroyAllIdleOffered({ ...filter, state: "suspended" }),
    ).toBe(true);
    expect(
      sandboxDestroyAllIdleOffered({
        ...filter,
        kind: "sandbox",
        state: "stopped",
      }),
    ).toBe(true);
  });
});

describe("sandboxSessionsLine and sandboxIdleRefusal", () => {
  it("never reads a zero without a report", () => {
    expect(sandboxSessionsLine({ kind: "unknown" }, NOW)).toBe(
      "Sessions unknown · no report yet",
    );
    expect(
      sandboxSessionsLine(
        liveSessionReport(
          {
            agents: [agentSessionFixture({})],
            terminals: [
              terminalSessionFixture({ sessionId: "t1" }),
              terminalSessionFixture({ sessionId: "t2" }),
              terminalSessionFixture({ sessionId: "t3" }),
            ],
          },
          true,
        ),
        NOW,
      ),
    ).toBe("4 sessions running");
    expect(
      sandboxSessionsLine({ kind: "stale", count: 4, at: NOW - 120_000 }, NOW),
    ).toMatch(/^Sessions as of /);
  });

  it("reads a stale report with no time as unknown, never an age since 1970", () => {
    expect(sandboxSessionsLine({ kind: "stale", count: 4, at: 0 }, NOW)).toBe(
      "Sessions unknown · no report yet",
    );
  });

  it("refuses an idle period under 2 minutes instead of clamping it", () => {
    expect(sandboxIdleRefusal(1)).toBe("At least 2 minutes.");
    expect(sandboxIdleRefusal(2)).toBeNull();
    expect(sandboxIdleRefusal(Number.NaN)).toBe("Enter a whole number.");
  });
});

describe("sandboxClockLine", () => {
  it("states the idle stop for an awake Automations row on its own period", () => {
    expect(
      sandboxClockLine({
        summary: sandboxSummaryFixture({
          state: "awake",
          kind: "automation",
          idleMinutes: 45,
        }),
        configuration: { kind: "personal" },
        cost: null,
        wakeString: null,
        viewerUserId: null,
        reachability: { unreachable: false, lastContactAt: null },
        now: NOW,
      }),
    ).toBe("stops after 45 idle min · files kept · the next shell starts it");
  });

  it.each(["released", "suspended", "stopped"] as const)(
    "reads a %s Automations row as suspended, files kept",
    (state) => {
      expect(
        sandboxClockLine({
          summary: sandboxSummaryFixture({ state, kind: "automation" }),
          configuration: { kind: "personal" },
          cost: null,
          wakeString: null,
          viewerUserId: null,
          reachability: { unreachable: false, lastContactAt: null },
          now: NOW,
        }),
      ).toBe("Suspended · files kept · the next shell starts it");
    },
  );

  it("reads an awake row whose settings did not apply as the one shared line", () => {
    expect(
      sandboxClockLine({
        summary: sandboxSummaryFixture({
          state: "awake",
          displayName: "Build box",
          guestConfigured: false,
          failureCode: "envelope-delivery:x",
        }),
        configuration: { kind: "personal" },
        cost: null,
        wakeString: null,
        viewerUserId: null,
        reachability: { unreachable: false, lastContactAt: null },
        now: NOW,
      }),
    ).toBe(
      "Build box is awake, but Personal's settings didn't apply · SBX-0520",
    );
  });

  describe("a failed row", () => {
    const failedLine = (failureCode: string | null) =>
      sandboxClockLine({
        summary: sandboxSummaryFixture({
          state: "failed",
          failureCode,
          lastTransitionAt: new Date(2026, 9, 25, 11, 1).getTime(),
        }),
        configuration: { kind: "personal" },
        cost: null,
        wakeString: null,
        viewerUserId: null,
        reachability: { unreachable: false, lastContactAt: null },
        now: NOW,
      });

    it("reads by its support reference, never its raw code", () => {
      const line = failedLine("create:kube-create-service-account");
      expect(line).toBe(
        "Couldn't start build-box at 11:01 · SBX-0412 · nothing was charged",
      );
    });

    it.each(["zzz", null])(
      "omits the support-reference segment cleanly for %s",
      (code) => {
        expect(failedLine(code)).toBe(
          "Couldn't start build-box at 11:01 · nothing was charged",
        );
      },
    );
  });

  it("copies the support reference with the sandbox id, or the id alone with none", () => {
    expect(sandboxSupportReferenceLine("create:x", "sbx_1")).toBe(
      "SBX-0412 · sbx_1",
    );
    expect(sandboxSupportReferenceLine("zzz", "sbx_1")).toBe("sbx_1");
  });

  it.each([false, true])(
    "reads the server's destroy before reachability or frozen=%s",
    (frozen) => {
      expect(
        sandboxClockLine({
          summary: sandboxSummaryFixture({ state: "destroying", frozen }),
          configuration: { kind: "personal" },
          cost: null,
          wakeString: null,
          viewerUserId: null,
          reachability: { unreachable: true, lastContactAt: NOW - 60_000 },
          now: NOW,
        }),
      ).toBe("Destroying · pending");
    },
  );

  it("names no last contact when the host has none on record (0)", () => {
    const line = (lastContactAt: number) =>
      sandboxClockLine({
        summary: sandboxSummaryFixture({ state: "awake" }),
        configuration: { kind: "personal" },
        cost: null,
        wakeString: null,
        viewerUserId: null,
        reachability: { unreachable: true, lastContactAt },
        now: NOW,
      });
    expect(line(0)).toBe("Running, but Traycer can't connect");
    expect(line(NOW - 360_000)).toMatch(/last contact 6 min ago$/);
  });
});

describe("a released sandbox's line in its chat", () => {
  it("says the released Automations row's own line with the sandbox as its subject", () => {
    const row = sandboxClockLine({
      summary: sandboxSummaryFixture({
        kind: "automation",
        displayName: "e2e-auto",
        state: "released",
      }),
      configuration: { kind: "personal" },
      cost: null,
      wakeString: null,
      viewerUserId: null,
      reachability: { unreachable: false, lastContactAt: null },
      now: NOW,
    });

    expect(sandboxReleasedChatLine("e2e-auto")).toBe(
      `e2e-auto is s${row.slice(1)}`,
    );
    expect(row).toBe("Suspended · files kept · the next shell starts it");
  });
});

describe("sandboxClockLine, a resting row", () => {
  // Local times, so the clock reads the same in any zone.
  const SINCE = new Date(2026, 9, 25, 9, 49).getTime();
  const DESTROY_AT = new Date(2026, 10, 1, 9, 49).getTime();
  const CLOCK_NOW = new Date(2026, 9, 25, 14, 0).getTime();
  const cost = (todayMillicredits: number): SandboxCost => ({
    sandboxId: "sbx-1",
    currentRateMillicreditsPerHour: 4,
    state: "suspended",
    frozen: false,
    charged: {
      computeMillicredits: 0,
      storageMillicredits: 0,
      sinceCreatedAt: SINCE,
    },
    pendingMillicredits: 0,
    segments: [],
    todayMillicredits,
    todayAwakeMs: null,
    history: [],
  });
  const line = (
    summary: Partial<SandboxSummary>,
    todayMillicredits: number,
  ): string =>
    sandboxClockLine({
      summary: sandboxSummaryFixture({
        state: "suspended",
        restingSince: SINCE,
        ...summary,
      }),
      configuration: { kind: "personal" },
      cost: cost(todayMillicredits),
      wakeString: "Suspend keeps memory",
      viewerUserId: null,
      reachability: { unreachable: false, lastContactAt: null },
      now: CLOCK_NOW,
    });

  it("promises the next wake and dates the destroy to the minute", () => {
    expect(line({ destroyAt: DESTROY_AT }, 50)).toBe(
      "Suspended since 09:49 · Suspend keeps memory · resumes on your next action · destroyed Nov 1 at 09:49 unless used · $0.05 today",
    );
  });

  it("leaves the destroy clause out until its date is known", () => {
    const waiting = line(
      { destroyAt: null, destroyAfterRestingMinutes: 10_080 },
      50,
    );
    expect(waiting).toBe(
      "Suspended since 09:49 · Suspend keeps memory · resumes on your next action · $0.05 today",
    );
    expect(waiting).not.toContain("kept until you destroy it");
  });

  it("says kept until you destroy it only for a row that rests forever", () => {
    expect(
      line({ destroyAt: null, destroyAfterRestingMinutes: null }, 50),
    ).toBe(
      "Suspended since 09:49 · Suspend keeps memory · resumes on your next action · kept until you destroy it · $0.05 today",
    );
  });

  it("dates a stopped row's destroy unless it is started", () => {
    expect(line({ state: "stopped", destroyAt: DESTROY_AT }, 0)).toBe(
      "Stopped since 09:49 · destroyed Nov 1 at 09:49 unless started",
    );
  });

  it("reads a day's cost below a cent as under $0.01", () => {
    expect(line({ destroyAt: DESTROY_AT }, 3)).toMatch(
      / · under \$0\.01 today$/,
    );
  });

  describe("across midnight", () => {
    // Tuesday 23:53, local.
    const TUESDAY_NIGHT = new Date(2026, 9, 27, 23, 53).getTime();
    const sinceAt = (now: number): string =>
      sandboxClockLine({
        summary: sandboxSummaryFixture({
          state: "suspended",
          restingSince: TUESDAY_NIGHT,
          destroyAt: null,
          destroyAfterRestingMinutes: null,
        }),
        configuration: { kind: "personal" },
        cost: cost(0),
        wakeString: "Suspend keeps memory",
        viewerUserId: null,
        reachability: { unreachable: false, lastContactAt: null },
        now,
      }).split(" · ")[0];

    it("keeps the clock time within the last 24 hours, past midnight", () => {
      expect(sinceAt(new Date(2026, 9, 28, 0, 0, 22).getTime())).toBe(
        "Suspended since 23:53",
      );
    });

    it("names the day with the time beyond 24 hours", () => {
      expect(sinceAt(new Date(2026, 9, 29, 0, 10).getTime())).toBe(
        "Suspended since Tue 23:53",
      );
    });

    it("dates it with the time from six days on", () => {
      expect(sinceAt(new Date(2026, 10, 3, 0, 10).getTime())).toBe(
        "Suspended since Oct 27 23:53",
      );
    });
  });
});

describe("sandboxFrozenClock", () => {
  it("dates the destroy to the minute, thirty days after the freeze", () => {
    const frozenAt = new Date(2026, 9, 9, 12, 0).getTime();
    const clock = sandboxFrozenClock(frozenAt);

    expect(clock).toMatch(
      /^Frozen sandboxes aren't destroyed on their idle schedule; this one is destroyed on [A-Z][a-z]{2} \d{1,2} at \d{2}:\d{2}\.$/,
    );
    expect(clock).toContain(
      formatSandboxDate(frozenAt + 30 * 24 * 60 * 60 * 1000, true),
    );
  });
});

describe("sandboxStartedByLabel", () => {
  const KEPT_AGENT_ROW = sandboxSummaryFixture({
    burst: false,
    createdByAgentId: "agent-1",
    createdBy: { userId: "u-priya", displayName: "Priya" },
    keptBy: { userId: "u-me", displayName: "Me" },
  });

  it("says an agent started a sandbox an agent created and someone kept", () => {
    expect(sandboxStartedByLabel(KEPT_AGENT_ROW, "u-me")).toBe(
      "Started by an agent",
    );
  });

  it("names the agent where the server names it to this viewer", () => {
    expect(
      sandboxStartedByLabel(
        { ...KEPT_AGENT_ROW, createdByAgentName: "Planner" },
        "u-me",
      ),
    ).toBe("Started by Planner");
  });

  it("still names the person who started a sandbox no agent created", () => {
    expect(
      sandboxStartedByLabel(
        sandboxSummaryFixture({
          burst: false,
          createdByAgentId: null,
          createdBy: { userId: "u-priya", displayName: "Priya" },
        }),
        "u-me",
      ),
    ).toBe("Started by Priya");
  });
});

describe("sandboxListHeader", () => {
  const rows = [sandboxSummaryFixture({ id: "sbx-1" })];

  it("reads a day's cost below a cent as under $0.01, never $0.00", () => {
    expect(
      sandboxListHeader({
        rows,
        unstartedAutomations: false,
        todayMc: 3,
        todayYoursMc: null,
      }),
    ).toBe("1 sandbox · under $0.01 today (UTC day)");
  });

  it("reads a cent or more in dollars", () => {
    expect(
      sandboxListHeader({
        rows,
        unstartedAutomations: false,
        todayMc: 20,
        todayYoursMc: null,
      }),
    ).toBe("1 sandbox · $0.02 today (UTC day)");
  });

  it("keeps the sandbox count beside Automations when there is one", () => {
    expect(
      sandboxListHeader({
        rows,
        unstartedAutomations: true,
        todayMc: null,
        todayYoursMc: null,
      }),
    ).toBe("1 sandbox and Automations");
  });
});

describe("sandboxRegionLabel", () => {
  it("renders the label the server sends, never the region id", () => {
    expect(
      sandboxRegionLabel(
        sandboxSummaryFixture({
          region: "us-west-3",
          regionLabel: "United States (West)",
        }),
      ),
    ).toBe("United States (West)");
  });

  it("is null for a row with no label or an empty one", () => {
    expect(
      sandboxRegionLabel(
        sandboxSummaryFixture({ region: "us-west-3", regionLabel: null }),
      ),
    ).toBeNull();
    expect(
      sandboxRegionLabel(
        sandboxSummaryFixture({ region: "us-west-3", regionLabel: "" }),
      ),
    ).toBeNull();
  });
});

describe("sandboxTodayCost", () => {
  const awake = sandboxSummaryFixture({ state: "awake" });

  it("says less than a cent in the first minute after a wake, never $0.00", () => {
    // $0.12 an hour for one minute is a fifth of a cent.
    expect(sandboxTodayCost(awake, null, 60_000)).toBe("under $0.01 so far");
  });

  it("reads a ledger's day below a cent as under $0.01 so far and a cent or more in dollars", () => {
    const cost = (todayMillicredits: number): SandboxCost => ({
      sandboxId: "sbx-1",
      currentRateMillicreditsPerHour: 120,
      state: "awake",
      frozen: false,
      charged: {
        computeMillicredits: 0,
        storageMillicredits: 0,
        sinceCreatedAt: NOW,
      },
      pendingMillicredits: 0,
      segments: [],
      todayMillicredits,
      todayAwakeMs: null,
      history: [],
    });
    expect(sandboxTodayCost(awake, cost(3), 0)).toBe("under $0.01 so far");
    expect(sandboxTodayCost(awake, cost(20), 0)).toBe("$0.02 today");
  });

  it("says the accrual once it reaches a cent", () => {
    expect(sandboxTodayCost(awake, null, 30 * 60_000)).toBe("$0.06 so far");
  });
});

describe("sandboxShapeAndCostLine, an agent sandbox", () => {
  const AGENT_ROW = {
    burst: true,
    createdByAgentId: "agent-1",
  } satisfies Partial<SandboxSummary>;
  const line = (overrides: Partial<SandboxSummary>): string =>
    sandboxShapeAndCostLine(
      sandboxSummaryFixture({ ...AGENT_ROW, ...overrides }),
      { kind: "personal" },
      "viewer",
    );

  it("names the agent and its task where the server names them to this viewer", () => {
    expect(
      line({
        createdByAgentName: "Planner",
        createdByTaskTitle: "Sandbox setup",
      }),
    ).toBe(
      "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake · created by Planner for Sandbox setup",
    );
  });

  it("names the agent alone when the task is not the viewer's to read", () => {
    expect(
      line({ createdByAgentName: "Planner", createdByTaskTitle: null }),
    ).toMatch(/ · \$0\.12 an hour while awake · created by Planner$/);
  });

  it("keeps the credits line where the server names no agent", () => {
    expect(line({ createdByAgentName: null })).not.toContain("created by");
  });
});

describe("a stopped row's clock, by who stopped it", () => {
  const SINCE = new Date(2026, 9, 25, 9, 49).getTime();
  const operation = (
    overrides: Partial<SandboxOperation>,
  ): SandboxOperation => ({
    at: SINCE,
    fromState: "awake",
    state: "stopped",
    cause: "verb",
    outcomeCause: "verb",
    outcomeDetail: null,
    actor: { userId: "u-me", displayName: "Me" },
    gesture: null,
    ...overrides,
  });
  const lead = (stopped: SandboxOperation | null): string =>
    sandboxClockLine({
      summary: sandboxSummaryFixture({
        state: "stopped",
        restingSince: SINCE,
        operation: stopped,
      }),
      configuration: { kind: "personal" },
      cost: null,
      wakeString: null,
      viewerUserId: "u-me",
      reachability: { unreachable: false, lastContactAt: null },
      now: new Date(2026, 9, 25, 14, 0).getTime(),
    }).split(" since ")[0];

  it("says Stopped by you for the viewer's own stop, and by the member's name for another's", () => {
    expect(lead(operation({}))).toBe("Stopped by you");
    expect(
      lead(operation({ actor: { userId: "u-priya", displayName: "Priya" } })),
    ).toBe("Stopped by Priya");
  });

  it("says Stopped after a failed wake for a wake rolled back to stopped", () => {
    expect(
      lead(operation({ cause: "wake", outcomeCause: "failure", actor: null })),
    ).toBe("Stopped after a failed wake");
  });

  it("says Stopped for the system's own stop or a row no operation has moved", () => {
    expect(lead(operation({ actor: null, cause: "idle" }))).toBe("Stopped");
    expect(lead(null)).toBe("Stopped");
  });
});

describe("the sessions list as pills", () => {
  it("names a terminal agent not renamed Terminal agent, and a chat the host sends no name for Agent", () => {
    const chat = agentSessionFixture({ sessionId: "c1", name: null });
    const terminalAgent = agentSessionFixture({
      kind: "terminal-agent",
      sessionId: "ta1",
      name: null,
    });
    expect(sandboxAgentSessionName(chat)).toBeNull();
    expect(sandboxAgentSessionName(terminalAgent)).toBe("Terminal agent");
    expect(
      sandboxAgentSessionName(agentSessionFixture({ name: "Planner" })),
    ).toBe("Planner");
    expect(
      sandboxSessionPills(
        liveSessionReport(
          { agents: [chat, terminalAgent], terminals: [] },
          false,
        ),
      ).map((pill) => pill.label),
    ).toEqual(["Agent", "Terminal agent"]);
  });

  it("lists agents first, marks an agent mid-turn as working, and gives a terminal its name or Terminal", () => {
    expect(
      sandboxSessionPills(
        liveSessionReport(
          {
            agents: [
              agentSessionFixture({
                sessionId: "c1",
                name: "Planner",
                working: true,
              }),
            ],
            terminals: [
              terminalSessionFixture({ sessionId: "t1", name: null }),
              terminalSessionFixture({ sessionId: "t2", name: "build" }),
            ],
          },
          true,
        ),
      ),
    ).toEqual([
      { key: "agent:c1", label: "Planner", working: true },
      { key: "terminal:t1", label: "Terminal", working: false },
      { key: "terminal:t2", label: "build", working: false },
    ]);
  });

  it("has no pills without a live list", () => {
    expect(sandboxSessionPills({ kind: "unknown" })).toEqual([]);
    expect(sandboxSessionPills({ kind: "stale", count: 2, at: 1_000 })).toEqual(
      [],
    );
  });
});

describe("sandboxClockLine, an awake row's day from the ledger", () => {
  const cost = (
    todayMillicredits: number,
    todayAwakeMs: number | null,
  ): SandboxCost => ({
    sandboxId: "sbx-1",
    currentRateMillicreditsPerHour: 120,
    state: "awake",
    frozen: false,
    charged: {
      computeMillicredits: 0,
      storageMillicredits: 0,
      sinceCreatedAt: NOW,
    },
    pendingMillicredits: 0,
    segments: [],
    todayMillicredits,
    todayAwakeMs,
    history: [],
  });
  const line = (ledger: SandboxCost): string =>
    sandboxClockLine({
      summary: sandboxSummaryFixture({
        state: "awake",
        burst: false,
        lastTransitionAt: NOW - 60_000,
      }),
      configuration: { kind: "personal" },
      cost: ledger,
      wakeString: null,
      viewerUserId: null,
      reachability: { unreachable: false, lastContactAt: null },
      now: NOW,
    });

  it("reads the ledger's awake time, not the time since the last wake, beside the day's cost", () => {
    const text = line(cost(300, 3_600_000));

    expect(text).toContain("Awake 1 h today");
    expect(text).toContain("$0.30 today");
  });

  it("an older server's null duration hides the duration, never the wake's age labelled today, and keeps the label and the cost", () => {
    expect(line(cost(300, null))).toBe(
      "Awake · $0.30 today · suspends after 30 idle min",
    );
  });
});

describe("team payer copy", () => {
  const team: SandboxPageConfiguration = {
    kind: "team",
    teamId: "team-a",
    teamName: "Acme",
    environmentId: null,
  };
  const summary = sandboxSummaryFixture({
    state: "awake",
    wakePayer: { userId: "payer", displayName: "Priya" },
    priceMcPerHour: { awakeMc: 210, suspendedMc: 1, stoppedMc: 1 },
  });
  it("claims the viewer's credits only for the payer", () => {
    expect(sandboxShapeAndCostLine(summary, team, "payer")).toBe(
      "Linux · 2 vCPU · 4 GB · $0.21 an hour while awake · uses your Acme credits",
    );
    expect(sandboxShapeAndCostLine(summary, team, "other")).toBe(
      "Linux · 2 vCPU · 4 GB · $0.21 an hour while awake",
    );
    expect(sandboxPaidByLabel(summary, team, "other")).toBe("Paid by Priya");
    expect(sandboxPaidByLabel(summary, team, "payer")).toBe("Paid by you");
  });
  it("warns a non-payer before a resting sandbox is woken", () => {
    expect(
      sandboxShapeAndCostLine(
        { ...summary, state: "suspended" },
        team,
        "other",
      ),
    ).toBe(
      "Linux · 2 vCPU · 4 GB · $0.21 an hour while awake · waking it makes you the payer",
    );
  });
  it("keeps the incumbent payer's cost line when it rests", () => {
    expect(
      sandboxShapeAndCostLine(
        { ...summary, state: "suspended" },
        team,
        "payer",
      ),
    ).toBe(
      "Linux · 2 vCPU · 4 GB · $0.21 an hour while awake · uses your Acme credits",
    );
  });
  describe("an agent-created team row", () => {
    const WARNING = "waking it makes you the payer";
    const CREATOR = "created by Planner for Sandbox setup";
    const agentRow = (overrides: Partial<SandboxSummary>): SandboxSummary => ({
      ...summary,
      burst: true,
      createdByAgentId: "agent-1",
      createdByAgentName: "Planner",
      createdByTaskTitle: "Sandbox setup",
      ...overrides,
    });

    it.each(["suspended", "stopped"] as const)(
      "warns a non-payer before a %s row is woken and keeps the creator beside it",
      (state) => {
        const text = sandboxShapeAndCostLine(
          agentRow({ state }),
          team,
          "other",
        );

        expect(text).toContain(WARNING);
        expect(text).toContain(CREATOR);
        expect(text).toContain("$0.21 an hour while awake");
      },
    );

    it("does not warn the current payer, an awake row, or a personal row, and still names the creator", () => {
      const resting = agentRow({ state: "suspended" });

      for (const text of [
        sandboxShapeAndCostLine(resting, team, "payer"),
        sandboxShapeAndCostLine(agentRow({ state: "awake" }), team, "other"),
        sandboxShapeAndCostLine(resting, { kind: "personal" }, "other"),
      ]) {
        expect(text).not.toContain(WARNING);
        expect(text).toContain(CREATOR);
      }
    });
  });
  describe("a resting team row the server does not price", () => {
    const SHAPE = "Linux · 2 vCPU · 4 GB";
    const unpriced = (overrides: Partial<SandboxSummary>): SandboxSummary => ({
      ...summary,
      priceMcPerHour: null,
      ...overrides,
    });

    it("warns a non-payer without inventing a rate, and keeps the named creator beside it", () => {
      expect(
        sandboxShapeAndCostLine(
          unpriced({
            state: "suspended",
            burst: true,
            createdByAgentId: "agent-1",
            createdByAgentName: "Planner",
            createdByTaskTitle: "Sandbox setup",
          }),
          team,
          "other",
        ),
      ).toBe(
        `${SHAPE} · waking it makes you the payer · created by Planner for Sandbox setup`,
      );
    });

    it("warns a non-payer on a row no agent created, with nothing else", () => {
      expect(
        sandboxShapeAndCostLine(unpriced({ state: "stopped" }), team, "other"),
      ).toBe(`${SHAPE} · waking it makes you the payer`);
    });

    it("leaves the current payer, an awake row and a personal row at the bare shape", () => {
      const resting = unpriced({ state: "suspended" });

      expect(sandboxShapeAndCostLine(resting, team, "payer")).toBe(SHAPE);
      expect(
        sandboxShapeAndCostLine(unpriced({ state: "awake" }), team, "other"),
      ).toBe(SHAPE);
      expect(
        sandboxShapeAndCostLine(resting, { kind: "personal" }, "other"),
      ).toBe(SHAPE);
    });
  });
  it("never substitutes a member for an unavailable payer name", () => {
    expect(
      sandboxPaidByLabel(
        { ...summary, wakePayer: { userId: "payer", displayName: null } },
        team,
        "other",
      ),
    ).toBeNull();
  });
});
