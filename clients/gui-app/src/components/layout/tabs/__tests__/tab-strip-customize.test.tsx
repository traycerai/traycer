import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabStripHomeItem } from "@/components/layout/tabs/tab-strip-home-item";
import { getCustomizeOptions } from "@/lib/customize/customize-options";
import { registerTabsSidebarCustomizeOptions } from "@/lib/customize/options/tabs-sidebar-options";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";

registerTabsSidebarCustomizeOptions();

function startSession(): void {
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    history: { past: [], future: [] },
    announcement: "",
  });
}

beforeEach(() => {
  useCustomizeStore.setState({ session: null, instances: new Map() });
  useSettingsStore.setState({ homeTabEnabled: true });
  useTabsStore.setState({ activeItemId: "some-tab" });
});
afterEach(cleanup);

describe("tabs.home hotspot + option", () => {
  it("registers a hotspot on the real Home tab", () => {
    startSession();
    render(
      <TooltipProvider>
        <TabStripHomeItem
          isActive={false}
          onActivate={() => {}}
          badgeCount={0}
        />
      </TooltipProvider>,
    );
    const instance = [...useCustomizeStore.getState().instances.values()].find(
      (candidate) => candidate.settingId === "tabs.home",
    );
    expect(instance).toBeDefined();
    expect(instance?.ghost).toBe(false);
  });

  it("hiding Home while it is the active tab is refused with a reason", () => {
    startSession();
    useTabsStore.setState({ activeItemId: null });
    const instance = {
      key: "tabs.home@shell:-",
      settingId: "tabs.home" as const,
      sceneId: "shell",
      tileId: null,
      node: document.createElement("div"),
      ghost: false,
      condition: null,
    };
    const options = getCustomizeOptions(instance);
    expect(options?.control?.kind).toBe("toggle");
    act(() => {
      if (options?.control?.kind === "toggle") options.control.change(false);
    });
    expect(useSettingsStore.getState().homeTabEnabled).toBe(true);
    expect(useCustomizeStore.getState().announcement).toBe(
      "Switch to another tab first",
    );
  });

  it("hiding Home while inactive writes through", () => {
    startSession();
    useTabsStore.setState({ activeItemId: "some-tab" });
    const instance = {
      key: "tabs.home@shell:-",
      settingId: "tabs.home" as const,
      sceneId: "shell",
      tileId: null,
      node: document.createElement("div"),
      ghost: false,
      condition: null,
    };
    const options = getCustomizeOptions(instance);
    act(() => {
      if (options?.control?.kind === "toggle") options.control.change(false);
    });
    expect(useSettingsStore.getState().homeTabEnabled).toBe(false);
  });
});
