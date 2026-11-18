import { describe, expect, it } from "vitest";
import {
  decideUpdateExecutorCohort,
  type UpdateExecutorCohortVerdict,
} from "../update-executor-cohort";

// The CLI's rollout fence: CLI-owned, static release policy, not a
// runtime/environment toggle. There is deliberately no shipped setter or
// exported test-only bypass.
//
// AFTER THE CUTOVER it returns `eligible` for every shipped platform: `host
// update` runs every arm on the attempt executor from `host/update-run.ts`,
// and a shadow verdict would refuse the command outright. The function stays
// - rather than the gate being deleted - so a future rollout has one explicit
// place to narrow, and so every caller's `!== "eligible"` arm stays reachable
// from a test-file-scoped `vi.mock` of this module.
describe("decideUpdateExecutorCohort - static, eligible on every shipped platform", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "returns eligible for %s with zero side effects",
    (platform) => {
      expect(decideUpdateExecutorCohort(platform)).toEqual({
        kind: "eligible",
        platform,
      });
    },
  );

  it("is a pure function of its argument - repeated calls with the same platform are stable and never mutate module state observable by a later call", () => {
    const first = decideUpdateExecutorCohort("linux");
    const second = decideUpdateExecutorCohort("linux");
    expect(first).toEqual(second);
    expect(decideUpdateExecutorCohort("darwin")).toEqual({
      kind: "eligible",
      platform: "darwin",
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

  // The capability/selection division, made executable rather than only
  // commented (Ticket 05, T2/T3 author's baseline sign-off).
  //
  // The eligible arm used to be `Exclude<HostInstallPlatform, "darwin">`, which
  // put a ROLLOUT decision in a TYPE. The cost was not a disabled path but an
  // untestable one: an eligible darwin verdict could not be constructed even
  // with this module mocked, and the repo bans the casts that would force one.
  //
  // The cutover INVERTED this test's second half: production now RETURNS
  // eligible for darwin, which is precisely the verdict the old type could not
  // express. Both halves are still worth pinning together - the type admits
  // every shipped platform, and so does the shipped policy.
  it("production RETURNS eligible for darwin - the verdict the old arm could not even express", () => {
    const expressible: UpdateExecutorCohortVerdict = {
      kind: "eligible",
      platform: "darwin",
    };
    expect(expressible.kind).toBe("eligible");

    // The same platform, through the real shipped policy.
    expect(decideUpdateExecutorCohort("darwin")).toEqual(expressible);
  });

  // The shadow verdict is still REACHABLE - a narrowed rollout, and every
  // caller's refusal arm, depend on it being constructible. Deleting the arm
  // (rather than the policy that stopped selecting it) would silently make
  // those arms dead code.
  it("still expresses the shadow verdict, so a narrowed rollout stays representable", () => {
    const shadow: UpdateExecutorCohortVerdict = {
      kind: "shadow",
      reason: "disabled",
    };
    expect(shadow.kind).toBe("shadow");
  });
});
