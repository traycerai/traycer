import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import {
  ReadingWidthRow,
  ResourceReadingsRow,
  SidebarSideRow,
  SideStripViewRow,
  TabOverflowRow,
  TabStripPositionRow,
  WideReadingWidthRow,
} from "@/components/layout-editor/inspector/rows/surface-placement-rows";
import { setMobileApp } from "@/lib/mobile-app";
import { readPendingLayoutLanding } from "@/lib/settings-navigation";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The Task tabs surface's Placement, Side tab view and Tab overflow rows, and
 * the Sidebar surface's Side and Resource readings rows. Each
 * arrangement-backed row writes the stored arrangement, a write inside a
 * session is one undo step that Discard puts back, and the revert shows only
 * while the value differs from the shipped one. Resource readings writes a
 * region value instead of the arrangement, through the same
 * `region-control-io` seam every other region control uses.
 */

function historyDepth(): number {
  return useLayoutEditorStore.getState().history.past.length;
}

function pick(group: string, label: string): void {
  const radiogroup = screen.getByRole("radiogroup", { name: group });
  const option = Array.from(
    radiogroup.querySelectorAll<HTMLElement>("[role='radio']"),
  ).find((node) => node.textContent === label);
  if (option === undefined) throw new Error(`no option ${label} in ${group}`);
  fireEvent.click(option);
}

/**
 * `SideStripViewRow`'s options are `PicturedOptions`: each radio's picture
 * draws real sample content (the strip's own task rows), so its `textContent`
 * is not the option's label the way a `SegmentedControl` option's is. The
 * label lives on `aria-label` instead (the picture is `inert`, out of the
 * accessible-name computation), which is what `pick` above cannot match.
 */
function pickPictured(group: string, label: string): void {
  fireEvent.click(
    within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", {
      name: label,
    }),
  );
}

function beginSession(): void {
  useLayoutEditorStore.getState().beginSession({
    entry: "keyboard",
    source: "direct_ui",
    startedAt: 0,
    origin: { kind: "tab" },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
});

afterEach(() => {
  cleanup();
  setMobileApp(false);
  setSystemTabModalApi(null);
  useLayoutEditorStore.getState().setFilter("");
  useLayoutEditorStore.getState().endSession();
});

describe("<TabStripPositionRow />", () => {
  it("draws Top / Left / Right over the stored placement", () => {
    render(<TabStripPositionRow />);

    const options = Array.from(
      screen
        .getByRole("radiogroup", { name: "Tab placement" })
        .querySelectorAll("[role='radio']"),
    );
    expect(options.map((node) => node.textContent)).toEqual([
      "Top",
      "Left",
      "Right",
    ]);
    expect(options.map((node) => node.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(screen.getByText("Placement")).toBeTruthy();
  });

  it("writes the store at rest, with no history", () => {
    render(<TabStripPositionRow />);

    pick("Tab placement", "Left");

    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
      "left",
    );
    expect(historyDepth()).toBe(0);
  });

  it("is one undo step in a session, and Discard puts it back", () => {
    beginSession();
    render(<TabStripPositionRow />);

    pick("Tab placement", "Right");
    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
      "right",
    );
    expect(historyDepth()).toBe(1);

    useLayoutEditorStore.getState().undo();
    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe("top");

    useLayoutEditorStore.getState().redo();
    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
      "right",
    );

    useLayoutEditorStore.getState().discard();
    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe("top");
  });

  it("offers a revert only while the placement differs from the shipped one", () => {
    render(<TabStripPositionRow />);
    expect(
      screen.queryByRole("button", {
        name: "Reset tab placement to default: Top",
      }),
    ).toBeNull();

    pick("Tab placement", "Left");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset tab placement to default: Top",
      }),
    );

    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe("top");
    expect(
      screen.queryByRole("button", {
        name: "Reset tab placement to default: Top",
      }),
    ).toBeNull();
  });
});

