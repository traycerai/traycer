import { describe, expect, it } from "vitest";
import * as protocolClassifier from "@traycer/protocol/worktree/classify-worktree";
import * as sharedClassifier from "@traycer-clients/shared/worktree/classify-worktree";

/**
 * The tier ladder moved to `@traycer/protocol/worktree/classify-worktree` so
 * the host classifies with the same precedence the GUI and CLI render. The
 * behavioral truth table lives with the implementation (protocol's
 * `__tests__/classify-worktree.test.ts`); what this file pins is the property
 * that makes that one test sufficient for every client - the shared module
 * FORWARDS the protocol implementation and does not carry a second copy.
 *
 * Identity comparison, not behavioral: a re-implementation that happened to
 * agree on today's inputs would still be the divergence this guards against.
 */
describe("shared worktree classifier re-export", () => {
  it("forwards the protocol module's exports by identity", () => {
    expect(sharedClassifier.classifyWorktreeTier).toBe(
      protocolClassifier.classifyWorktreeTier,
    );
    expect(sharedClassifier.classifyWorktree).toBe(
      protocolClassifier.classifyWorktree,
    );
    expect(sharedClassifier.describeReviewReasons).toBe(
      protocolClassifier.describeReviewReasons,
    );
    expect(sharedClassifier.provenRemovable).toBe(
      protocolClassifier.provenRemovable,
    );
    expect(sharedClassifier.worktreeTierRank).toBe(
      protocolClassifier.worktreeTierRank,
    );
    expect(sharedClassifier.WORKTREE_TIER_LABEL).toBe(
      protocolClassifier.WORKTREE_TIER_LABEL,
    );
    expect(sharedClassifier.WORKTREE_TIER_TOOLTIP).toBe(
      protocolClassifier.WORKTREE_TIER_TOOLTIP,
    );
    expect(sharedClassifier.WORKTREE_TIER_ORDER).toBe(
      protocolClassifier.WORKTREE_TIER_ORDER,
    );
    expect(sharedClassifier.GIT_UNREADABLE_REASON).toBe(
      protocolClassifier.GIT_UNREADABLE_REASON,
    );
  });

  it("re-exports every value the protocol module publishes", () => {
    expect(Object.keys(sharedClassifier).sort()).toEqual(
      Object.keys(protocolClassifier).sort(),
    );
  });
});
