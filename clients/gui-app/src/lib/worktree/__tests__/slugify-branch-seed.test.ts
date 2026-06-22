import { describe, expect, it } from "vitest";
import { slugifyBranchSeed } from "@/lib/worktree/slugify-branch-seed";

describe("slugifyBranchSeed", () => {
  it("returns an empty string for null input", () => {
    expect(slugifyBranchSeed(null)).toBe("");
  });

  it("collapses non-alphanumeric runs into single dashes", () => {
    expect(slugifyBranchSeed("Plan the GUI migration!")).toBe(
      "plan-the-gui-migration",
    );
  });

  it("strips leading and trailing dashes", () => {
    expect(slugifyBranchSeed("  -- Hello --  ")).toBe("hello");
  });

  it("clamps the result length to keep branch names manageable", () => {
    const long = "a".repeat(100);
    expect(slugifyBranchSeed(long).length).toBeLessThanOrEqual(40);
  });
});