describe("<SideStripViewRow /> (D8)", () => {
  function withVerticalStrip(): void {
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: {
        ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
        tabStripPlacement: "left",
      },
    });
  }

  it("draws Tabs only / Tabs and agents over the stored view", () => {
    render(<SideStripViewRow />);

    const options = Array.from(
      screen
        .getByRole("radiogroup", { name: "Side tab view" })
        .querySelectorAll("[role='radio']"),
    );
    // Each option's picture draws real sample content, so its accessible
    // name - not its full textContent - is the option's own label.
    expect(options.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Tabs only",
      "Tabs and agents",
    ]);
    expect(options.map((node) => node.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
    expect(screen.getByText("Side tab view")).toBeTruthy();
  });

  it("draws the sample agent rows in the Tabs and agents picture, and none in Tabs only", () => {
    render(<SideStripViewRow />);

    const tabsOnly = screen.getByRole("radio", { name: "Tabs only" });
    const tabsAndAgents = screen.getByRole("radio", {
      name: "Tabs and agents",
    });
    // The radio sits over its card's picture, as a sibling of it.
    const tabsOnlyCard = tabsOnly.parentElement;
    const tabsAndAgentsCard = tabsAndAgents.parentElement;
    if (tabsOnlyCard === null || tabsAndAgentsCard === null) {
      throw new Error("a radio has no card");
    }
    expect(
      within(tabsOnlyCard).queryByTestId("app-frame-live-agents"),
    ).toBeNull();
    expect(
      within(tabsAndAgentsCard).getByTestId("app-frame-live-agents"),
    ).toBeTruthy();
  });

  it("is not selected-highlighted at rest, and highlighted once its setting is selected", () => {
    render(<SideStripViewRow />);
    const rowElement = (): HTMLElement => {
      const node = screen
        .getByText("Side tab view")
        .closest("[data-layout-form-row]");
      if (node === null) throw new Error("expected a data-layout-form-row");
      return node as HTMLElement;
    };
    expect(rowElement().className).not.toContain("bg-foreground/6");

    act(() => {
      useLayoutEditorStore.setState({ selectedSetting: "sideStripView" });
    });
    expect(rowElement().className).toContain("bg-foreground/6");
  });

  it("is disabled with a reason while the tabs are at the top, which is the shipped default", () => {
    render(<SideStripViewRow />);

    const options = screen
      .getByRole("radiogroup", { name: "Side tab view" })
      .querySelectorAll<HTMLButtonElement>("[role='radio']");
    expect([...options].every((option) => option.disabled)).toBe(true);
    expect(
      screen.getByText("Available when tabs are on the left or right."),
    ).toBeTruthy();
  });

  it("is enabled with no status once the tabs move to a vertical strip", () => {
    withVerticalStrip();
    render(<SideStripViewRow />);

    const options = screen
      .getByRole("radiogroup", { name: "Side tab view" })
      .querySelectorAll<HTMLButtonElement>("[role='radio']");
    expect([...options].every((option) => option.disabled)).toBe(false);
    expect(
      screen.queryByText("Available when tabs are on the left or right."),
    ).toBeNull();
  });

  it("writes the store at rest, with no history", () => {
    withVerticalStrip();
    render(<SideStripViewRow />);

    pickPictured("Side tab view", "Tabs and agents");

    expect(useLayoutStore.getState().arrangement.sideStripView).toBe(
      "activity",
    );
    expect(historyDepth()).toBe(0);
  });

  it("is one undo step in a session, and Discard puts it back", () => {
    withVerticalStrip();
    beginSession();
    render(<SideStripViewRow />);

    pickPictured("Side tab view", "Tabs and agents");
    expect(useLayoutStore.getState().arrangement.sideStripView).toBe(
      "activity",
    );
    expect(historyDepth()).toBe(1);

    useLayoutEditorStore.getState().undo();
    expect(useLayoutStore.getState().arrangement.sideStripView).toBe("layered");

    useLayoutEditorStore.getState().redo();
    expect(useLayoutStore.getState().arrangement.sideStripView).toBe(
      "activity",
    );

    useLayoutEditorStore.getState().discard();
    expect(useLayoutStore.getState().arrangement.sideStripView).toBe("layered");
  });

  it("offers a revert only while the view differs from the shipped one", () => {
    withVerticalStrip();
    render(<SideStripViewRow />);
    expect(
      screen.queryByRole("button", {
        name: "Reset side tab view to default: Tabs only",
      }),
    ).toBeNull();

    pickPictured("Side tab view", "Tabs and agents");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset side tab view to default: Tabs only",
      }),
    );

    expect(useLayoutStore.getState().arrangement.sideStripView).toBe("layered");
    expect(
      screen.queryByRole("button", {
        name: "Reset side tab view to default: Tabs only",
      }),
    ).toBeNull();
  });
});

