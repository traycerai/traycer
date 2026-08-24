import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactFilterMenu,
  ChatFilterMenu,
} from "../epic-sidebar-filter-menu";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { usePanelHeaderMenuStore } from "@/stores/epics/panel-header-menu-store";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";

afterEach(() => {
  cleanup();
  useLeftPanelStore.setState(useLeftPanelStore.getInitialState(), true);
  usePanelHeaderMenuStore.setState(
    usePanelHeaderMenuStore.getInitialState(),
    true,
  );
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
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
        tabId={TAB_ID}
        collapsed={false}
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
      <ChatFilterMenu
        epicId={EPIC_ID}
        tabId={TAB_ID}
        collapsed={false}
        canArchive={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Filter agents" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Filter chats" })).toBeNull();
  });

  it("offers the interface axis: All / Chat / Terminal", () => {
    open(false);
    const menu = screen.getByTestId("epic-sidebar-agent-view-menu");
    expect(menu.getAttribute("data-side")).toBe("right");
    expect(menu.className).toContain(
      "w-[var(--radix-dropdown-menu-content-available-width)]",
    );
    expect(menu.className).toContain("max-w-64");
    expect(menu.className).not.toContain("min-w-64");
    fireEvent.click(screen.getByText("Interface"));
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
    expect(screen.queryByText("Collapse all")).toBeNull();
  });

  it("offers the ownership axis: All / Mine / Others", () => {
    open(false);
    fireEvent.click(screen.getByText("Ownership"));

    expect(
      screen.getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual(expect.arrayContaining(["All", "Mine", "Others"]));

    const others = screen
      .getAllByRole("menuitemradio")
      .find((item) => item.textContent === "Others");
    if (others === undefined) throw new Error("no Others ownership option");
    fireEvent.click(others);

    expect(
      useLeftPanelStore.getState().chatFilterByEpicId[EPIC_ID].ownership,
    ).toBe("others");
  });

  it("expands a collapsed section before opening its view menu", () => {
    useLeftPanelStore.getState().setPanelSectionCollapsed("chats", true);
    render(
      <ChatFilterMenu
        epicId={EPIC_ID}
        tabId={TAB_ID}
        collapsed
        canArchive={false}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Filter agents" }),
      {
        button: 0,
      },
    );

    expect(
      useLeftPanelStore.getState().panelSectionCollapsedByPanelId.chats,
    ).toBe(false);
    expect(screen.getByTestId("epic-sidebar-agent-view-menu")).toBeTruthy();
  });

  it("keeps the view menu open when expansion remounts its header", () => {
    useLeftPanelStore.getState().setPanelSectionCollapsed("chats", true);
    const { rerender } = render(
      <ChatFilterMenu
        key="collapsed"
        epicId={EPIC_ID}
        tabId={TAB_ID}
        collapsed
        canArchive={false}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Filter agents" }),
      { button: 0 },
    );
    rerender(
      <ChatFilterMenu
        key="expanded"
        epicId={EPIC_ID}
        tabId={TAB_ID}
        collapsed={false}
        canArchive={false}
      />,
    );

    expect(screen.getByTestId("epic-sidebar-agent-view-menu")).toBeTruthy();
  });

  it("drills into details with Back when two menu columns do not fit", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    open(false);

    const interfaceRow = screen
      .getByText("Interface")
      .closest('[role="menuitem"]');
    expect(interfaceRow?.className).toContain(
      "grid-cols-[minmax(0,1fr)_auto_1rem]",
    );
    expect(
      interfaceRow?.querySelector("span:nth-child(2)")?.className,
    ).toContain("text-right");

    fireEvent.click(screen.getByText("Interface"));

    expect(screen.getByText("Back")).toBeTruthy();
    expect(screen.getByText("Interface")).toBeTruthy();
    expect(
      screen.getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual(expect.arrayContaining(["All", "Chat", "Terminal"]));
  });

  it("labels the group as the interface axis", () => {
    open(false);
    expect(screen.getByText("Interface")).toBeTruthy();
    expect(screen.queryByText("Show")).toBeNull();
  });

  it("persists the internal filter value, not the label, when an interface is picked", () => {
    open(false);
    fireEvent.click(screen.getByText("Interface"));
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

  it("counts interface and ownership as independent filters", () => {
    const store = useLeftPanelStore.getState();
    store.setChatOrigin(EPIC_ID, "gui");
    store.setChatOwnership(EPIC_ID, "mine");

    render(
      <ChatFilterMenu
        epicId={EPIC_ID}
        tabId={TAB_ID}
        collapsed={false}
        canArchive={false}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Filter agents, 2 filters active",
      }).textContent,
    ).toBe("2");
  });

  it("omits archive visibility when the host lacks archive support (B4)", () => {
    open(false);
    expect(screen.queryByTestId("epic-sidebar-archive-visibility")).toBeNull();
    expect(screen.queryByText("Show")).toBeNull();
  });

  it("offers every archive visibility and persists the per-epic selection", () => {
    open(true);
    fireEvent.click(screen.getByText("Show"));

    expect(
      screen.getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual(
      expect.arrayContaining(["Unarchived only", "Archived only", "All chats"]),
    );
    expect(
      screen
        .getByTestId("epic-sidebar-archive-visibility-unarchived")
        .getAttribute("data-state"),
    ).toBe("checked");

    fireEvent.click(
      screen.getByTestId("epic-sidebar-archive-visibility-archived"),
    );
    expect(
      useLeftPanelStore.getState().chatArchiveVisibilityByEpicId[EPIC_ID],
    ).toBe("archived");

    fireEvent.click(screen.getByTestId("epic-sidebar-archive-visibility-all"));
    expect(
      useLeftPanelStore.getState().chatArchiveVisibilityByEpicId[EPIC_ID],
    ).toBe("all");

    fireEvent.click(
      screen.getByTestId("epic-sidebar-archive-visibility-unarchived"),
    );
    expect(
      useLeftPanelStore.getState().chatArchiveVisibilityByEpicId[EPIC_ID],
    ).toBeUndefined();
  });
});

