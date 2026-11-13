import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import { SurfaceSection } from "@/components/layout-editor/inspector/surface-section";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * Behavior ported from the deleted `RegionSection` (`region-section.test.tsx`
 * family): the case that still applies once a region's details are drawn in
 * place by `SurfaceSection`'s own `RegionRowDetail`/position rows, rather than
 * on a separate specimen level. Coverage that moved onto components with their
 * own dedicated suites (`RegionDisplayControl`'s tri-state -
 * `region-display-control.test.tsx`; the disclosure/hint rule itself -
 * `surface-section-disclosure.test.tsx`) is not repeated here.
 */

/** Rendered live off the store, so a mutation made after mounting is seen. */
function StatusBarSurface(props: { readonly regionId: RegionId }): ReactNode {
  const snapshot = useLayoutSnapshot();
  return (
    <LayoutFormHostContext value="page">
      <SurfaceSection
        surface="statusBar"
        snapshot={snapshot}
        openRows={[props.regionId]}
        onToggleRow={() => {}}
        onSelectRow={null}
        selectedRow={props.regionId}
      />
    </LayoutFormHostContext>
  );
}

function renderSurface(regionId: RegionId): void {
  render(<StatusBarSurface regionId={regionId} />);
}

function row(id: string): HTMLElement {
  const node = document.querySelector(
    `[data-sortable-id="${id}"], [data-region-section="${id}"]`,
  );
  if (!(node instanceof HTMLElement)) throw new Error(`no such row: ${id}`);
  return node;
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
  useLayoutEditorStore.getState().endSession();
});

describe("a hidden region's detail rows stay live only where their rule outlives the gate (G1-06 overturned by L-174)", () => {
  function firstRadio(name: string): HTMLButtonElement {
    return within(row("resourceMonitor"))
      .getByRole("radiogroup", { name })
      .querySelectorAll<HTMLButtonElement>("[role='radio']")[0];
  }

  it("disables Location and Metrics while Hidden with agent rows off, and says 'these settings'", () => {
    useLayoutStore.getState().setRegionValues("resourceMonitor", {
      shown: "hidden",
      agentRows: false,
    });
    renderSurface("resourceMonitor");

    const detail = row("resourceMonitor").querySelector(
      "div[data-region-detail]",
    );
    expect(detail).not.toBeNull();
    expect(firstRadio("Resource monitor location").matches(":disabled")).toBe(
      true,
    );
    for (const checkbox of within(row("resourceMonitor")).getAllByRole(
      "checkbox",
    )) {
      expect(checkbox.matches(":disabled")).toBe(true);
    }
    expect(
      screen.getByText("Show Resource monitor to change these settings."),
    ).not.toBeNull();
  });

  it("keeps Metrics editable while Hidden with agent rows on, disables Location, and says 'its other settings'", () => {
    useLayoutStore.getState().setRegionValues("resourceMonitor", {
      shown: "hidden",
      agentRows: true,
    });
    renderSurface("resourceMonitor");

    expect(firstRadio("Resource monitor location").matches(":disabled")).toBe(
      true,
    );
    for (const checkbox of within(row("resourceMonitor")).getAllByRole(
      "checkbox",
    )) {
      expect(checkbox.matches(":disabled")).toBe(false);
    }
    expect(
      screen.getByText("Show Resource monitor to change its other settings."),
    ).not.toBeNull();
  });

  it("leaves everything enabled, with no hint, while the region is shown", () => {
    useLayoutStore.getState().setRegionValues("resourceMonitor", {
      shown: "shown",
    });
    renderSurface("resourceMonitor");

    expect(firstRadio("Resource monitor location").matches(":disabled")).toBe(
      false,
    );
    for (const checkbox of within(row("resourceMonitor")).getAllByRole(
      "checkbox",
    )) {
      expect(checkbox.matches(":disabled")).toBe(false);
    }
    expect(screen.queryByText(/Show Resource monitor to change/)).toBeNull();
  });

  it("still disables everything for a region with no row that outlives the gate (Usage limits)", () => {
    useLayoutStore.getState().setRegionValues("usageLimits", {
      shown: "hidden",
    });
    renderSurface("usageLimits");

    const usage = within(row("usageLimits"));
    const radios = [
      ...usage
        .getByRole("radiogroup", { name: "Usage limits location" })
        .querySelectorAll<HTMLButtonElement>("[role='radio']"),
      ...usage
        .getByRole("radiogroup", { name: "Density" })
        .querySelectorAll<HTMLButtonElement>("[role='radio']"),
    ];
    for (const radio of radios) expect(radio.matches(":disabled")).toBe(true);
    expect(
      usage.getByRole("switch", { name: "Reset time" }).matches(":disabled"),
    ).toBe(true);
    expect(
      screen.getByText("Show Usage limits to change these settings."),
    ).not.toBeNull();
  });
});