describe("<SidebarSideRow />", () => {
  it("draws Left / Right over the stored side", () => {
    render(<SidebarSideRow />);

    const options = Array.from(
      screen
        .getByRole("radiogroup", { name: "Sidebar side" })
        .querySelectorAll("[role='radio']"),
    );
    expect(options.map((node) => node.textContent)).toEqual(["Left", "Right"]);
    expect(options.map((node) => node.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
    expect(screen.getByText("Side")).toBeTruthy();
  });

  it("writes the store at rest", () => {
    render(<SidebarSideRow />);

    pick("Sidebar side", "Right");

    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("right");
    expect(historyDepth()).toBe(0);
  });

  it("is one undo step in a session, and Discard puts it back", () => {
    beginSession();
    render(<SidebarSideRow />);

    pick("Sidebar side", "Right");
    expect(historyDepth()).toBe(1);

    useLayoutEditorStore.getState().undo();
    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("left");

    useLayoutEditorStore.getState().redo();
    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("right");

    useLayoutEditorStore.getState().discard();
    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("left");
  });

  it("offers a revert only while the side differs from the shipped one", () => {
    render(<SidebarSideRow />);
    expect(
      screen.queryByRole("button", {
        name: "Reset sidebar side to default",
      }),
    ).toBeNull();

    pick("Sidebar side", "Right");
    fireEvent.click(
      screen.getByRole("button", { name: "Reset sidebar side to default" }),
    );

    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("left");
    expect(
      screen.queryByRole("button", {
        name: "Reset sidebar side to default",
      }),
    ).toBeNull();
  });

  it("keeps focus in the row when its ↺ unmounts, moving it to a sibling control", () => {
    render(<SidebarSideRow />);
    pick("Sidebar side", "Right");

    const revertButton = screen.getByRole("button", {
      name: "Reset sidebar side to default",
    });
    const row = revertButton.closest("[data-layout-form-row]");
    if (row === null)
      throw new Error("expected a data-layout-form-row ancestor");
    revertButton.focus();
    fireEvent.click(revertButton);

    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("left");
    expect(
      screen.queryByRole("button", {
        name: "Reset sidebar side to default",
      }),
    ).toBeNull();
    expect(row.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("<ReadingWidthRow />", () => {
  it("draws Comfortable / Wide over the stored width", () => {
    render(<ReadingWidthRow />);

    const options = Array.from(
      screen
        .getByRole("radiogroup", { name: "Reading width" })
        .querySelectorAll("[role='radio']"),
    );
    expect(options.map((node) => node.textContent)).toEqual([
      "Comfortable",
      "Wide",
    ]);
    expect(options.map((node) => node.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
  });

  it("writes arrangement.readingWidth", () => {
    render(<ReadingWidthRow />);

    pick("Reading width", "Wide");

    expect(useLayoutStore.getState().arrangement.readingWidth).toBe("wide");
    expect(historyDepth()).toBe(0);
  });

  it("offers a revert only while wide, and it restores comfortable", () => {
    render(<ReadingWidthRow />);
    expect(
      screen.queryByRole("button", {
        name: "Reset reading width to default: Comfortable",
      }),
    ).toBeNull();

    pick("Reading width", "Wide");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset reading width to default: Comfortable",
      }),
    );

    expect(useLayoutStore.getState().arrangement.readingWidth).toBe(
      "comfortable",
    );
    expect(
      screen.queryByRole("button", {
        name: "Reset reading width to default: Comfortable",
      }),
    ).toBeNull();
  });
});

/**
 * The slider row beneath Reading width - visible only while "Wide" is
 * picked (the same conditional-row-visibility precedent the fine-tune
 * "Display" row uses in `surface-section.tsx`), floored at 1024 (today's
 * fixed wide column) and reverting to it.
 */
describe("<WideReadingWidthRow />", () => {
  it("renders nothing while reading width is comfortable", () => {
    const { container } = render(<WideReadingWidthRow />);

    expect(container.firstChild).toBeNull();
  });

  it("draws the slider at the stored width, with no revert at the default", () => {
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: {
        ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
        readingWidth: "wide",
      },
    });

    render(<WideReadingWidthRow />);

    const slider = screen.getByRole("slider", { name: "Wide column width" });
    expect(slider.getAttribute("aria-valuenow")).toBe("1024");
    expect(
      screen.queryByRole("button", {
        name: "Reset wide column width to default: 1024px",
      }),
    ).toBeNull();
  });

  it("offers a revert once the width differs from the default, and it restores 1024", () => {
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: {
        ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
        readingWidth: "wide",
        wideReadingWidthPx: 1600,
      },
    });

    render(<WideReadingWidthRow />);

    const slider = screen.getByRole("slider", { name: "Wide column width" });
    expect(slider.getAttribute("aria-valuenow")).toBe("1600");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset wide column width to default: 1024px",
      }),
    );

    expect(useLayoutStore.getState().arrangement.wideReadingWidthPx).toBe(1024);
  });
});

