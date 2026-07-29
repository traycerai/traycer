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
  function open(canArchive: boolean): void {
    render(
      <ChatFilterMenu
        epicId={EPIC_ID}
        disabled={false}
        canArchive={canArchive}
      />,
    );
    // Radix's DropdownMenuTrigger opens on pointerdown, not the click event.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Filter agents" }),
      { button: 0 },
    );
  }

  it("names the trigger for Agents, not chats", () => {
    render(
      <ChatFilterMenu epicId={EPIC_ID} disabled={false} canArchive={false} />,
    );
    expect(screen.getByRole("button", { name: "Filter agents" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Filter chats" })).toBeNull();
  });

  it("offers the interface axis: All / Chat / Terminal", () => {
    open(false);
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
    open(false);
    expect(screen.getByText("Interface")).toBeTruthy();
    expect(screen.queryByText("Show")).toBeNull();
  });

  it("persists the internal filter value, not the label, when an interface is picked", () => {
    open(false);
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

  it('omits "Show archived" entirely when the host lacks archive support (B4)', () => {
    open(false);
    expect(screen.queryByTestId("epic-sidebar-show-archived")).toBeNull();
    expect(screen.queryByText("Show archived")).toBeNull();
  });

  it('offers "Show archived" and toggles the per-epic store flag when supported (B3/B4)', () => {
    open(true);

    const item = screen.getByTestId("epic-sidebar-show-archived");
    expect(item).toBeTruthy();
    expect(screen.getByText("Show archived")).toBeTruthy();
    // Default off.
    expect(
      useLeftPanelStore.getState().chatShowArchivedByEpicId[EPIC_ID] ?? false,
    ).toBe(false);

    fireEvent.click(item);
    expect(useLeftPanelStore.getState().chatShowArchivedByEpicId[EPIC_ID]).toBe(
      true,
    );

    fireEvent.click(item);
    // Toggle off drops the key rather than storing false.
    expect(
      useLeftPanelStore.getState().chatShowArchivedByEpicId[EPIC_ID] ?? false,
    ).toBe(false);
  });
});
