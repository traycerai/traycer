import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { TabsLayoutGroup } from "@/components/settings/panels/layout/tabs-layout-group";
import { SETTINGS_SEARCH_ENTRIES } from "@/lib/settings-search/settings-search-entries";

beforeEach(() => {
  useSettingsStore.setState({ taskTabLayout: "scroll" });
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ taskTabLayout: "scroll" });
});

describe("<TabsLayoutGroup />", () => {
  it("carries the anchor settings search scrolls to, with the row's own copy", () => {
    const { container } = render(<TabsLayoutGroup />);
    const row = container.querySelector(
      "[data-settings-anchor='layout-home-tab']",
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Home tab");
  });

  // The group and its one row, named rather than counted, so a row added later
  // has to be admitted here instead of merely bumping a number.
  it("draws the task tab layout and Home tab rows", () => {
    const { container } = render(<TabsLayoutGroup />);
    const anchors = [...container.querySelectorAll("[data-settings-anchor]")]
      .map((node) => node.getAttribute("data-settings-anchor"))
      .sort();
    expect(anchors).toEqual([
      "layout-home-tab",
      "layout-tabs",
      "layout-task-tab-layout",
    ]);
  });
});

// Home owned two more rows here and owns neither now: the view switch went
// with the flat reading, and the density segment went because the two spacings
// were barely distinguishable (user ruling, 2026-09-12). Both halves are
// asserted - the RENDER and the search index - because an index entry that
// outlives its row lands a search result on an anchor nothing draws.
describe("<TabsLayoutGroup /> the rows Home no longer owns", () => {
  it.each([
    { name: "Home density", anchor: "layout-home-density" },
    { name: "Home view", anchor: "layout-home-view" },
  ])("offers no $name row and no $anchor entry", ({ name, anchor }) => {
    const { container } = render(<TabsLayoutGroup />);

    expect(screen.queryByRole("group", { name })).toBeNull();
    expect(
      container.querySelector(`[data-settings-anchor='${anchor}']`),
    ).toBeNull();
    expect(
      SETTINGS_SEARCH_ENTRIES.some((candidate) => candidate.anchor === anchor),
    ).toBe(false);
  });
});

describe("<TabsLayoutGroup /> task tab layout", () => {
  it("presses Scroll by default", () => {
    render(<TabsLayoutGroup />);
    const group = screen.getByRole("group", { name: "Task tab layout" });
    expect(
      screen
        .getByRole("button", { name: "Scroll" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Shrink to fit" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(group).toBeTruthy();
  });

  it("writes Shrink to fit into the store and moves the pressed state", () => {
    render(<TabsLayoutGroup />);
    fireEvent.click(screen.getByRole("button", { name: "Shrink to fit" }));
    expect(useSettingsStore.getState().taskTabLayout).toBe("shrink");
    expect(
      screen
        .getByRole("button", { name: "Shrink to fit" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("reflects a store value set elsewhere and can switch back", () => {
    useSettingsStore.setState({ taskTabLayout: "shrink" });
    render(<TabsLayoutGroup />);
    fireEvent.click(screen.getByRole("button", { name: "Scroll" }));
    expect(useSettingsStore.getState().taskTabLayout).toBe("scroll");
  });
});
