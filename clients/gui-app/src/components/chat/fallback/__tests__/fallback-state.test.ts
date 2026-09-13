import { describe, expect, it } from "vitest";
import { pendingFallbackStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  fallbackComposerCardVisible,
  fallbackGraceCardVisible,
  fallbackWaitingCardVisible,
} from "@/components/chat/fallback/fallback-state";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
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