describe("<TabOverflowRow />", () => {
  function withVerticalStrip(): void {
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: {
        ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
        tabStripPlacement: "left",
      },
    });
  }

  it("draws Scroll / Shrink to fit over the stored layout", () => {
    render(<TabOverflowRow />);

    const options = Array.from(
      screen
        .getByRole("radiogroup", { name: "Tab overflow" })
        .querySelectorAll("[role='radio']"),
    );
    expect(options.map((node) => node.textContent)).toEqual([
      "Scroll",
      "Shrink to fit",
    ]);
    expect(options.map((node) => node.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
    expect(screen.getByText("Tab overflow")).toBeTruthy();
  });

  it("is enabled with no status while the tabs sit at the top, the shipped default", () => {
    render(<TabOverflowRow />);

    const options = screen
      .getByRole("radiogroup", { name: "Tab overflow" })
      .querySelectorAll<HTMLButtonElement>("[role='radio']");
    expect([...options].every((option) => option.disabled)).toBe(false);
    expect(
      screen.queryByText("Available when tabs are at the top."),
    ).toBeNull();
  });

  it("is disabled with a reason once the tabs move to a side, which never scrolls or shrinks its own", () => {
    withVerticalStrip();
    render(<TabOverflowRow />);

    const options = screen
      .getByRole("radiogroup", { name: "Tab overflow" })
      .querySelectorAll<HTMLButtonElement>("[role='radio']");
    expect([...options].every((option) => option.disabled)).toBe(true);
    expect(
      screen.getByText("Available when tabs are at the top."),
    ).toBeTruthy();
  });

  it("writes the store at rest, with no history", () => {
    render(<TabOverflowRow />);

    pick("Tab overflow", "Shrink to fit");

    expect(useLayoutStore.getState().arrangement.taskTabLayout).toBe("shrink");
    expect(historyDepth()).toBe(0);
  });

  it("is one undo step in a session, and Discard puts it back", () => {
    beginSession();
    render(<TabOverflowRow />);

    pick("Tab overflow", "Shrink to fit");
    expect(useLayoutStore.getState().arrangement.taskTabLayout).toBe("shrink");
    expect(historyDepth()).toBe(1);

    useLayoutEditorStore.getState().undo();
    expect(useLayoutStore.getState().arrangement.taskTabLayout).toBe("scroll");

    useLayoutEditorStore.getState().redo();
    expect(useLayoutStore.getState().arrangement.taskTabLayout).toBe("shrink");

    useLayoutEditorStore.getState().discard();
    expect(useLayoutStore.getState().arrangement.taskTabLayout).toBe("scroll");
  });

  it("offers a revert only while the value differs from the shipped default", () => {
    render(<TabOverflowRow />);
    expect(
      screen.queryByRole("button", {
        name: "Reset tab overflow to default: Scroll",
      }),
    ).toBeNull();

    pick("Tab overflow", "Shrink to fit");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset tab overflow to default: Scroll",
      }),
    );

    expect(useLayoutStore.getState().arrangement.taskTabLayout).toBe("scroll");
    expect(
      screen.queryByRole("button", {
        name: "Reset tab overflow to default: Scroll",
      }),
    ).toBeNull();
  });
});

