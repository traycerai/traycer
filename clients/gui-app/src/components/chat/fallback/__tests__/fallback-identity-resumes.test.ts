import { describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { pendingFallbackResumesFailedTuple } from "@/components/chat/fallback/fallback-identity";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  chatRunSettings,
  fallbackImpendingAction,
  pendingFallback,
} from "./fallback-fixtures";

function pendingWithDestination(input: {
  readonly targetTuple: ChatRunSettings | null;
  readonly planTarget: ChatRunSettings | null;
}) {
  return pendingFallback({
    state: "switching",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: input.targetTuple,
    impendingAction:
      input.planTarget === null
        ? null
        : fallbackImpendingAction({
            planId: "plan-wait-resume",
            rung: "wait",
            target: input.planTarget,
            targetModelFamily: null,
            resumesAt: null,
            pending: null,
          }),
    deadline: null,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 0,
    siblingSwitching: 0,
    traversalId: "traversal-resumes",
    revision: 1,
  });
}

describe("pendingFallbackResumesFailedTuple", () => {
  it("is true when the committed destination is the exact failed tuple", () => {
    expect(
      pendingFallbackResumesFailedTuple(
        pendingWithDestination({
          targetTuple: FAILED_CLAUDE_TUPLE,
          planTarget: null,
        }),
      ),
    ).toBe(true);
  });

  it("is true when only the plan (not yet committed) names the failed tuple", () => {
    expect(
      pendingFallbackResumesFailedTuple(
        pendingWithDestination({
          targetTuple: null,
          planTarget: FAILED_CLAUDE_TUPLE,
        }),
      ),
    ).toBe(true);
  });

  // The triple this rule tests is harnessId/model/profileId - the same one
  // the host's restamps select by - so a difference OUTSIDE that triple must
  // not read as a move.
  it("is true when the destination differs from the failed tuple only in effort", () => {
    const resumedWithDifferentEffort: ChatRunSettings = {
      ...FAILED_CLAUDE_TUPLE,
      reasoningEffort: "high",
    };
    expect(
      pendingFallbackResumesFailedTuple(
        pendingWithDestination({
          targetTuple: resumedWithDifferentEffort,
          planTarget: null,
        }),
      ),
    ).toBe(true);
  });

  it("is false when the destination's harness differs from the failed tuple", () => {
    const differentHarness = chatRunSettings({
      harnessId: "codex",
      model: FAILED_CLAUDE_TUPLE.model,
      profileId: FAILED_CLAUDE_TUPLE.profileId,
    });
    expect(
      pendingFallbackResumesFailedTuple(
        pendingWithDestination({
          targetTuple: differentHarness,
          planTarget: null,
        }),
      ),
    ).toBe(false);
  });

  it("is false when the destination's model differs from the failed tuple", () => {
    const differentModel = chatRunSettings({
      harnessId: FAILED_CLAUDE_TUPLE.harnessId,
      model: "claude-opus-5",
      profileId: FAILED_CLAUDE_TUPLE.profileId,
    });
    expect(
      pendingFallbackResumesFailedTuple(
        pendingWithDestination({
          targetTuple: differentModel,
          planTarget: null,
        }),
      ),
    ).toBe(false);
  });

  it("is false when the destination's profile differs from the failed tuple", () => {
    const differentProfile = chatRunSettings({
      harnessId: FAILED_CLAUDE_TUPLE.harnessId,
      model: FAILED_CLAUDE_TUPLE.model,
      profileId: "some-other-profile",
    });
    expect(
      pendingFallbackResumesFailedTuple(
        pendingWithDestination({
          targetTuple: differentProfile,
          planTarget: null,
        }),
      ),
    ).toBe(false);
  });

  it("is false when there is a real destination that is a different tuple entirely", () => {
    expect(
      pendingFallbackResumesFailedTuple(
        pendingWithDestination({
          targetTuple: TARGET_CODEX_TUPLE,
          planTarget: null,
        }),
      ),
    ).toBe(false);
  });

  it("is false with no destination at all - no committed target and no plan", () => {
    expect(
      pendingFallbackResumesFailedTuple(
        pendingWithDestination({ targetTuple: null, planTarget: null }),
      ),
    ).toBe(false);
  });
});
