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
        focusPaneId: " ",
        focusTileInstanceId: "\n",
      }),
    ).toEqual({
      focusedAt: undefined,
      focusArtifactId: undefined,
      focusThreadId: undefined,
      migrationSource: "phase",
      focusPaneId: undefined,
      focusTileInstanceId: undefined,
    });
  });

  it("trims valid string focus params", () => {
    expect(
      normalizeEpicFocusSearch({
        focusedAt: " 42 ",
        focusArtifactId: " artifact-1 ",
        focusThreadId: " thread-1 ",
        migrationSource: undefined,
        focusPaneId: " pane-1 ",
        focusTileInstanceId: " tile-1 ",
      }),
    ).toEqual({
      focusedAt: 42,
      focusArtifactId: "artifact-1",
      focusThreadId: "thread-1",
      migrationSource: undefined,
      focusPaneId: "pane-1",
      focusTileInstanceId: "tile-1",
    });
  });

  it("defaults absent nested focus params to undefined", () => {
    expect(normalizeEpicFocusSearch({})).toEqual({
      focusedAt: undefined,
      focusArtifactId: undefined,
      focusThreadId: undefined,
      migrationSource: undefined,
      focusPaneId: undefined,
      focusTileInstanceId: undefined,
    });
  });
});
