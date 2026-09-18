import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { CustomizeSearch } from "@/components/customize/customize-search";
import type { HotspotInstance } from "@/stores/customize/customize-store";
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

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

function micInstance(): HotspotInstance {
  return {
    key: "composer.mic@shell:-",
    settingId: "composer.mic",
    sceneId: "shell",
    tileId: null,
    node: document.createElement("div"),
    ghost: false,
    condition: null,
  };
}

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
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    search: { query: "", activeIndex: -1 },
    history: { past: [], future: [] },
  });
}

beforeEach(resetStores);
afterEach(cleanup);

describe("CustomizeSearch", () => {
  it("tracks aria-activedescendant to the highlighted result and keeps focus in the input", () => {
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    render(<CustomizeSearch unreachable={new Set()} />);
    const input = screen.getByRole("combobox", {
      name: "Search layout settings",
    });
    input.focus();

    fireEvent.change(input, { target: { value: "mic" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    const activeOption = screen.getByRole("option", { name: /Microphone/ });
    expect(activeOption.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(activeOption.id);
    expect(document.activeElement).toBe(input);
    expect(useCustomizeStore.getState().activeKey).toBe(instance.key);
  });

  it("fires the search-used analytics event once, on the first keystroke of the session", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    render(<CustomizeSearch unreachable={new Set()} />);
    const input = screen.getByRole("combobox", {
      name: "Search layout settings",
    });

    fireEvent.change(input, { target: { value: "m" } });
    fireEvent.change(input, { target: { value: "mi" } });
    fireEvent.change(input, { target: { value: "mic" } });

    const searchUsedCalls = trackSpy.mock.calls.filter(
      ([event]) => event === AnalyticsEvent.LayoutEditorSearchUsed,
    );
    expect(searchUsedCalls).toHaveLength(1);
  });

  it("Enter opens the popover for the highlighted result", () => {
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    render(<CustomizeSearch unreachable={new Set()} />);
    const input = screen.getByRole("combobox", {
      name: "Search layout settings",
    });

    fireEvent.change(input, { target: { value: "mic" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useCustomizeStore.getState().popoverKey).toBe(instance.key);
    expect(useCustomizeStore.getState().invoker).toBe("search");
  });

  it("Enter on a preset result applies it and records exactly one history entry", () => {
    render(<CustomizeSearch unreachable={new Set()} />);
    const input = screen.getByRole("combobox", {
      name: "Search layout settings",
    });

    fireEvent.change(input, { target: { value: "compact preset" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const { history } = useCustomizeStore.getState();
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.label).toBe("Compact preset");
  });

  it("shows the empty state with a Clear action for a query matching nothing", () => {
    render(<CustomizeSearch unreachable={new Set()} />);
    const input = screen.getByRole("combobox", {
      name: "Search layout settings",
    });

    fireEvent.change(input, { target: { value: "zzzznotasetting" } });

    expect(screen.getByText(/No settings match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(useCustomizeStore.getState().search.query).toBe("");
  });
  // Review w2, finding 3: results must render through the real Popover
  // machinery (collision-aware positioning against the safe viewport), not a
  // plain `absolute top-full` box that can end up below the viewport when
  // the bar sits at a bottom corner.
  it("results render through the real, collision-aware Popover and never take focus from the input", () => {
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    render(<CustomizeSearch unreachable={new Set()} />);
    const input = screen.getByRole("combobox", {
      name: "Search layout settings",
    });
    input.focus();

    fireEvent.change(input, { target: { value: "mic" } });

    const listbox = screen.getByRole("listbox", { name: "Layout settings" });
    const content = listbox.closest("[data-customize-editor]");
    expect(content).not.toBeNull();
    // The collision-driven max-height machinery: Radix's own
    // `--radix-popover-content-available-height` custom property, read by
    // this element's own max-height, not a fixed `50svh` box.
    expect(content?.className).toContain(
      "var(--radix-popover-content-available-height)",
    );
    // `onOpenAutoFocus` is prevented: opening the results never steals focus
    // away from the search field.
    expect(document.activeElement).toBe(input);
  });
});
