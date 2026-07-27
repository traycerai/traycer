import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatFilterMenu } from "../epic-sidebar-filter-menu";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";

const EPIC_ID = "epic-1";

afterEach(() => {
  cleanup();
  useLeftPanelStore.setState(useLeftPanelStore.getInitialState(), true);
});

/**
 * Direct coverage of the REAL Agents filter menu.
 *
 * The sidebar integration test mocks this component out with a stub, so every
 * string the rename introduced here - the trigger name, the interface axis
 * options, the group label - was unasserted. A regression in exactly those
 * strings would have gone undetected.
 */
describe("<ChatFilterMenu />", () => {
  function open(): void {
    render(<ChatFilterMenu epicId={EPIC_ID} disabled={false} />);
    // Radix's DropdownMenuTrigger opens on pointerdown, not the click event.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Filter agents" }),
      { button: 0 },
    );
  }

  it("names the trigger for Agents, not chats", () => {
    render(<ChatFilterMenu epicId={EPIC_ID} disabled={false} />);
    expect(screen.getByRole("button", { name: "Filter agents" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Filter chats" })).toBeNull();
  });

  it("offers the interface axis: All / Chat / Terminal", () => {
    open();
    const options = screen
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent);
    // Agents narrowed by interface - never "Chats" / "Terminal Agents" as
    // sibling entity collections.
    expect(options).toContain("All");
    expect(options).toContain("Chat");
    expect(options).toContain("Terminal");
    expect(options).not.toContain("Chats");
    expect(options).not.toContain("Terminal Agents");
  });

  it("labels the group as the interface axis", () => {
    open();
    expect(screen.getByText("Interface")).toBeTruthy();
    expect(screen.queryByText("Show")).toBeNull();
  });

  it("persists the internal filter value, not the label, when an interface is picked", () => {
    open();
    const terminal = screen
      .getAllByRole("menuitemradio")
      .find((item) => item.textContent === "Terminal");
    if (terminal === undefined) throw new Error("no Terminal interface option");
    fireEvent.click(terminal);
    // `tui` is a compatibility value in persisted panel state; only the copy moved.
    expect(
      useLeftPanelStore.getState().chatFilterByEpicId[EPIC_ID].origin,
    ).toBe("tui");
  });
});
