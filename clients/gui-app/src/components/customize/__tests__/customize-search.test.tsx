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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
  function stubInputGeometry(
    input: HTMLInputElement,
    rect: { top: number; bottom: number },
  ): void {
    input.getBoundingClientRect = () =>
      new DOMRect(0, rect.top, 200, rect.bottom - rect.top);
  }

  it("flips the results panel above the input when the space below is under half the viewport and the space above is larger", () => {
    vi.stubGlobal("innerHeight", 800);
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    render(<CustomizeSearch unreachable={new Set()} />);
    const input = screen.getByRole("combobox", {
      name: "Search layout settings",
    }) as HTMLInputElement;
    input.focus();
    // Near the bottom of an 800px-tall viewport: 20px below, 750px above.
    stubInputGeometry(input, { top: 750, bottom: 780 });

    fireEvent.change(input, { target: { value: "mic" } });

    const listbox = screen.getByRole("listbox", { name: "Layout settings" });
    const content = listbox.closest<HTMLElement>("[data-customize-editor]");
    if (content === null)
      throw new Error("expected a data-customize-editor panel");
    expect(content.className).toContain("bottom-full");
    expect(content.className).not.toContain("top-full");
    expect(content.style.maxHeight).toBe("400px");
    expect(document.activeElement).toBe(input);
  });

  it("keeps the results panel below the input when there is enough room below", () => {
    vi.stubGlobal("innerHeight", 800);
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    render(<CustomizeSearch unreachable={new Set()} />);
    const input = screen.getByRole("combobox", {
      name: "Search layout settings",
    }) as HTMLInputElement;
    input.focus();
    // Near the top of an 800px-tall viewport: 10px above, 760px below.
    stubInputGeometry(input, { top: 10, bottom: 40 });

    fireEvent.change(input, { target: { value: "mic" } });

    const listbox = screen.getByRole("listbox", { name: "Layout settings" });
    const content = listbox.closest<HTMLElement>("[data-customize-editor]");
    if (content === null)
      throw new Error("expected a data-customize-editor panel");
    expect(content.className).toContain("top-full");
    expect(content.className).not.toContain("bottom-full");
    expect(content.style.maxHeight).toBe("400px");
    expect(document.activeElement).toBe(input);
  });
});
