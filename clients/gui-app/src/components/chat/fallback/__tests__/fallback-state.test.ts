import { describe, expect, it } from "vitest";
import { pendingFallbackStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  fallbackComposerCardVisible,
  fallbackGraceCardVisible,
  fallbackWaitingCardVisible,
  routingCountdownPlan,
} from "@/components/chat/fallback/fallback-state";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  fallbackImpendingAction,
  pendingFallback,
} from "./fallback-fixtures";

function pendingAt(state: (typeof pendingFallbackStateSchema.options)[number]) {
  return pendingFallback({
    state,
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: 1_700_000_000_000,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 0,
    siblingSwitching: 0,
    traversalId: "traversal-state",
    revision: 1,
  });
}

describe("fallback card visibility", () => {
  it("claims hold/choosing/switching for the grace card and only waiting for the waiting card", () => {
    const graceStates: string[] = [];
    const waitingStates: string[] = [];
    for (const state of pendingFallbackStateSchema.options) {
      const pending = pendingAt(state);
      if (fallbackGraceCardVisible(pending)) graceStates.push(state);
      if (fallbackWaitingCardVisible(pending)) waitingStates.push(state);
    }
    expect(graceStates).toEqual(["hold", "choosing", "switching"]);
    expect(waitingStates).toEqual(["waiting"]);
  });

  it("treats the two card predicates as disjoint and leaves retrying unclaimed", () => {
    const claimed = new Set<string>();
    for (const state of pendingFallbackStateSchema.options) {
      const pending = pendingAt(state);
      const grace = fallbackGraceCardVisible(pending);
      const waiting = fallbackWaitingCardVisible(pending);
      expect(grace && waiting).toBe(false);
      if (grace || waiting) claimed.add(state);
    }
    expect(claimed.has("retrying")).toBe(false);
    expect(fallbackGraceCardVisible(undefined)).toBe(false);
    expect(fallbackWaitingCardVisible(undefined)).toBe(false);
    expect(fallbackComposerCardVisible(undefined)).toBe(false);
    expect(fallbackComposerCardVisible(pendingAt("retrying"))).toBe(false);
    expect(fallbackComposerCardVisible(pendingAt("hold"))).toBe(true);
    expect(fallbackComposerCardVisible(pendingAt("waiting"))).toBe(true);
  });
});

/**
 * A frame with the host's plan spelled out: the committed target and the
 * impending action are the only two things `routingCountdownPlan` reads.
 */
function frame(input: {
  readonly state: (typeof pendingFallbackStateSchema.options)[number];
  readonly targetTuple: typeof TARGET_CODEX_TUPLE | null;
  readonly impending: Parameters<typeof fallbackImpendingAction>[0] | null;
}) {
  return pendingFallback({
    state: input.state,
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: input.targetTuple,
    impendingAction:
      input.impending === null
        ? null
        : fallbackImpendingAction(input.impending),
    deadline: 1_700_000_000_000,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 0,
    siblingSwitching: 0,
    traversalId: "traversal-plan",
    revision: 1,
  });
}

function impendingOf(
  rung: "retry" | "profile" | "tier" | "wait" | "notify",
  overrides: {
    readonly target: typeof TARGET_CODEX_TUPLE | null;
    readonly resumesAt: number | null;
    readonly pending: "resolving" | "awaiting_reset_check" | null;
  },
) {
  return {
    planId: `plan-${rung}`,
    rung,
    target: overrides.target,
    targetModelFamily: null,
    resumesAt: overrides.resumesAt,
    pending: overrides.pending,
  };
}

const NO_OVERRIDES = { target: null, resumesAt: null, pending: null } as const;

