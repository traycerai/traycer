import { describe, expect, it } from "vitest";
import { normalizeEpicFocusSearch } from "@/routes/epic-route-search";

describe("normalizeEpicFocusSearch", () => {
  it("trims blank search params before accepting focus state", () => {
    expect(
      normalizeEpicFocusSearch({
        focusedAt: "   ",
        focusArtifactId: "   ",
        focusThreadId: "\t",
        migrationSource: "phase",
      }),
    ).toEqual({
      focusedAt: undefined,
      focusArtifactId: undefined,
      focusThreadId: undefined,
      migrationSource: "phase",
    });
  });

  it("trims valid string focus params", () => {
    expect(
      normalizeEpicFocusSearch({
        focusedAt: " 42 ",
        focusArtifactId: " artifact-1 ",
        focusThreadId: " thread-1 ",
        migrationSource: undefined,
      }),
    ).toEqual({
      focusedAt: 42,
      focusArtifactId: "artifact-1",
      focusThreadId: "thread-1",
      migrationSource: undefined,
    });
  });
});