describe("the two bar readings' Location row", () => {
  function picker(label: string): HTMLElement {
    return screen.getByRole("radiogroup", { name: label });
  }

  it("writes only its own region, the bar always and the end only for the status bar", () => {
    renderSurface("resourceMonitor");

    // The usage cluster is put somewhere it did not ship first, so a write
    // that reached it would be visible rather than landing on the value it
    // already had.
    act(() => {
      const arrangement = useLayoutStore.getState().arrangement;
      useLayoutStore
        .getState()
        .setArrangement({ ...arrangement, usageSide: "right" });
    });

    fireEvent.click(
      within(picker("Resource monitor location")).getByRole("radio", {
        name: "Tab strip",
      }),
    );
    let after = useLayoutStore.getState().arrangement;
    expect(after.resourceHost).toBe("header");
    // The tab strip has no end, so the old one is kept for the way back.
    expect(after.resourceSide).toBe("right");

    fireEvent.click(
      within(picker("Resource monitor location")).getByRole("radio", {
        name: "Status bar left",
      }),
    );
    after = useLayoutStore.getState().arrangement;
    expect(after.resourceHost).toBe("status-bar");
    expect(after.resourceSide).toBe("left");
    expect(after.usageHost).toBe("status-bar");
    expect(after.usageSide).toBe("right");
  });

  it("reverts the bar and the end together, as one row (L-133)", () => {
    renderSurface("usageLimits");

    act(() => {
      const arrangement = useLayoutStore.getState().arrangement;
      useLayoutStore.getState().setArrangement({
        ...arrangement,
        usageHost: "header",
        usageSide: "right",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Revert Location" }));

    const after = useLayoutStore.getState().arrangement;
    expect(after.usageHost).toBe("status-bar");
    expect(after.usageSide).toBe("left");
    expect(
      screen.queryByRole("button", { name: "Revert Location" }),
    ).toBeNull();
  });
});

describe("one region's ↺ restores everything its dot measures (item 10)", () => {
  it("hiding a provider marks Usage limits, and its ↺ restores it", () => {
    const provider = useLayoutStore.getState().arrangement.usageProviders[0];
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        hiddenProviders: [provider],
      });
    });
    renderSurface("usageLimits");

    expect(
      within(row("usageLimits")).getByRole("button", {
        name: "Revert Usage limits",
      }),
    ).not.toBeNull();

    fireEvent.click(
      within(row("usageLimits")).getByRole("button", {
        name: "Revert Usage limits",
      }),
    );

    expect(useLayoutStore.getState().arrangement.hiddenProviders).toEqual([]);
  });

  it("restores a value AND a position change together, in one editor Undo step", () => {
    act(() => {
      useLayoutStore.getState().setRegionValues("minimap", {
        shown: "hidden",
      });
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        minimapSide: "left",
      });
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });
    });
    render(
      <LayoutFormHostContext value="page">
        <MinimapSurface />
      </LayoutFormHostContext>,
    );

    fireEvent.click(
      within(row("minimap")).getByRole("button", { name: "Revert Minimap" }),
    );

    expect(useLayoutStore.getState().overrides.minimap).toBeUndefined();
    expect(useLayoutStore.getState().arrangement.minimapSide).toBe("right");

    act(() => {
      useLayoutEditorStore.getState().undo();
    });

    expect(useLayoutStore.getState().overrides.minimap?.shown).toBe("hidden");
    expect(useLayoutStore.getState().arrangement.minimapSide).toBe("left");
  });

  it("keeps focus inside the row when the ↺ it was on unmounts", () => {
    act(() => {
      useLayoutStore.getState().setRegionValues("minimap", {
        shown: "hidden",
      });
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        minimapSide: "left",
      });
    });
    render(
      <LayoutFormHostContext value="page">
        <MinimapSurface />
      </LayoutFormHostContext>,
    );

    const revertButton = within(row("minimap")).getByRole("button", {
      name: "Revert Minimap",
    });
    revertButton.focus();
    fireEvent.click(revertButton);

    expect(useLayoutStore.getState().overrides.minimap).toBeUndefined();
    expect(useLayoutStore.getState().arrangement.minimapSide).toBe("right");
    expect(
      within(row("minimap")).queryByRole("button", { name: "Revert Minimap" }),
    ).toBeNull();
    expect(row("minimap").contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });
});

