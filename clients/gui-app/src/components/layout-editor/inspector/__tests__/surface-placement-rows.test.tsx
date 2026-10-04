import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import {
  ReadingWidthRow,
  ResourceReadingsRow,
  SidebarSideRow,
  SideStripViewRow,
  SurfaceAreaRows,
  TabOverflowRow,
  TabStripPositionRow,
} from "@/components/layout-editor/inspector/rows/surface-placement-rows";
import { useLayoutFormContext } from "@/components/layout-editor/inspector/use-layout-form-context";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import {
  LIVE,
  type ShownRowAvailability,
} from "@/components/layout-editor/regions/row-availability";
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
 *
 * Every row takes what the registry says about it (`availability`, `depth`),
 * which is `SurfaceAreaRows`' to place (`regions/area-rows.ts`, P1). A test
 * about a control's own write hands the row a plain live answer; a test about
 * WHEN a row is disabled or absent goes through `AreaRows`, which draws the
 * area's rows by the one form context exactly as the form does.
 */

/** A row the registry leaves plain: what a write test needs and nothing more. */
const LIVE_ROW: {
  readonly availability: ShownRowAvailability;
  readonly depth: 0 | 1;
} = { availability: LIVE, depth: 0 };

/** One area's own rows on one side of its lists, drawn as the form draws them. */
function AreaRows(props: {
  readonly surface: SurfaceGroupId;
  readonly place: "leading" | "trailing";
}): ReactNode {
  const context = useLayoutFormContext();
  return (
    <SurfaceAreaRows
      surface={props.surface}
      place={props.place}
      context={context}
    />
  );
}

/** The Readings row over the live form context its switch is read from. */
function ResourceReadings(): ReactNode {
  const context = useLayoutFormContext();
  return <ResourceReadingsRow {...LIVE_ROW} context={context} />;
}

