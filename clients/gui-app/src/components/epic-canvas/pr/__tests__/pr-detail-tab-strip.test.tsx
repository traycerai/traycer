import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      // Every blocking value differs from its own plain count. With the two
      // equal, the Checks tab renders the same digit whichever one the strip
      // reads, so the substitution assertion below would pass even with the
      // substitution deleted.
      counts={{ feedback: 4, files: 324, checks: 12, commits: 66 }}
      blocking={{ feedback: 1, checks: 2 }}
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
    // A red "2" that means "two failures" is a different fact from a grey
    // "324" that means "this many files"; the tab must not conflate them.
    renderStrip({ tab: "overview", onSelectTab: () => undefined });

    const checks = screen.getByTestId("pr-detail-tab-checks").textContent;
    expect(checks).toContain("2");
    // The one that does the work: 12 is the plain count. A strip that fell
    // back to it would still satisfy `toContain("2")`, since "12" holds a "2".
    expect(checks).not.toContain("12");
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

describe("<PrDetailTabStrip /> on a phone viewport", () => {
  beforeEach(() => {
    // `useIsMobileViewport` reads `window.innerWidth` directly (not
    // `matchMedia().matches`, which the global test shim always reports as
    // `false`), so setting it before render is enough to force the phone
    // presentation.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
  });

  afterEach(() => {
    // Restore before anything else sees a phone-width window - the suite above
    // asserts the desktop arm and would render a menu instead.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });

  it("replaces the strip with a menu rather than shrinking five tabs", () => {
    renderStrip({ tab: "overview", onSelectTab: () => undefined });

    // The whole point of the change: at phone width no tab is rendered at all,
    // so none can be truncated to "Ov…". A strip that merely restyled itself
    // would still satisfy every other assertion here.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    const trigger = screen.getByRole("button", { name: /Overview/ });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("keeps the trigger full-width in the strip's own slot", () => {
    renderStrip({ tab: "overview", onSelectTab: () => undefined });

    const trigger = screen.getByTestId("pr-detail-tabs");
    expect(trigger.className).toContain("w-full");
    // The touch target the strip never had: its tabs are `py-1.5`, ~30px.
    expect(trigger.className).toContain("min-h-11");
  });

  it("names the panel from the active tab's label", () => {
    // `pr-detail-body` labels its `role="tabpanel"` with this id. Radix owns
    // the trigger BUTTON's id and points the open menu's `aria-labelledby` at
    // it, so the id lives on the label span - taking the button's would leave
    // the menu unnamed to name the panel.
    renderStrip({ tab: "checks", onSelectTab: () => undefined });

    const label = document.getElementById("pr-detail-tab-trigger-checks");
    expect(label?.textContent).toBe("Checks");
    expect(screen.getByTestId("pr-detail-tabs").getAttribute("id")).not.toBe(
      "pr-detail-tab-trigger-checks",
    );
  });

  it("carries the same counts and blocking substitution as the strip", () => {
    renderStrip({ tab: "files", onSelectTab: () => undefined });

    // The trigger shows the ACTIVE tab's own badge, from the same derivation
    // the strip uses - not a separate mobile count.
    expect(screen.getByTestId("pr-detail-tabs").textContent).toContain("324");
  });

  it("opens a row per tab and reports the one that was picked", async () => {
    const picked: PrDetailTabId[] = [];
    const user = userEvent.setup();
    renderStrip({ tab: "overview", onSelectTab: (tab) => picked.push(tab) });

    await user.click(screen.getByTestId("pr-detail-tabs"));

    const rows = await screen.findAllByRole("menuitemradio");
    expect(rows).toHaveLength(TAB_NAMES.length);
    // Same substitution rule inside the menu: the red "2" (failures), never
    // the plain 12.
    const checks = screen.getByTestId("pr-detail-tab-checks").textContent;
    expect(checks).toContain("2");
    expect(checks).not.toContain("12");

    await user.click(screen.getByTestId("pr-detail-tab-files"));
    expect(picked).toEqual(["files"]);
  });
});
