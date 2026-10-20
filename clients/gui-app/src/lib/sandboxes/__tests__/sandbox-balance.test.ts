import { describe, expect, it } from "vitest";
import type { SandboxCost } from "@traycer/protocol/host/sandbox-control";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "./auth-user-fixture";
import {
  formatRunway,
  frozenDestroyAt,
  sandboxBalanceMc,
  sandboxCostTodayMc,
  sandboxRunwayMinutes,
  sandboxRunwayWarning,
} from "@/lib/sandboxes/sandbox-balance";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("sandboxBalanceMc", () => {
  it("is null until a user has loaded", () => {
    expect(sandboxBalanceMc(null)).toBeNull();
  });

  it("sums the PERSONAL subscription's remaining plan, bonus and bundle credits, in millicredits", () => {
    const user = userWith(
      userSubscription({
        totalPlanCredits: 100,
        consumedFromPlan: 40,
        bonusCredits: 10,
        consumedFromBonus: 4,
        bundleRemaining: 5,
      }),
      [],
    );
    // 60 plan + 6 bonus + 5 bundle = 71 credits.
    expect(sandboxBalanceMc(user)).toBe(71_000);
  });

  it("ignores a team subscription however large: sandboxes are charged to the personal account", () => {
    const user = userWith(
      userSubscription({
        totalPlanCredits: 10,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [teamSubscription(5_000_000)],
    );
    expect(sandboxBalanceMc(user)).toBe(10_000);
  });

  it("clamps an overspent balance to zero rather than going negative", () => {
    const user = userWith(
      userSubscription({
        totalPlanCredits: 10,
        consumedFromPlan: 10,
        bonusCredits: 2,
        consumedFromBonus: 9,
        bundleRemaining: 0,
      }),
      [],
    );
    expect(sandboxBalanceMc(user)).toBe(0);
  });

  it("floors a fractional credit balance to whole millicredits", () => {
    const user = userWith(
      userSubscription({
        totalPlanCredits: 1,
        consumedFromPlan: 0.0004,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [],
    );
    expect(sandboxBalanceMc(user)).toBe(999);
  });
});

describe("sandboxRunwayWarning boundaries at 120 mc per hour", () => {
  const BURN = 120;

  it("is none at 240 mc (two hours) and low one millicredit under it", () => {
    expect(sandboxRunwayWarning(240, BURN)).toEqual({ kind: "none" });
    expect(sandboxRunwayWarning(239, BURN)).toEqual({
      kind: "low",
      runwayMinutes: 119,
    });
  });

  it("is low at 60 mc (thirty minutes) and critical one millicredit under it", () => {
    expect(sandboxRunwayWarning(60, BURN)).toEqual({
      kind: "low",
      runwayMinutes: 30,
    });
    expect(sandboxRunwayWarning(59, BURN)).toEqual({
      kind: "critical",
      runwayMinutes: 29,
    });
  });

  it("gives none when nothing is burning, whatever the balance", () => {
    expect(sandboxRunwayWarning(0, 0)).toEqual({ kind: "none" });
    expect(sandboxRunwayWarning(10, 0)).toEqual({ kind: "none" });
  });

  it("gives none while the balance or the burn is unknown", () => {
    expect(sandboxRunwayWarning(null, BURN)).toEqual({ kind: "none" });
    expect(sandboxRunwayWarning(10, null)).toEqual({ kind: "none" });
    expect(sandboxRunwayWarning(null, null)).toEqual({ kind: "none" });
  });

  it("is critical with no runway left at a zero balance", () => {
    expect(sandboxRunwayWarning(0, BURN)).toEqual({
      kind: "critical",
      runwayMinutes: 0,
    });
  });

  it("reads a negative balance as already out: critical, and worded as under a minute", () => {
    const warning = sandboxRunwayWarning(-100, BURN);
    expect(warning.kind).toBe("critical");
    if (warning.kind !== "none") {
      expect(formatRunway(warning.runwayMinutes)).toBe("under a minute");
    }
  });
});

describe("sandboxRunwayMinutes / formatRunway", () => {
  it("is null with no burn and whole minutes otherwise", () => {
    expect(sandboxRunwayMinutes(1000, 0)).toBeNull();
    expect(sandboxRunwayMinutes(1000, 120)).toBe(500);
  });

  it("words minutes, hours and the sub-minute case", () => {
    expect(formatRunway(0)).toBe("under a minute");
    expect(formatRunway(25)).toBe("25 min");
    expect(formatRunway(60)).toBe("1 h");
    expect(formatRunway(100)).toBe("1 h 40 min");
  });
});

describe("frozenDestroyAt", () => {
  it("is thirty days after the freeze", () => {
    expect(frozenDestroyAt(1_000)).toBe(1_000 + 30 * DAY_MS);
  });
});

describe("sandboxCostTodayMc", () => {
  // Local time on purpose: "today" is the user's local midnight.
  const now = new Date(2026, 9, 9, 12, 0, 0, 0).getTime();
  const midnight = new Date(2026, 9, 9, 0, 0, 0, 0).getTime();
  const HOUR = 60 * 60 * 1000;

  function costWith(segments: SandboxCost["segments"]): SandboxCost {
    return {
      sandboxId: "sbx_1",
      currentRateMillicreditsPerHour: 120,
      state: "awake",
      frozen: false,
      charged: {
        computeMillicredits: 0,
        storageMillicredits: 0,
        sinceCreatedAt: midnight - 3 * DAY_MS,
      },
      pendingMillicredits: 0,
      segments,
    };
  }

  it("prorates a segment that crosses local midnight by the share after it", () => {
    // 23:00 yesterday to 03:00 today, 400 mc: three of its four hours are today.
    const cost = costWith([
      {
        state: "awake",
        fromAt: midnight - HOUR,
        toAt: midnight + 3 * HOUR,
        millicredits: 400,
      },
    ]);
    expect(sandboxCostTodayMc(cost, now)).toBe(300);
  });

  it("counts a segment wholly after midnight in full and one wholly before it not at all", () => {
    const cost = costWith([
      {
        state: "awake",
        fromAt: midnight - 5 * HOUR,
        toAt: midnight - 3 * HOUR,
        millicredits: 999,
      },
      {
        state: "awake",
        fromAt: midnight + HOUR,
        toAt: midnight + 2 * HOUR,
        millicredits: 120,
      },
      {
        state: "suspended",
        fromAt: midnight + 2 * HOUR,
        toAt: midnight + 6 * HOUR,
        millicredits: 8,
      },
    ]);
    expect(sandboxCostTodayMc(cost, now)).toBe(128);
  });

  it("counts a segment that ends exactly at midnight as yesterday's", () => {
    const cost = costWith([
      {
        state: "awake",
        fromAt: midnight - HOUR,
        toAt: midnight,
        millicredits: 120,
      },
    ]);
    expect(sandboxCostTodayMc(cost, now)).toBe(0);
  });

  it("rounds the prorated share to whole millicredits", () => {
    const cost = costWith([
      {
        state: "awake",
        fromAt: midnight - 2 * HOUR,
        toAt: midnight + HOUR,
        millicredits: 100,
      },
    ]);
    // One third of 100 mc.
    expect(sandboxCostTodayMc(cost, now)).toBe(33);
  });

  it("is zero for an empty ledger", () => {
    expect(sandboxCostTodayMc(costWith([]), now)).toBe(0);
  });
});