/** The row's control group - the fieldset the registry's answer disables. */
function controlGroupOf(label: string): HTMLFieldSetElement {
  const row = screen.getByText(label).closest("[data-layout-form-row]");
  const group = row?.querySelector("fieldset");
  if (!(group instanceof HTMLFieldSetElement)) {
    throw new Error(`${label} has no control group`);
  }
  return group;
}

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
    render(<TabStripPositionRow {...LIVE_ROW} />);

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
    render(<TabStripPositionRow {...LIVE_ROW} />);

    pick("Tab placement", "Left");

    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
      "left",
    );
    expect(historyDepth()).toBe(0);
  });

  it("is one undo step in a session, and Discard puts it back", () => {
    beginSession();
    render(<TabStripPositionRow {...LIVE_ROW} />);

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
    render(<TabStripPositionRow {...LIVE_ROW} />);
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
    render(<SideStripViewRow {...LIVE_ROW} />);

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
    render(<SideStripViewRow {...LIVE_ROW} />);

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
    render(<SideStripViewRow {...LIVE_ROW} />);
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
    render(<AreaRows surface="topBar" place="leading" />);

    const options = screen
      .getByRole("radiogroup", { name: "Side tab view" })
      .querySelectorAll<HTMLButtonElement>("[role='radio']");
    expect([...options].every((option) => option.disabled)).toBe(true);
    const reason = screen.getByText(
      "Set Placement to Left or Right to use this.",
    );
    expect(reason.getAttribute("data-row-availability")).toBe("disabled");
    // The group is disabled and described by the reason, so it is heard on
    // the control it explains.
    const group = controlGroupOf("Side tab view");
    expect(group.disabled).toBe(true);
    expect(group.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("is enabled with no status once the tabs move to a vertical strip", () => {
    withVerticalStrip();
    render(<AreaRows surface="topBar" place="leading" />);

    const options = screen
      .getByRole("radiogroup", { name: "Side tab view" })
      .querySelectorAll<HTMLButtonElement>("[role='radio']");
    expect([...options].every((option) => option.disabled)).toBe(false);
    expect(
      screen.queryByText("Set Placement to Left or Right to use this."),
    ).toBeNull();
    expect(controlGroupOf("Side tab view").disabled).toBe(false);
  });

  it("draws Tab overflow, then Side tab view, one level under Placement - the live one first at the shipped default", () => {
    render(<AreaRows surface="topBar" place="leading" />);

    const rows = ["Placement", "Tab overflow", "Side tab view"].map((label) => {
      const row = screen.getByText(label).closest("[data-layout-form-row]");
      if (row === null) throw new Error(`${label} is not a form row`);
      return row;
    });
    expect(rows.map((row) => row.getAttribute("data-row-depth"))).toEqual([
      "0",
      "1",
      "1",
    ]);
    // Nothing else is drawn, and in this order.
    const drawn = [...document.querySelectorAll("[data-layout-form-row]")];
    expect(drawn).toHaveLength(rows.length);
    rows.forEach((row, index) => {
      expect(drawn[index]).toBe(row);
    });
  });

  it("writes the store at rest, with no history", () => {
    withVerticalStrip();
    render(<SideStripViewRow {...LIVE_ROW} />);

    pickPictured("Side tab view", "Tabs and agents");

    expect(useLayoutStore.getState().arrangement.sideStripView).toBe(
      "activity",
    );
    expect(historyDepth()).toBe(0);
  });

  it("is one undo step in a session, and Discard puts it back", () => {
    withVerticalStrip();
    beginSession();
    render(<SideStripViewRow {...LIVE_ROW} />);

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
    render(<SideStripViewRow {...LIVE_ROW} />);
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
    render(<SidebarSideRow {...LIVE_ROW} />);

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
    render(<SidebarSideRow {...LIVE_ROW} />);

    pick("Sidebar side", "Right");

    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("right");
    expect(historyDepth()).toBe(0);
  });

  it("is one undo step in a session, and Discard puts it back", () => {
    beginSession();
    render(<SidebarSideRow {...LIVE_ROW} />);

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
    render(<SidebarSideRow {...LIVE_ROW} />);
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
    render(<SidebarSideRow {...LIVE_ROW} />);
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
    render(<ReadingWidthRow {...LIVE_ROW} />);

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
    render(<ReadingWidthRow {...LIVE_ROW} />);

    pick("Reading width", "Wide");

    expect(useLayoutStore.getState().arrangement.readingWidth).toBe("wide");
    expect(historyDepth()).toBe(0);
  });

  it("offers a revert only while wide, and it restores comfortable", () => {
    render(<ReadingWidthRow {...LIVE_ROW} />);
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
 * The slider row beneath Reading width - always drawn, one level in, and
 * disabled with its reason while Comfortable is picked (C5: the slider does
 * not come and go with the choice above it), floored at 1024 (today's fixed
 * wide column) and reverting to it. Drawn through the registry, as the form
 * draws it, since which of those it is IS the registry's answer.
 */
describe("the Wide column width row", () => {
  function withWideReading(): void {
    useLayoutStore.setState({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: {
        ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
        readingWidth: "wide",
      },
    });
  }

  it("stays drawn, disabled and saying why, while reading width is comfortable", () => {
    render(<AreaRows surface="chat" place="leading" />);

    const row = screen
      .getByText("Wide column width")
      .closest("[data-layout-form-row]");
    expect(row?.getAttribute("data-row-depth")).toBe("1");
    expect(row?.getAttribute("data-row-availability")).toBe("disabled");
    // What the width would be, still said while it does nothing.
    expect(
      screen.getByText("1024px. Never wider than the pane it is in."),
    ).toBeTruthy();
    const reason = screen.getByText("Set Reading width to Wide to use this.");
    expect(reason.getAttribute("data-row-availability")).toBe("disabled");
    const group = controlGroupOf("Wide column width");
    expect(group.disabled).toBe(true);
    expect(group.getAttribute("aria-describedby")).toBe(reason.id);
    // A thumb is not a form control: the row tells the slider itself.
    expect(
      screen
        .getByRole("slider", { name: "Wide column width" })
        .hasAttribute("data-disabled"),
    ).toBe(true);
  });

  it("becomes operable, with no status, once reading width is wide", () => {
    withWideReading();
    render(<AreaRows surface="chat" place="leading" />);

    expect(
      screen
        .getByText("Wide column width")
        .closest("[data-layout-form-row]")
        ?.getAttribute("data-row-availability"),
    ).toBe("live");
    expect(
      screen.queryByText("Set Reading width to Wide to use this."),
    ).toBeNull();
    expect(controlGroupOf("Wide column width").disabled).toBe(false);
    expect(
      screen
        .getByRole("slider", { name: "Wide column width" })
        .hasAttribute("data-disabled"),
    ).toBe(false);
  });

  it("draws the slider at the stored width, with no revert at the default", () => {
    withWideReading();

    render(<AreaRows surface="chat" place="leading" />);

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

    render(<AreaRows surface="chat" place="leading" />);

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
    render(<TabOverflowRow {...LIVE_ROW} />);

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
    render(<AreaRows surface="topBar" place="leading" />);

    const options = screen
      .getByRole("radiogroup", { name: "Tab overflow" })
      .querySelectorAll<HTMLButtonElement>("[role='radio']");
    // Off by the row's fieldset, which `:disabled` reads and the button's own
    // `disabled` attribute does not.
    expect(options.length).toBeGreaterThan(0);
    expect([...options].some((option) => option.matches(":disabled"))).toBe(
      false,
    );
    expect(screen.queryByText("Set Placement to Top to use this.")).toBeNull();
    expect(controlGroupOf("Tab overflow").disabled).toBe(false);
  });

  it("is disabled with a reason once the tabs move to a side, which never scrolls or shrinks its own", () => {
    withVerticalStrip();
    render(<AreaRows surface="topBar" place="leading" />);

    const options = screen
      .getByRole("radiogroup", { name: "Tab overflow" })
      .querySelectorAll<HTMLButtonElement>("[role='radio']");
    expect([...options].every((option) => option.matches(":disabled"))).toBe(
      true,
    );
    const reason = screen.getByText("Set Placement to Top to use this.");
    expect(reason.getAttribute("data-row-availability")).toBe("disabled");
    const group = controlGroupOf("Tab overflow");
    expect(group.disabled).toBe(true);
    expect(group.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("writes the store at rest, with no history", () => {
    render(<TabOverflowRow {...LIVE_ROW} />);

    pick("Tab overflow", "Shrink to fit");

    expect(useLayoutStore.getState().arrangement.taskTabLayout).toBe("shrink");
    expect(historyDepth()).toBe(0);
  });

  it("is one undo step in a session, and Discard puts it back", () => {
    beginSession();
    render(<TabOverflowRow {...LIVE_ROW} />);

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
    render(<TabOverflowRow {...LIVE_ROW} />);
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
    render(<ResourceReadings />);

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
    render(<ResourceReadings />);

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
    render(<ResourceReadings />);
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
    render(<ResourceReadings />);

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
        <ResourceReadings />
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

/**
 * Toolbar style is the Composer area's own row (C3): it styles every button on
 * the toolbar, so it is not Model's row even though it is stored in Model's
 * values, and no layout or setting makes it do nothing.
 */
describe("the Composer area's Toolbar style row", () => {
  function toolbarStyle(): string {
    const state = useLayoutStore.getState();
    return state.overrides.model?.toolbarStyle ?? "flat";
  }

  it("draws Flat / Bordered over the stored style, ahead of the area's lists", () => {
    render(<AreaRows surface="composer" place="leading" />);

    const options = within(
      screen.getByRole("radiogroup", { name: "Toolbar style" }),
    ).getAllByRole("radio");
    // Pictured options: each one's name is its aria-label.
    expect(options.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Flat",
      "Bordered",
    ]);
    expect(options.map((node) => node.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
    expect(controlGroupOf("Toolbar style").disabled).toBe(false);
  });

  /**
   * Each sample is the real toolbar chip under ITS option, not under the
   * stored one: the chip reads `model.toolbarStyle` through the override
   * seam, and a depiction that never laid its values over it drew the user's
   * own setting twice.
   */
  it("draws each sample at its own option's chrome, whichever is stored", () => {
    function sampleChipBordered(label: string): boolean {
      const card = within(
        screen.getByRole("radiogroup", { name: "Toolbar style" }),
      ).getByRole("radio", { name: label }).parentElement;
      const chip = card?.querySelector("[data-layout-depiction] button");
      if (!(chip instanceof HTMLButtonElement)) {
        throw new Error(`the ${label} sample draws no toolbar chip`);
      }
      return chip.className.split(/\s+/).includes("border-border");
    }

    for (const stored of ["flat", "bordered"] as const) {
      useLayoutStore.getState().setRegionValues("model", {
        toolbarStyle: stored,
      });
      render(<AreaRows surface="composer" place="leading" />);

      expect(sampleChipBordered("Flat"), `stored ${stored}`).toBe(false);
      expect(sampleChipBordered("Bordered"), `stored ${stored}`).toBe(true);
      cleanup();
    }
  });

  it("is drawn nowhere else", () => {
    render(<AreaRows surface="composer" place="trailing" />);

    expect(
      screen.queryByRole("radiogroup", { name: "Toolbar style" }),
    ).toBeNull();
  });

  it("writes Model's toolbarStyle, and offers a revert only while it differs from the shipped one", () => {
    render(<AreaRows surface="composer" place="leading" />);
    expect(
      screen.queryByRole("button", { name: "Revert Toolbar style" }),
    ).toBeNull();

    pickPictured("Toolbar style", "Bordered");

    expect(toolbarStyle()).toBe("bordered");
    fireEvent.click(
      screen.getByRole("button", { name: "Revert Toolbar style" }),
    );
    expect(toolbarStyle()).toBe("flat");
    expect(
      screen.queryByRole("button", { name: "Revert Toolbar style" }),
    ).toBeNull();
  });

  it("stays drawn and live in the installed mobile app, which styles the same buttons", () => {
    setMobileApp(true);
    render(<AreaRows surface="composer" place="leading" />);

    expect(controlGroupOf("Toolbar style").disabled).toBe(false);
    // No note or reason line under it.
    expect(document.querySelector("p[data-row-availability]")).toBeNull();
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
  /** Every area row only the desktop layout draws, where the registry puts it. */
  function DesktopLayoutRows(): ReactNode {
    return (
      <>
        <AreaRows surface="topBar" place="leading" />
        <AreaRows surface="sidebar" place="leading" />
        <AreaRows surface="sidebar" place="trailing" />
        <AreaRows surface="chat" place="leading" />
      </>
    );
  }

  it("draws none of the desktop-layout rows (S-39): the registry answers absent for each", () => {
    setMobileApp(true);
    render(<DesktopLayoutRows />);

    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(document.querySelector("[data-layout-form-row]")).toBeNull();
  });

  describe("and a narrow browser tab, the same layout the window can widen out of", () => {
    let originalInnerWidth: number;

    beforeEach(() => {
      originalInnerWidth = window.innerWidth;
      window.innerWidth = 500;
    });

    afterEach(() => {
      window.innerWidth = originalInnerWidth;
    });

    it("keeps each of those rows, live, with a note that it applies on wider windows", () => {
      render(<DesktopLayoutRows />);

      for (const label of [
        "Placement",
        "Tab overflow",
        "Side",
        "Readings on agent rows",
        "Reading width",
      ]) {
        const row = screen.getByText(label).closest("[data-layout-form-row]");
        expect(row, label).not.toBeNull();
        const note = row?.querySelector("[data-row-availability]");
        expect(note?.getAttribute("data-row-availability"), label).toBe("live");
        expect(note?.textContent, label).toContain("Applies on wider windows.");
      }
    });
  });
});