/** The Chat surface, live off the store, for Minimap's own position row. */
function MinimapSurface(): ReactNode {
  const snapshot = useLayoutSnapshot();
  return (
    <SurfaceSection
      surface="chat"
      snapshot={snapshot}
      openRows={["minimap"]}
      onToggleRow={() => {}}
      onSelectRow={null}
      selectedRow="minimap"
    />
  );
}

/**
 * Pin breakdown decides which of the two rows below it applies (C1): the
 * pinned strip never reads the chip's style, and the chip never draws the
 * breakdown rows. Nothing is removed either way - the one that does nothing
 * is greyed with the switch it waits on named.
 */
describe("Context usage's Chip style follows Pin breakdown (C1)", () => {
  const REASON = "Turn off Pin breakdown to use this.";

  function renderContextUsage(): void {
    render(
      <LayoutFormHostContext value="page">
        <SurfaceSection
          surface="chat"
          snapshot={useLayoutStore.getState()}
          openRows={["contextUsage"]}
          onToggleRow={() => {}}
          onSelectRow={null}
          selectedRow="contextUsage"
        />
      </LayoutFormHostContext>,
    );
  }

  function chipStyleOptions(): ReadonlyArray<HTMLElement> {
    return within(
      screen.getByRole("radiogroup", { name: "Chip style" }),
    ).getAllByRole("radio");
  }

  it("draws Pin breakdown before Chip style, so the switch that decides it is read first", () => {
    renderContextUsage();

    const pin = screen.getByRole("switch", { name: "Pin breakdown" });
    const style = screen.getByRole("radiogroup", { name: "Chip style" });

    expect(
      pin.compareDocumentPosition(style) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps Chip style live, with no reason, while the breakdown is unpinned", () => {
    renderContextUsage();

    expect(
      chipStyleOptions().some((option) => option.matches(":disabled")),
    ).toBe(false);
    expect(screen.queryByText(REASON)).toBeNull();
  });

  it("greys Chip style in place once pinned, with the reason linked to its group", () => {
    useLayoutStore
      .getState()
      .setRegionValues("contextUsage", { pinBreakdown: true });
    renderContextUsage();

    expect(
      chipStyleOptions().every((option) => option.matches(":disabled")),
    ).toBe(true);
    const reason = screen.getByText(REASON);
    expect(reason.getAttribute("data-row-availability")).toBe("disabled");
    expect(
      screen
        .getByRole("radiogroup", { name: "Chip style" })
        .closest("fieldset")
        ?.getAttribute("aria-describedby")
        ?.split(" "),
    ).toContain(reason.id);
  });
});
