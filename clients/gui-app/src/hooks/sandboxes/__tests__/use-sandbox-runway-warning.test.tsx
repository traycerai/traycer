import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { UserSandboxCost } from "@traycer/protocol/host/sandbox-control";
import {
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";

const mocks = vi.hoisted(() => ({
  user: null as AuthenticatedUser | null,
  costs: null as UserSandboxCost | null,
}));

vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: mocks.user }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: mocks.costs }),
}));

import { useSandboxRunwayWarning } from "@/hooks/sandboxes/use-sandbox-runway-warning";

function userWithCredits(credits: number): AuthenticatedUser {
  return userWith(
    userSubscription({
      totalPlanCredits: credits,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 0,
    }),
    [],
  );
}

function burning(mcPerHour: number): UserSandboxCost {
  return { sandboxes: [], awakeBurnMillicreditsPerHour: mcPerHour };
}

beforeEach(() => {
  mocks.user = null;
  mocks.costs = null;
});
afterEach(cleanup);

describe("useSandboxRunwayWarning", () => {
  it("is none until both the credits and the cost view have answered", () => {
    expect(renderHook(() => useSandboxRunwayWarning()).result.current).toEqual({
      kind: "none",
    });
    mocks.user = userWithCredits(0.1);
    expect(renderHook(() => useSandboxRunwayWarning()).result.current).toEqual({
      kind: "none",
    });
    mocks.user = null;
    mocks.costs = burning(120);
    expect(renderHook(() => useSandboxRunwayWarning()).result.current).toEqual({
      kind: "none",
    });
  });

  it("divides the personal balance by the awake burn", () => {
    // 0.1 credit = 100 mc; at 120 mc/h that is 50 minutes.
    mocks.user = userWithCredits(0.1);
    mocks.costs = burning(120);
    expect(renderHook(() => useSandboxRunwayWarning()).result.current).toEqual({
      kind: "low",
      runwayMinutes: 50,
    });

    // 0.05 credit = 50 mc: 25 minutes.
    mocks.user = userWithCredits(0.05);
    expect(renderHook(() => useSandboxRunwayWarning()).result.current).toEqual({
      kind: "critical",
      runwayMinutes: 25,
    });
  });

  it("is none when nothing is burning", () => {
    mocks.user = userWithCredits(0.01);
    mocks.costs = burning(0);
    expect(renderHook(() => useSandboxRunwayWarning()).result.current).toEqual({
      kind: "none",
    });
  });
});
