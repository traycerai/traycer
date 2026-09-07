import { describe, expect, it } from "vitest";
import { decideDesktopUpdateExecutorCohort } from "../update-executor-cohort";

describe("decideDesktopUpdateExecutorCohort - static shadow-only, no enable seam", () => {
  it.each(["smappservice", "raw-fallback"] as const)(
    "returns shadow/disabled for substrate=%s with zero side effects",
    (substrate) => {
      expect(decideDesktopUpdateExecutorCohort(substrate)).toEqual({
        kind: "shadow",
        reason: "disabled",
      });
    },
  );

  it("is a pure function of its argument - repeated calls are stable and never mutate module state observable by a later call", () => {
    const first = decideDesktopUpdateExecutorCohort("smappservice");
    const second = decideDesktopUpdateExecutorCohort("smappservice");
    expect(first).toEqual(second);
    expect(decideDesktopUpdateExecutorCohort("raw-fallback")).toEqual({
      kind: "shadow",
      reason: "disabled",
    });
  });

  it("exposes no enable seam of any kind", async () => {
    const moduleExports: Record<string, unknown> =
      await import("../update-executor-cohort");
    const seamNames = Object.keys(moduleExports).filter(
      (name) => name !== "decideDesktopUpdateExecutorCohort",
    );
    expect(seamNames).toEqual([]);
  });
});
