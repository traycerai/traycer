import { describe, expect, it } from "vitest";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  SANDBOX_ROW_FILTER_NONE,
  sandboxClockLine,
  sandboxDestroyAllIdleOffered,
  sandboxFilterCount,
  sandboxIdleRefusal,
  sandboxRowActions,
  sandboxRowMatches,
  sandboxSessionsLine,
  type SandboxRowAction,
  sandboxTodayCost,
} from "@/lib/sandboxes/sandbox-row-lines";
import { LESS_THAN_A_CENT_SO_FAR } from "@/lib/sandboxes/sandbox-strings";

const NOW = 1_791_100_000_000;

interface MatrixCase {
  readonly name: string;
  readonly summary: Partial<SandboxSummary>;
  readonly unreachable: boolean;
  readonly frozenNeedsOwnCredits: boolean;
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
    primary: "suspend",
    menu: AWAKE_MENU,
  },
  {
    // It destroys itself when idle: no Idle settings until it is kept.
    name: "awake agent",
    summary: { state: "awake", burst: true },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    primary: "keep",
    menu: AWAKE_MENU.filter((action) => action !== "idle-settings"),
  },
  {
    name: "stopped agent",
    summary: { state: "stopped", burst: true },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    primary: "start",
    menu: ["rename", "destroy"],
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
    primary: "suspend",
    menu: AWAKE_MENU,
  },
  {
    name: "suspended",
    summary: { state: "suspended" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    primary: "resume",
    menu: ["open-tab", "open-terminal", "rename", "idle-settings", "destroy"],
  },
  {
    name: "stopped",
    summary: { state: "stopped" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    primary: "start",
    menu: ["rename", "idle-settings", "destroy"],
  },
  {
    name: "frozen",
    summary: { state: "suspended", frozen: true },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    primary: "resume-paying",
    menu: ["rename", "destroy"],
  },
  {
    name: "frozen, viewer's own credits short",
    summary: { state: "suspended", frozen: true },
    unreachable: false,
    frozenNeedsOwnCredits: true,
    primary: "add-credits",
    menu: ["rename", "destroy"],
  },
  {
    name: "failed",
    summary: { state: "failed" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    primary: "retry",
    menu: ["destroy"],
  },
  {
    // Its Retry would create a kept sandbox in place of the agent's.
    name: "failed agent",
    summary: { state: "failed", burst: true },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    primary: null,
    menu: ["destroy"],
  },
  {
    name: "awake but unreachable",
    summary: { state: "awake" },
    unreachable: true,
    frozenNeedsOwnCredits: false,
    primary: "stop",
    menu: ["rename", "destroy"],
  },
  {
    name: "awake, settings did not apply",
    summary: { state: "awake", guestConfigured: false },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    primary: "retry-applying",
    menu: ["open-terminal", "rename", "stop", "destroy"],
  },
  {
    name: "automations",
    summary: { state: "awake", kind: "automation" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    primary: null,
    menu: ["rename"],
  },
  {
    name: "suspending",
    summary: { state: "suspending" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
    primary: null,
    menu: ["destroy"],
  },
  {
    name: "resuming",
    summary: { state: "resuming" },
    unreachable: false,
    frozenNeedsOwnCredits: false,
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
      }),
    ).toEqual({ primary: row.primary, menu: row.menu });
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

  it("offers Destroy all idle only for exactly Agent sandboxes + Suspended", () => {
    const filter = { ...SANDBOX_ROW_FILTER_NONE };
    expect(sandboxDestroyAllIdleOffered(filter)).toBe(false);
    expect(sandboxDestroyAllIdleOffered({ ...filter, kind: "agent" })).toBe(
      false,
    );
    expect(
      sandboxDestroyAllIdleOffered({
        ...filter,
        kind: "agent",
        state: "suspended",
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
      sandboxSessionsLine({ kind: "live", count: 4, busy: true }, NOW),
    ).toBe("4 sessions running");
    expect(
      sandboxSessionsLine({ kind: "stale", count: 4, at: NOW - 120_000 }, NOW),
    ).toMatch(/^Sessions as of /);
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
});

describe("sandboxTodayCost", () => {
  const awake = sandboxSummaryFixture({ state: "awake" });

  it("says less than a cent in the first minute after a wake, never $0.00", () => {
    // $0.12 an hour for one minute is a fifth of a cent.
    expect(sandboxTodayCost(awake, null, 60_000)).toBe(LESS_THAN_A_CENT_SO_FAR);
  });

  it("says the accrual once it reaches a cent", () => {
    expect(sandboxTodayCost(awake, null, 30 * 60_000)).toBe("$0.06 so far");
  });
});
