import { describe, expect, it } from "vitest";
import { withOverlayCleared } from "@/lib/system-tab-overlay-search";

describe("system tab overlay search helpers", () => {
  it("removes the overlay open-flags, leaving unrelated params intact", () => {
    expect(
      withOverlayCleared({
        settingsOverlay: true,
        historyOverlay: true,
        unrelated: "keep",
      }),
    ).toEqual({ unrelated: "keep" });
  });
});