describe("routingCountdownPlan", () => {
  it("names a switch when a destination is committed and there is no impending action", () => {
    expect(
      routingCountdownPlan(
        frame({
          state: "hold",
          targetTuple: TARGET_CODEX_TUPLE,
          impending: null,
        }),
      ),
    ).toEqual({ kind: "switch", destination: TARGET_CODEX_TUPLE });
  });

  it("names nothing when there is neither a destination nor an impending action", () => {
    expect(
      routingCountdownPlan(
        frame({ state: "hold", targetTuple: null, impending: null }),
      ),
    ).toEqual({ kind: "nothing" });
  });

  it("names a resume when the destination IS the tuple that failed", () => {
    expect(
      routingCountdownPlan(
        frame({
          state: "switching",
          targetTuple: FAILED_CLAUDE_TUPLE,
          impending: null,
        }),
      ),
    ).toEqual({ kind: "resume" });
    // The prediction counts as the destination too, and beats the rung.
    expect(
      routingCountdownPlan(
        frame({
          state: "hold",
          targetTuple: null,
          impending: impendingOf("wait", {
            ...NO_OVERRIDES,
            target: FAILED_CLAUDE_TUPLE,
          }),
        }),
      ),
    ).toEqual({ kind: "resume" });
  });

  it("is deciding while the host has not resolved the plan, whatever the rung", () => {
    for (const pending of ["resolving", "awaiting_reset_check"] as const) {
      expect(
        routingCountdownPlan(
          frame({
            state: "hold",
            targetTuple: null,
            impending: impendingOf("profile", { ...NO_OVERRIDES, pending }),
          }),
        ),
      ).toEqual({ kind: "deciding" });
    }
  });

  it("carries the reset time of a wait plan, or null when none is verified", () => {
    expect(
      routingCountdownPlan(
        frame({
          state: "hold",
          targetTuple: null,
          impending: impendingOf("wait", {
            ...NO_OVERRIDES,
            resumesAt: 1_700_003_600_000,
          }),
        }),
      ),
    ).toEqual({ kind: "wait", resumesAt: 1_700_003_600_000 });
    expect(
      routingCountdownPlan(
        frame({
          state: "hold",
          targetTuple: null,
          impending: impendingOf("wait", NO_OVERRIDES),
        }),
      ),
    ).toEqual({ kind: "wait", resumesAt: null });
  });

  it("has no retry plan: a retry rung reads as deciding, never a card offering Retry now", () => {
    expect(
      routingCountdownPlan(
        frame({
          state: "hold",
          targetTuple: null,
          impending: impendingOf("retry", NO_OVERRIDES),
        }),
      ),
    ).toEqual({ kind: "deciding" });
  });

  it("names nothing for a notify rung", () => {
    expect(
      routingCountdownPlan(
        frame({
          state: "hold",
          targetTuple: null,
          impending: impendingOf("notify", NO_OVERRIDES),
        }),
      ),
    ).toEqual({ kind: "nothing" });
  });

  it("names a switch for a profile or tier rung with a target, deciding without one", () => {
    for (const rung of ["profile", "tier"] as const) {
      expect(
        routingCountdownPlan(
          frame({
            state: "hold",
            targetTuple: null,
            impending: impendingOf(rung, {
              ...NO_OVERRIDES,
              target: TARGET_CODEX_TUPLE,
            }),
          }),
        ),
      ).toEqual({ kind: "switch", destination: TARGET_CODEX_TUPLE });
      expect(
        routingCountdownPlan(
          frame({
            state: "hold",
            targetTuple: null,
            impending: impendingOf(rung, NO_OVERRIDES),
          }),
        ),
      ).toEqual({ kind: "deciding" });
    }
  });

  it("prefers the committed target over the host's prediction", () => {
    expect(
      routingCountdownPlan(
        frame({
          state: "hold",
          targetTuple: TARGET_CODEX_TUPLE,
          impending: impendingOf("profile", {
            ...NO_OVERRIDES,
            target: FAILED_CLAUDE_TUPLE,
          }),
        }),
      ),
    ).toEqual({ kind: "switch", destination: TARGET_CODEX_TUPLE });
  });
});

describe("fallbackGraceCardVisible with nothing to try", () => {
  it("hides the countdown card once the plan is nothing, in every countdown state but switching", () => {
    for (const state of ["hold", "choosing"] as const) {
      expect(
        fallbackGraceCardVisible(
          frame({ state, targetTuple: null, impending: null }),
        ),
      ).toBe(false);
      expect(
        fallbackGraceCardVisible(
          frame({
            state,
            targetTuple: null,
            impending: impendingOf("notify", NO_OVERRIDES),
          }),
        ),
      ).toBe(false);
    }
  });

  it("keeps the card for switching whatever the plan: it has committed", () => {
    expect(
      fallbackGraceCardVisible(
        frame({ state: "switching", targetTuple: null, impending: null }),
      ),
    ).toBe(true);
  });

  it("shows the card for a countdown that has a plan or is still deciding", () => {
    expect(
      fallbackGraceCardVisible(
        frame({
          state: "hold",
          targetTuple: TARGET_CODEX_TUPLE,
          impending: null,
        }),
      ),
    ).toBe(true);
    expect(
      fallbackGraceCardVisible(
        frame({
          state: "hold",
          targetTuple: null,
          impending: impendingOf("tier", {
            ...NO_OVERRIDES,
            pending: "resolving",
          }),
        }),
      ),
    ).toBe(true);
  });
});
