import { describe, expect, it } from "vitest";
import { hiddenActiveTabFallback } from "../hidden-active-tab-fallback";

describe("hiddenActiveTabFallback", () => {
  it("keeps the active tab when it is still visible", () => {
    expect(
      hiddenActiveTabFallback({
        isLandingPage: false,
        activeItemId: "tab:epic:titanos",
        visibleItemIds: ["tab:epic:titanos", "tab:draft:home"],
      }),
    ).toEqual({ kind: "keep" });
  });

  it("activates the first visible tab when All projects is on / with tabs", () => {
    expect(
      hiddenActiveTabFallback({
        isLandingPage: true,
        activeItemId: null,
        visibleItemIds: ["tab:epic:issue-1180", "tab:epic:titanos"],
      }),
    ).toEqual({ kind: "activate", itemId: "tab:epic:issue-1180" });
  });

  it("activates a visible sibling when the active tab is hidden", () => {
    expect(
      hiddenActiveTabFallback({
        isLandingPage: false,
        activeItemId: "tab:epic:crm",
        visibleItemIds: ["tab:epic:titanos"],
      }),
    ).toEqual({ kind: "activate", itemId: "tab:epic:titanos" });
  });

  it("opens one Start Page when a hidden tab has no visible sibling", () => {
    expect(
      hiddenActiveTabFallback({
        isLandingPage: false,
        activeItemId: "tab:epic:crm",
        visibleItemIds: [],
      }),
    ).toEqual({ kind: "new-draft" });
  });

  it("leaves the empty first-run landing alone so /draft/new can mint once", () => {
    expect(
      hiddenActiveTabFallback({
        isLandingPage: true,
        activeItemId: null,
        visibleItemIds: [],
      }),
    ).toEqual({ kind: "keep" });
  });
});
