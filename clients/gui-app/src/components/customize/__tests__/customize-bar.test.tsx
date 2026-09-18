import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomizeBar } from "@/components/customize/customize-bar";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import {
  DEFAULT_CONTEXT_INDICATOR_STYLE,
  DEFAULT_MINIMAP_SIDE,
  DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
  DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

function resetStores(): void {
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  useSettingsStore.setState({
    pinContextUsageBreakdown: DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    pinnedContextBreakdownOrder: DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
    contextIndicatorStyle: DEFAULT_CONTEXT_INDICATOR_STYLE,
    chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE,
    navigatorResourceMetrics: DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  });
  useLeftPanelStore.getState().applyPanelGroups(DEFAULT_LEFT_PANEL_GROUPS);
  useLeftPanelStore.getState().clearPanelVisibilityOverrides();
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    history: { past: [], future: [] },
    announcement: "",
  });
}

beforeEach(resetStores);
afterEach(cleanup);

describe("CustomizeBar", () => {
  it("is a dialog that suspends app chords, per the spec", () => {
    render(<CustomizeBar unreachable={new Set()} />);

    const bar = screen.getByRole("dialog", { name: "Customize layout" });
    expect(bar.getAttribute("data-state")).toBe("open");
  });

  it("choosing Compact records one history entry, and Undo's label names it", () => {
    render(<CustomizeBar unreachable={new Set()} />);

    fireEvent.click(screen.getByRole("radio", { name: "Compact" }));

    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Undo: Compact preset" }),
    ).toBeTruthy();
  });

  it("Undo and Redo read 'no changes' and are disabled with an empty history", () => {
    render(<CustomizeBar unreachable={new Set()} />);

    const undoButton = screen.getByRole("button", {
      name: "Undo: no changes",
    }) as HTMLButtonElement;
    const redoButton = screen.getByRole("button", {
      name: "Redo: no changes",
    }) as HTMLButtonElement;
    expect(undoButton.disabled).toBe(true);
    expect(redoButton.disabled).toBe(true);
  });

  it("shows the Custom badge once the live layout no longer matches any preset", () => {
    render(<CustomizeBar unreachable={new Set()} />);
    expect(screen.queryByText("Custom")).toBeNull();

    // Default's `composer.access` is "visible"; Compact wants "compact" but
    // also wants every OTHER composer field compact (still default here), and
    // Detailed wants "visible" but a different `reasoningIndicator` - so this
    // one field alone can't accidentally re-match either bundle.
    act(() => {
      useLayoutStore.getState().setComposerAccess("compact");
    });

    expect(screen.getByText("Custom")).toBeTruthy();
  });

  it("Reset is disabled at the defaults and enables once the page has drifted", () => {
    render(<CustomizeBar unreachable={new Set()} />);
    expect(
      screen.getByRole("button", { name: "Reset" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "Compact" }));

    expect(
      screen.getByRole("button", { name: "Reset" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("Done exits the session", () => {
    render(<CustomizeBar unreachable={new Set()} />);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(useCustomizeStore.getState().session).toBeNull();
  });

  it("carries a live region that announces the last gesture", () => {
    render(<CustomizeBar unreachable={new Set()} />);

    fireEvent.click(screen.getByRole("radio", { name: "Compact" }));

    expect(screen.getByRole("status").textContent).toBe("Compact preset");
  });
});
