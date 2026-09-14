import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSearch } from "@/components/settings/settings-search-box";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());

// The navigator reaches for the modal bridge or the router; which one is not
// this suite's concern — only that a selection asks for the right section.
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

/** The box with its query owned by a parent, as the rail owns it. */
function Harness(): ReactNode {
  const [query, setQuery] = useState("");
  return <SettingsSearch query={query} onQueryChange={setQuery} />;
}

function combobox(): HTMLElement {
  return screen.getByRole("combobox", { name: "Search settings" });
}

function type(query: string): void {
  fireEvent.change(combobox(), { target: { value: query } });
}

beforeEach(() => {
  useSettingsSearchStore.setState({ query: "", pendingReveal: null });
  // jsdom implements no scrolling; the highlight asks the option to stay in
  // view, which is all this stands in for.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  navigateToSettingsSectionMock.mockClear();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("<SettingsSearch /> keyboard exposure", () => {
  it("is a collapsed combobox with nothing active before a query", () => {
    render(<Harness />);

    const input = combobox();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("points aria-activedescendant at the highlighted option as the arrows move it", () => {
    render(<Harness />);
    type("theme");

    const input = combobox();
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const listbox = screen.getByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);

    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });

    const moved = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(moved[1].id);
    expect(moved[1].getAttribute("aria-selected")).toBe("true");
    expect(moved[0].getAttribute("aria-selected")).toBe("false");
  });

  it("drops the active descendant when nothing matches", () => {
    render(<Harness />);
    type("qqzzxwv");

    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(combobox().hasAttribute("aria-activedescendant")).toBe(false);
  });

  // `aria-controls` names the listbox for as long as the search is expanded,
  // so the empty state has to BE that listbox, not a paragraph in its place.
  it("keeps aria-controls pointing at a listbox when nothing matches", () => {
    render(<Harness />);
    type("qqzzxwv");

    const listbox = screen.getByRole("listbox", {
      name: "Settings search results",
    });
    expect(combobox().getAttribute("aria-controls")).toBe(listbox.id);
    expect(listbox.textContent).toContain("Nothing in settings matches");
  });
});

// Pointer input, driven through user-event rather than `fireEvent` because
// only user-event moves focus on press the way a browser does — and honours a
// `preventDefault` on mousedown. `fireEvent.click` never moves focus, so a
// focus assertion after it would pass whatever the component did.
describe("<SettingsSearch /> focus under the pointer", () => {
  it("keeps focus on the combobox after a result is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(combobox(), "theme");

    await user.click(screen.getAllByRole("option")[0]);

    expect(navigateToSettingsSectionMock).toHaveBeenCalled();
    expect(document.activeElement).toBe(combobox());
    // ...so the keyboard still drives the list.
    await user.keyboard("{ArrowDown}");
    expect(combobox().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[1].id,
    );
  });

  it("keeps focus on the combobox after the clear button is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(combobox(), "theme");

    await user.click(
      screen.getByRole("button", { name: "Clear settings search" }),
    );

    expect(combobox()).toHaveProperty("value", "");
    expect(document.activeElement).toBe(combobox());
    // ...so the next keystroke starts the next search.
    await user.keyboard("zoom");
    expect(combobox()).toHaveProperty("value", "zoom");
  });

  it("returns focus to the combobox after the clear button is activated by keyboard", async () => {
    // A keyboard user reaches the button by Tab, so it DOES hold focus when
    // it clears — and clearing unmounts it. Pointer-only handling would let
    // focus fall to the document here.
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(combobox(), "theme");

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Clear settings search" }),
    );
    await user.keyboard("{Enter}");

    expect(combobox()).toHaveProperty("value", "");
    expect(document.activeElement).toBe(combobox());
    await user.keyboard("zoom");
    expect(combobox()).toHaveProperty("value", "zoom");
  });
});

// The rail is a scrolling flex column whose section blocks keep
// `min-height: auto`, so a shrinkable search box is the only child that can
// collapse when the list outgrows the aside - and its input then paints over
// the first group header.
//
// Both cases below pin the CLASS, not the layout: jsdom computes none, so
// nothing here can observe the collapse itself. What they catch is the class
// being dropped or made unconditional, which is how the collapse comes back.
describe("<SettingsSearch /> shrink behaviour in the rail", () => {
  function searchBox(): HTMLElement {
    const box = document.querySelector("[data-settings-search-box]");
    if (!(box instanceof HTMLElement)) {
      throw new Error("search box wrapper not found");
    }
    return box;
  }

  it("refuses to shrink while the section list is the thing below it", () => {
    render(<Harness />);

    expect(searchBox().className).toContain("shrink-0");
    expect(searchBox().className).not.toContain("min-h-0");
  });

  // While results are up they REPLACE the section list, and the list is the
  // thing meant to scroll (`searchSettings` caps it at 12, not at a height),
  // so the box goes back to shrinking - that is what pins the input above a
  // scrolling list instead of scrolling the whole rail.
  it("shrinks again while results are showing, so the list scrolls under a pinned input", () => {
    render(<Harness />);
    type("theme");

    expect(searchBox().className).toContain("min-h-0");
    expect(searchBox().className).not.toContain("shrink-0");
  });
});

describe("<SettingsSearch /> selection", () => {
  it("arms a page-top reveal for a page result, not just a navigation", () => {
    // Navigating to the section already on screen moves nothing, so a page
    // result needs a request of its own.
    render(<Harness />);
    type("keybindings");
    expect(screen.getAllByRole("option")[0].textContent).toContain(
      "Keybindings",
    );

    fireEvent.keyDown(combobox(), { key: "Enter" });

    expect(navigateToSettingsSectionMock).toHaveBeenCalledWith("keybindings");
    expect(useSettingsSearchStore.getState().pendingReveal).toMatchObject({
      section: "keybindings",
      anchor: null,
    });
  });

  it("arms an anchored reveal for a row result", () => {
    render(<Harness />);
    type("minimap side");

    fireEvent.keyDown(combobox(), { key: "Enter" });

    expect(useSettingsSearchStore.getState().pendingReveal).toMatchObject({
      section: "layout",
      anchor: "layout-minimap-side",
    });
  });
});
