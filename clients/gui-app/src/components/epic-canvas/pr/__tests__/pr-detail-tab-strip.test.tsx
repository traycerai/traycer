import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PrDetailTabId } from "@/stores/epics/pr-detail-view-store";
import { PrDetailTabStrip } from "@/components/epic-canvas/pr/pr-detail-tab-strip";

function renderStrip(args: {
  readonly tab: PrDetailTabId;
  readonly onSelectTab: (tab: PrDetailTabId) => void;
}): void {
  render(
    <PrDetailTabStrip
      tab={args.tab}
      onSelectTab={args.onSelectTab}
      counts={{ feedback: 1, files: 324, checks: 1, commits: 66 }}
      blocking={{ feedback: 1, checks: 1 }}
    />,
  );
}

afterEach(cleanup);

describe("PrDetailTabStrip", () => {
  it("spans its column rather than hugging its own content", () => {
    // Hugging left the strip ending short of every card below it, so it read
    // as a stray element floating above the page instead of as its header.
    renderStrip({ tab: "overview", onSelectTab: () => undefined });

    const strip = screen.getByTestId("pr-detail-tabs");
    expect(strip.className).toContain("w-full");
    expect(strip.className).not.toContain("w-fit");
  });

  it("gives every tab an equal share, not one proportional to its label", () => {
    // Without `basis-0` a five-tab row sizes each tab by its text, and
    // "Overview" against "Files" reads as a misaligned control.
    renderStrip({ tab: "overview", onSelectTab: () => undefined });

    for (const id of ["overview", "commits", "feedback", "checks", "files"]) {
      const tab = screen.getByTestId(`pr-detail-tab-${id}`);
      expect(tab.className).toContain("flex-1");
      expect(tab.className).toContain("basis-0");
    }
  });

  it("marks exactly one tab selected and reports it to assistive tech", () => {
    renderStrip({ tab: "checks", onSelectTab: () => undefined });

    const selected = screen
      .getAllByRole("tab")
      .filter((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-testid")).toBe(
      "pr-detail-tab-checks",
    );
  });

  it("shows the blocking count in place of the size when something blocks", () => {
    // A red "1" that means "one failure" is a different fact from a grey
    // "324" that means "this many files"; the tab must not conflate them.
    renderStrip({ tab: "overview", onSelectTab: () => undefined });

    expect(screen.getByTestId("pr-detail-tab-checks").textContent).toContain(
      "1",
    );
    expect(screen.getByTestId("pr-detail-tab-files").textContent).toContain(
      "324",
    );
  });

  it("reports the tab that was clicked", () => {
    const picked: PrDetailTabId[] = [];
    renderStrip({ tab: "overview", onSelectTab: (tab) => picked.push(tab) });

    fireEvent.click(screen.getByTestId("pr-detail-tab-files"));
    expect(picked).toEqual(["files"]);
  });
});