describe("<ResourceReadingsRow /> (G7)", () => {
  it("draws the shipped default: on", () => {
    render(<ResourceReadingsRow />);

    expect(
      screen
        .getByRole("switch", { name: "Readings on agent rows" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("stays operable while the Resource monitor itself is Hidden - it tunes the sidebar, not the monitor", () => {
    useLayoutStore.getState().setRegionValues("resourceMonitor", {
      shown: "hidden",
    });
    render(<ResourceReadingsRow />);

    const toggle = screen.getByRole("switch", {
      name: "Readings on agent rows",
    });
    expect(toggle.hasAttribute("disabled")).toBe(false);

    fireEvent.click(toggle);

    expect(useLayoutStore.getState().overrides.resourceMonitor?.agentRows).toBe(
      false,
    );
    // The monitor's own Hidden is untouched by this write.
    expect(useLayoutStore.getState().overrides.resourceMonitor?.shown).toBe(
      "hidden",
    );
  });

  it("offers a revert only while it differs from the shipped default", () => {
    render(<ResourceReadingsRow />);
    expect(
      screen.queryByRole("button", { name: "Reset readings on agent rows" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("switch", { name: "Readings on agent rows" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reset readings on agent rows" }),
    );

    expect(
      useLayoutStore.getState().overrides.resourceMonitor?.agentRows,
    ).toBeUndefined();
    expect(
      screen.queryByRole("button", { name: "Reset readings on agent rows" }),
    ).toBeNull();
  });
});

describe("<ResourceReadingsRow /> Choose metrics link (L-174)", () => {
  it("in the inspector host, opens the Resource monitor's row expanded", () => {
    render(<ResourceReadingsRow />);

    fireEvent.click(screen.getByRole("button", { name: "Choose metrics" }));

    const state = useLayoutEditorStore.getState();
    expect(state.area).toBe("statusBar");
    expect(state.selected).toBe("resourceMonitor");
    expect(state.openRows).toContain("resourceMonitor");
  });

  it("in the page host, navigates Settings to the Resource monitor's row instead", () => {
    setSystemTabModalApi({
      active: null,
      openSettings: vi.fn(),
      openHistory: vi.fn(),
      close: vi.fn(),
      setSection: vi.fn(),
      promoteToTab: vi.fn(),
      isOverlayActive: () => true,
    });
    render(
      <LayoutFormHostContext value="page">
        <ResourceReadingsRow />
      </LayoutFormHostContext>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose metrics" }));

    expect(readPendingLayoutLanding()?.target).toEqual({
      kind: "region",
      regionId: "resourceMonitor",
    });
    // The docked editor's own selection is untouched by the page host.
    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });
});

describe("<RevertButton /> (inspector-row.tsx)", () => {
  it("still calls onRevert with no [data-sortable-id]/[data-layout-form-row] row ancestor", () => {
    const onRevert = vi.fn();
    render(<RevertButton onRevert={onRevert} label="Revert something" />);

    fireEvent.click(screen.getByRole("button", { name: "Revert something" }));

    expect(onRevert).toHaveBeenCalledOnce();
  });
});

describe("in the installed mobile app", () => {
  it("draws none of the three rows (S-39)", () => {
    setMobileApp(true);
    render(
      <>
        <TabStripPositionRow />
        <SideStripViewRow />
        <SidebarSideRow />
      </>,
    );

    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
