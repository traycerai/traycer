import { describe, expect, it } from "vitest";
import {
  decideUpdateExecutorCohort,
  type UpdateExecutorCohortVerdict,
} from "../update-executor-cohort";

// Ticket 03's rollout fence: CLI-owned, static release policy, not a runtime/environment toggle.
// There is deliberately no shipped setter or exported test-only bypass - Ticket 07 is the sole authorized cutover point.
describe("decideUpdateExecutorCohort - static shadow-only, no enable seam", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "returns shadow/disabled for %s with zero side effects",
    (platform) => {
      expect(decideUpdateExecutorCohort(platform)).toEqual({
        kind: "shadow",
        reason: "disabled",
      });
    },
  );

  it("is a pure function of its argument - repeated calls with the same platform are stable and never mutate module state observable by a later call", () => {
    const first = decideUpdateExecutorCohort("linux");
    const second = decideUpdateExecutorCohort("linux");
    expect(first).toEqual(second);
    expect(decideUpdateExecutorCohort("darwin")).toEqual({
      kind: "shadow",
      reason: "disabled",
    });
  });

  it("exposes no enable seam of any kind", async () => {
    const moduleExports: Record<string, unknown> =
      await import("../update-executor-cohort");
    const seamNames = Object.keys(moduleExports).filter(
      (name) => name !== "decideUpdateExecutorCohort",
    );
    expect(seamNames).toEqual([]);
  });

  // The capability/selection division, made executable rather than only commented (Ticket 05, T2/T3 author's baseline sign-off).
  // The eligible arm used to be `Exclude<HostInstallPlatform, "darwin">`, which put a ROLLOUT decision in a TYPE.
  it("can EXPRESS an eligible darwin verdict while production never RETURNS one", () => {
    const expressible: UpdateExecutorCohortVerdict = {
      kind: "eligible",
      platform: "darwin",
    };
    expect(expressible.kind).toBe("eligible");

    // The same platform, through the real shipped policy.
    expect(decideUpdateExecutorCohort("darwin")).toEqual({
      kind: "shadow",
      reason: "disabled",
    });
  });
});
