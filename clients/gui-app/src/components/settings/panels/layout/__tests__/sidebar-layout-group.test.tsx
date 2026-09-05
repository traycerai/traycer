import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { SidebarLayoutGroup } from "@/components/settings/panels/layout/sidebar-layout-group";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
  type LeftPanelGroup,
} from "@/stores/epics/left-panel-store";

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => viewport.mobile,
}));

// The row menu's `DropdownMenuContent` is real Radix, which opens on
// pointerdown - awkward under jsdom. The shared stand-in renders every menu
// inline and always-open so a row's actions can be clicked directly.
vi.mock("@/components/ui/dropdown-menu", async () => ({
  ...(await import("@/components/settings/panels/__tests__/dropdown-menu-passthrough-mock")),
}));

function resetLeftPanelStore(): void {
  window.localStorage.clear();
  useLeftPanelStore.setState({
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    panelVisibilityOverrideById: {},
  });
}

beforeEach(() => {
  viewport.mobile = false;
  resetLeftPanelStore();
});

afterEach(() => {
  cleanup();
  resetLeftPanelStore();
});

function stripTileTestIds(strip: HTMLElement): ReadonlyArray<string | null> {
  return Array.from(
    strip.querySelectorAll('[data-testid^="layout-sidebar-panel-tile-"]'),
  ).map((el) => el.getAttribute("data-testid"));
}

/** The cards, without the headers that share their testid prefix. */
function cardElements(panels: HTMLElement): ReadonlyArray<Element> {
  return Array.from(
    panels.querySelectorAll(
      "[data-testid^='layout-sidebar-panel-group-']:not([data-testid^='layout-sidebar-panel-group-header-'])",
    ),
  );
}

function isTileIconDimmed(panelId: string): boolean {
  const icon = screen
    .getByTestId(`layout-sidebar-panel-tile-${panelId}`)
    .querySelector("svg");
  return icon !== null && icon.classList.contains("opacity-40");
}

