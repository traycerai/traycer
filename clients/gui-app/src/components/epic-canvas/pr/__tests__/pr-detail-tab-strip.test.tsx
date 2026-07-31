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

/**
 * Each tab paired with a matcher for its accessible name. Regexes rather than
 * exact strings because a tab's name also carries its count badge (e.g.
 * "Files 324"), which is deliberately not `aria-hidden`.
 */
const TAB_NAMES: readonly (readonly [PrDetailTabId, RegExp])[] = [
  ["overview", /Overview/],
  ["commits", /Commits/],
  ["feedback", /Feedback/],
  ["checks", /Checks/],
  ["files", /Files/],
];

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

    for (const [, name] of TAB_NAMES) {
      const tab = screen.getByRole("tab", { name });
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

    fireEvent.click(screen.getByRole("tab", { name: /Files/ }));
    expect(picked).toEqual(["files"]);
  });

  it("wires each tab to the panel it controls, both ways", () => {
    renderStrip({ tab: "checks", onSelectTab: () => undefined });

    for (const [id, name] of TAB_NAMES) {
      const button = screen.getByRole("tab", { name });
      const controls = button.getAttribute("aria-controls");
      expect(controls).toBe(`pr-detail-tabpanel-${id}`);
      expect(button.getAttribute("id")).toBe(`pr-detail-tab-trigger-${id}`);
    }
  });

  it("keeps only the selected tab in the regular tab order (roving tabindex)", () => {
    renderStrip({ tab: "feedback", onSelectTab: () => undefined });

    for (const [id, name] of TAB_NAMES) {
      const tab = screen.getByRole("tab", { name });
      expect(tab.getAttribute("tabindex")).toBe(id === "feedback" ? "0" : "-1");
    }
  });

  it("moves selection with ArrowRight/ArrowLeft, wrapping at both ends", () => {
    const picked: PrDetailTabId[] = [];
    renderStrip({ tab: "files", onSelectTab: (tab) => picked.push(tab) });

    // Fired on the focused TAB, which is where the key actually lands under a
    // roving tabindex - the strip's container is deliberately not focusable.
    fireEvent.keyDown(screen.getByRole("tab", { name: /Files/ }), {
      key: "ArrowRight",
    });
    expect(picked).toEqual(["overview"]);

    picked.length = 0;
    cleanup();
    renderStrip({ tab: "overview", onSelectTab: (tab) => picked.push(tab) });
    fireEvent.keyDown(screen.getByRole("tab", { name: /Overview/ }), {
      key: "ArrowLeft",
    });
    expect(picked).toEqual(["files"]);
  });

  it("jumps to the first/last tab on Home/End", () => {
    const picked: PrDetailTabId[] = [];
    renderStrip({ tab: "checks", onSelectTab: (tab) => picked.push(tab) });

    fireEvent.keyDown(screen.getByRole("tab", { name: /Checks/ }), {
      key: "End",
    });
    expect(picked).toEqual(["files"]);

    picked.length = 0;
    fireEvent.keyDown(screen.getByRole("tab", { name: /Checks/ }), {
      key: "Home",
    });
    expect(picked).toEqual(["overview"]);
  });
});