describe("<ArtifactFilterMenu />", () => {
  function renderMenu(): void {
    render(
      <ArtifactFilterMenu
        epicId={EPIC_ID}
        tabId={TAB_ID}
        collapsed={false}
        onMarkAllRead={() => undefined}
        markAllReadDisabled={false}
      />,
    );
  }

  it("summarizes active clauses on its persistent trigger", () => {
    const store = useLeftPanelStore.getState();
    store.toggleArtifactStatus(EPIC_ID, 0);
    store.toggleArtifactKind(EPIC_ID, "spec");
    store.setArtifactRead(EPIC_ID, "unread");

    renderMenu();

    const trigger = screen.getByRole("button", {
      name: "Filter artifacts, 3 filters active",
    });
    expect(trigger.className).not.toContain("bg-accent/70");
    expect(trigger.textContent).toBe("3");
  });

  it("keeps the filter axes in the root and opens each detail to the right", () => {
    renderMenu();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Filter artifacts" }),
      { button: 0 },
    );

    expect(screen.getByText("Ordering")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("Type")).toBeTruthy();
    expect(screen.getByText("Read state")).toBeTruthy();
    expect(screen.queryByText("Collapse all")).toBeNull();

    const orderingRow = screen
      .getByText("Ordering")
      .closest('[role="menuitem"]');
    expect(orderingRow?.className).toContain(
      "grid-cols-[minmax(0,1fr)_auto_1rem]",
    );
    expect(screen.getByText("Last updated ↓").className).toContain(
      "text-right",
    );
    expect(orderingRow?.className).toContain(
      "[&>svg:last-child]:justify-self-end",
    );

    fireEvent.click(screen.getByText("Status"));
    const statusItems = screen
      .getAllByRole("menuitemcheckbox")
      .map((item) => item.textContent);
    expect(statusItems).toEqual(
      expect.arrayContaining(["Todo", "In Progress", "Done"]),
    );
  });

  it("uses the create menu icon language in the Type filter detail", () => {
    renderMenu();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Filter artifacts" }),
      { button: 0 },
    );
    fireEvent.click(screen.getByText("Type"));

    const typeItems = screen.getAllByRole("menuitemcheckbox");
    expect(typeItems.map((item) => item.textContent)).toEqual([
      "Spec",
      "Ticket",
      "Story",
      "Review",
    ]);
    expect(typeItems.every((item) => item.querySelector("svg") !== null)).toBe(
      true,
    );
  });

  it("resets filters, ordering, and visibility state from one action", () => {
    const store = useLeftPanelStore.getState();
    store.toggleArtifactStatus(EPIC_ID, 2);
    store.setArtifactSortField(EPIC_ID, "name");
    renderMenu();

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Filter artifacts, 1 filter active, ordered by Name",
      }),
      { button: 0 },
    );
    fireEvent.click(screen.getByText("Reset view"));

    const next = useLeftPanelStore.getState();
    expect(next.artifactFilterByEpicId[EPIC_ID]).toBeUndefined();
    expect(next.artifactSortByEpicId[EPIC_ID]).toBeUndefined();
  });
});