describe("<SidebarLayoutGroup /> rendering", () => {
  it("renders rows in panelGroups order, with grouped rows sharing a group card", () => {
    const groups: ReadonlyArray<LeftPanelGroup> = [
      { panelIds: ["terminals"] },
      { panelIds: ["chats", "artifacts"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ];
    useLeftPanelStore.getState().applyPanelGroups(groups);
    render(<SidebarLayoutGroup />);

    const panelsList = screen.getByTestId("layout-sidebar-panels");
    const groupEls = cardElements(panelsList);
    expect(groupEls.map((el) => el.getAttribute("data-testid"))).toEqual([
      "layout-sidebar-panel-group-terminals",
      "layout-sidebar-panel-group-chats",
      "layout-sidebar-panel-group-browsers",
      "layout-sidebar-panel-group-git-diff",
      "layout-sidebar-panel-group-pull-requests",
      "layout-sidebar-panel-group-file-tree",
      "layout-sidebar-panel-group-sharing",
      "layout-sidebar-panel-group-comments",
    ]);

    const chatsGroup = screen.getByTestId("layout-sidebar-panel-group-chats");
    const chatsRow = within(chatsGroup).getByTestId(
      "layout-sidebar-panel-chats",
    );
    expect(chatsRow).toBeTruthy();
    expect(
      within(chatsGroup).getByTestId("layout-sidebar-panel-artifacts"),
    ).toBeTruthy();
    // Labels come from the registry, not the panel id. Scoped to the row
    // itself, since the card's tabbed-group header repeats the same title.
    expect(within(chatsRow).getByText("Agents")).toBeTruthy();
  });

  it("mirrors panelGroups order in the strip, with a multi-member group's tiles inside its pill", () => {
    const groups: ReadonlyArray<LeftPanelGroup> = [
      { panelIds: ["terminals"] },
      { panelIds: ["chats", "artifacts"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ];
    useLeftPanelStore.getState().applyPanelGroups(groups);
    render(<SidebarLayoutGroup />);

    const strip = screen.getByTestId("layout-sidebar-panel-strip");
    expect(stripTileTestIds(strip)).toEqual([
      "layout-sidebar-panel-tile-terminals",
      "layout-sidebar-panel-tile-chats",
      "layout-sidebar-panel-tile-artifacts",
      "layout-sidebar-panel-tile-browsers",
      "layout-sidebar-panel-tile-git-diff",
      "layout-sidebar-panel-tile-pull-requests",
      "layout-sidebar-panel-tile-file-tree",
      "layout-sidebar-panel-tile-sharing",
      "layout-sidebar-panel-tile-comments",
    ]);

    // "chats" and "artifacts" are the only multi-member group here, so their
    // tiles - and only theirs - live inside the shared pill wrapper.
    const pill = screen.getByTestId("layout-sidebar-panel-pill-chats");
    expect(
      within(pill).getByTestId("layout-sidebar-panel-tile-chats"),
    ).toBeTruthy();
    expect(
      within(pill).getByTestId("layout-sidebar-panel-tile-artifacts"),
    ).toBeTruthy();
  });

  it("re-renders the strip's tile order when the store's panelGroups change", () => {
    render(<SidebarLayoutGroup />);
    const strip = screen.getByTestId("layout-sidebar-panel-strip");
    const initialOrder = stripTileTestIds(strip);

    act(() => {
      useLeftPanelStore
        .getState()
        .applyPanelGroups([
          { panelIds: ["comments"] },
          { panelIds: ["chats", "artifacts"] },
          { panelIds: ["terminals"] },
          { panelIds: ["browsers"] },
          { panelIds: ["git-diff"] },
          { panelIds: ["pull-requests"] },
          { panelIds: ["file-tree"] },
          { panelIds: ["sharing"] },
        ]);
    });

    const nextOrder = stripTileTestIds(strip);
    expect(nextOrder).not.toEqual(initialOrder);
    expect(nextOrder[0]).toBe("layout-sidebar-panel-tile-comments");
  });

  it("dims unchecked panels in place in the strip, rather than removing them", () => {
    render(<SidebarLayoutGroup />);
    const strip = screen.getByTestId("layout-sidebar-panel-strip");

    // Every panel keeps its slot in the strip whether or not its box is
    // checked - the tile count is the panel count, dimmed or not.
    expect(stripTileTestIds(strip)).toHaveLength(9);

    // The dim is on the ICON rather than the tile, so a drop's ring and fill
    // stay at full strength on a panel the user has unchecked.
    expect(isTileIconDimmed("pull-requests")).toBe(true);
    expect(isTileIconDimmed("comments")).toBe(true);
    expect(isTileIconDimmed("chats")).toBe(false);
    expect(
      screen
        .getByTestId("layout-sidebar-panel-tile-pull-requests")
        .classList.contains("opacity-40"),
    ).toBe(false);
  });

  it("draws the rail's tab underline under a pill, and none under a lone tile", () => {
    render(<SidebarLayoutGroup />);

    // The underline is the one mark that makes a pill read as one panel with
    // tabs rather than as two icons that happen to sit together.
    const underline = screen.getByTestId(
      "layout-sidebar-panel-pill-underline-chats",
    );
    expect(
      screen.getByTestId("layout-sidebar-panel-pill-chats").contains(underline),
    ).toBe(true);
    expect(
      screen.queryByTestId("layout-sidebar-panel-pill-underline-terminals"),
    ).toBeNull();
  });

  it("gives a tabbed group's card a header naming its members, and no header to a single-panel card", () => {
    render(<SidebarLayoutGroup />);

    const header = screen.getByTestId(
      "layout-sidebar-panel-group-header-chats",
    );
    expect(header.textContent).toContain("Tabbed panel");
    expect(within(header).getByText("Agents")).toBeTruthy();
    expect(within(header).getByText("Artifacts")).toBeTruthy();

    // "terminals" is alone in its card by default - nothing to tab between.
    expect(
      screen.queryByTestId("layout-sidebar-panel-group-header-terminals"),
    ).toBeNull();
  });

  it("keeps every drag surface inside the strip, leaving the cards inert", () => {
    render(<SidebarLayoutGroup />);
    const panels = screen.getByTestId("layout-sidebar-panels");
    const strip = screen.getByTestId("layout-sidebar-panel-strip");

    // dnd-kit's listeners leave no trace in the DOM, so the mark to look for
    // is the one a pointer drag surface cannot do without: `touch-none`, which
    // stops the browser scrolling instead of dragging. Any handle
    // reintroduced on a card would have to carry it, whatever it was called.
    const dragSurfaces = Array.from(panels.querySelectorAll(".touch-none"));
    expect(dragSurfaces.length).toBe(9);
    for (const element of dragSurfaces) {
      expect(strip.contains(element)).toBe(true);
    }

    // ... and no card renders a tile, the only thing the strip drags.
    for (const card of cardElements(panels)) {
      expect(
        card.querySelector('[data-testid^="layout-sidebar-panel-tile-"]'),
      ).toBeNull();
    }
  });
});

describe("<SidebarLayoutGroup /> checkbox state", () => {
  it("leaves presence-gated panels unchecked by default", () => {
    render(<SidebarLayoutGroup />);

    expect(
      screen
        .getByRole("checkbox", { name: "Pull Requests" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("checkbox", { name: "Comments" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("checkbox", { name: "Agents" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("checks a presence-gated panel forced on by an override", () => {
    useLeftPanelStore
      .getState()
      .setPanelVisibilityOverride("pull-requests", true);
    render(<SidebarLayoutGroup />);

    expect(
      screen
        .getByRole("checkbox", { name: "Pull Requests" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("<SidebarLayoutGroup /> checkbox writes", () => {
  it("stores false for unchecking an always-available panel", () => {
    render(<SidebarLayoutGroup />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Agents" }));

    expect(useLeftPanelStore.getState().panelVisibilityOverrideById.chats).toBe(
      false,
    );
  });

  it("drops the override key when re-checking back to the panel's own rule", () => {
    useLeftPanelStore.getState().setPanelVisibilityOverride("chats", false);
    render(<SidebarLayoutGroup />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Agents" }));

    expect(
      Object.hasOwn(
        useLeftPanelStore.getState().panelVisibilityOverrideById,
        "chats",
      ),
    ).toBe(false);
  });

  it("stores true for checking a presence-gated panel", () => {
    render(<SidebarLayoutGroup />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Pull Requests" }));

    expect(
      useLeftPanelStore.getState().panelVisibilityOverrideById["pull-requests"],
    ).toBe(true);
  });

  it("preserves an explicit false through a check-then-uncheck round trip on a presence-gated panel", () => {
    useLeftPanelStore
      .getState()
      .setPanelVisibilityOverride("pull-requests", false);
    render(<SidebarLayoutGroup />);
    const checkbox = screen.getByRole("checkbox", { name: "Pull Requests" });

    fireEvent.click(checkbox);
    expect(
      useLeftPanelStore.getState().panelVisibilityOverrideById["pull-requests"],
    ).toBe(true);

    fireEvent.click(checkbox);
    expect(
      useLeftPanelStore.getState().panelVisibilityOverrideById["pull-requests"],
    ).toBe(false);
  });

  it("stores an explicit false rather than dropping the key when unchecking a forced-on presence-gated panel", () => {
    useLeftPanelStore
      .getState()
      .setPanelVisibilityOverride("pull-requests", true);
    render(<SidebarLayoutGroup />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Pull Requests" }));

    expect(
      useLeftPanelStore.getState().panelVisibilityOverrideById["pull-requests"],
    ).toBe(false);
  });
});

describe("<SidebarLayoutGroup /> row menu actions", () => {
  it("moves a panel down within its group via 'Move down'", () => {
    render(<SidebarLayoutGroup />);
    const chatsRow = screen.getByTestId("layout-sidebar-panel-chats");
    fireEvent.click(
      within(chatsRow).getByRole("menuitem", { name: "Move down" }),
    );

    expect(useLeftPanelStore.getState().getPanelGroups()[0]).toEqual({
      panelIds: ["artifacts", "chats"],
    });
  });

  it("groups a panel with the card above it via 'Group with panel above'", () => {
    render(<SidebarLayoutGroup />);
    const browsersRow = screen.getByTestId("layout-sidebar-panel-browsers");
    fireEvent.click(
      within(browsersRow).getByRole("menuitem", {
        name: "Group with panel above",
      }),
    );

    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["chats", "artifacts"] },
      { panelIds: ["terminals", "browsers"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("ungroups a panel via 'Move out of group'", () => {
    render(<SidebarLayoutGroup />);
    const artifactsRow = screen.getByTestId("layout-sidebar-panel-artifacts");
    fireEvent.click(
      within(artifactsRow).getByRole("menuitem", {
        name: "Move out of group",
      }),
    );

    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["artifacts"] },
      { panelIds: ["terminals"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });
});

describe("<SidebarLayoutGroup /> row menu focus restoration", () => {
  // Each action is exercised on a grouping where it actually moves the row
  // into a card led by a DIFFERENT panel - the case that unmounts the row's
  // own menu trigger (a card is keyed by its first panel) and used to strand
  // focus on <body>. A same-card reorder keeps the leading panel unchanged,
  // so it would not exercise the remount this guards against.
  const THREE_PANEL_FIRST_GROUP: ReadonlyArray<LeftPanelGroup> = [
    { panelIds: ["chats", "artifacts", "terminals"] },
    { panelIds: ["browsers"] },
    { panelIds: ["git-diff"] },
    { panelIds: ["pull-requests"] },
    { panelIds: ["file-tree"] },
    { panelIds: ["sharing"] },
    { panelIds: ["comments"] },
  ];

  it("refocuses the moved panel's trigger after 'Move up' changes its card", () => {
    useLeftPanelStore.getState().applyPanelGroups(THREE_PANEL_FIRST_GROUP);
    render(<SidebarLayoutGroup />);
    const artifactsRow = screen.getByTestId("layout-sidebar-panel-artifacts");
    fireEvent.click(
      within(artifactsRow).getByRole("menuitem", { name: "Move up" }),
    );

    expect(useLeftPanelStore.getState().getPanelGroups()[0]).toEqual({
      panelIds: ["artifacts", "chats", "terminals"],
    });
    expect(document.activeElement).toBe(
      screen.getByTestId("layout-sidebar-panel-menu-artifacts"),
    );
  });

  it("refocuses the moved panel's trigger after 'Move down' changes its card", () => {
    useLeftPanelStore.getState().applyPanelGroups(THREE_PANEL_FIRST_GROUP);
    render(<SidebarLayoutGroup />);
    const chatsRow = screen.getByTestId("layout-sidebar-panel-chats");
    fireEvent.click(
      within(chatsRow).getByRole("menuitem", { name: "Move down" }),
    );

    expect(useLeftPanelStore.getState().getPanelGroups()[0]).toEqual({
      panelIds: ["artifacts", "chats", "terminals"],
    });
    expect(document.activeElement).toBe(
      screen.getByTestId("layout-sidebar-panel-menu-chats"),
    );
  });

  it("refocuses the moved panel's trigger after 'Group with panel above' changes its card", () => {
    render(<SidebarLayoutGroup />);
    const browsersRow = screen.getByTestId("layout-sidebar-panel-browsers");
    fireEvent.click(
      within(browsersRow).getByRole("menuitem", {
        name: "Group with panel above",
      }),
    );

    expect(document.activeElement).toBe(
      screen.getByTestId("layout-sidebar-panel-menu-browsers"),
    );
  });

  it("refocuses the moved panel's trigger after 'Move out of group' changes its card", () => {
    render(<SidebarLayoutGroup />);
    const artifactsRow = screen.getByTestId("layout-sidebar-panel-artifacts");
    fireEvent.click(
      within(artifactsRow).getByRole("menuitem", {
        name: "Move out of group",
      }),
    );

    expect(document.activeElement).toBe(
      screen.getByTestId("layout-sidebar-panel-menu-artifacts"),
    );
  });
});

describe("<SidebarLayoutGroup /> row menu announcement", () => {
  it("names the moved panel and its new placement after a move", () => {
    render(<SidebarLayoutGroup />);
    const chatsRow = screen.getByTestId("layout-sidebar-panel-chats");
    fireEvent.click(
      within(chatsRow).getByRole("menuitem", { name: "Move down" }),
    );

    // `DndContext` renders its own assertive `role="status"` live region
    // alongside the list's own polite one, so disambiguate by content rather
    // than assuming there is only one status role on the page.
    const statusElements = screen.getAllByRole("status");
    const announcement = statusElements.find((element) =>
      element.textContent.includes("is now panel"),
    );
    expect(announcement).not.toBeUndefined();
    const announcementText =
      announcement === undefined ? "" : announcement.textContent;
    expect(announcementText).toContain("Agents");
    expect(announcementText).toContain("panel 2 of 9");
    expect(announcementText).toContain("grouped with Artifacts");
  });
});

describe("<SidebarLayoutGroup /> reset buttons", () => {
  it("disables 'Reset panel visibility' with no overrides, enables and clears it otherwise", () => {
    render(<SidebarLayoutGroup />);
    const resetVisibility = screen.getByRole("button", {
      name: "Reset panel visibility",
    });
    expect(resetVisibility.hasAttribute("disabled")).toBe(true);

    act(() => {
      useLeftPanelStore.getState().setPanelVisibilityOverride("chats", false);
    });
    expect(resetVisibility.hasAttribute("disabled")).toBe(false);

    fireEvent.click(resetVisibility);
    expect(useLeftPanelStore.getState().panelVisibilityOverrideById).toEqual(
      {},
    );
  });

  it("disables 'Reset order' at the default order, enables and restores it otherwise", () => {
    render(<SidebarLayoutGroup />);
    const resetOrder = screen.getByRole("button", { name: "Reset order" });
    expect(resetOrder.hasAttribute("disabled")).toBe(true);

    act(() => {
      useLeftPanelStore
        .getState()
        .applyPanelGroups([
          { panelIds: ["terminals"] },
          { panelIds: ["chats", "artifacts"] },
          { panelIds: ["browsers"] },
          { panelIds: ["git-diff"] },
          { panelIds: ["pull-requests"] },
          { panelIds: ["file-tree"] },
          { panelIds: ["sharing"] },
          { panelIds: ["comments"] },
        ]);
    });
    expect(resetOrder.hasAttribute("disabled")).toBe(false);

    fireEvent.click(resetOrder);
    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual(
      DEFAULT_LEFT_PANEL_GROUPS,
    );
  });
});

describe("<SidebarLayoutGroup /> narrow viewport", () => {
  it("replaces the panel list with a note, keeping the resource-chips switch", () => {
    viewport.mobile = true;
    render(<SidebarLayoutGroup />);

    expect(screen.queryByTestId("layout-sidebar-panels")).toBeNull();
    expect(screen.getByText("Panel layout needs the sidebar")).toBeTruthy();
    expect(
      screen.getByRole("switch", {
        name: "Show resource chips on sidebar rows",
      }),
    ).toBeTruthy();
  });
});
