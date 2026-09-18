import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SampleSceneProvider } from "@/components/sample-workspace/sample-scene-provider";
import { ensureSampleWorkspaceTab } from "@/lib/customize/enter-exit";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { emptyTabStripLayout, tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/ui/use-mobile-viewport")>()),
  useIsMobileViewport: () => viewport.mobile,
}));

const EPIC_REF: TabRef = { kind: "epic", id: "tab-a" };

function sampleTabCount(): number {
  return useTabsStore
    .getState()
    .items.filter(
      (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
    ).length;
}

/** Sample tab retained in the strip, NOT the active item, with no surface mounted. */
function seedBackgroundSampleTab(): void {
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    items: [{ kind: "tab", id: tabItemId(EPIC_REF), ref: EPIC_REF }],
    activeItemId: tabItemId(EPIC_REF),
    stripOrder: [EPIC_REF],
  });
  ensureSampleWorkspaceTab({ kind: "none" });
  expect(sampleTabCount()).toBe(1);
}

beforeEach(() => {
  viewport.mobile = false;
  useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  useCustomizeStore.setState({ session: null, instances: new Map() });
  tabCommandCoordinator.resetReconciliationForTesting();
});
afterEach(() => {
  cleanup();
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
});

describe("SampleSceneProvider global close guard", () => {
  it("leaves the background sample tab alone while the switch is on at desktop width", () => {
    seedBackgroundSampleTab();

    render(<SampleSceneProvider>{null}</SampleSceneProvider>);

    expect(sampleTabCount()).toBe(1);
  });

  it("closes a retained background sample tab when the switch turns off", () => {
    seedBackgroundSampleTab();
    render(<SampleSceneProvider>{null}</SampleSceneProvider>);

    act(() => {
      useSettingsStore.setState({ visualLayoutEditorEnabled: false });
    });

    expect(sampleTabCount()).toBe(0);
    // The tab that WAS active stays.
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(EPIC_REF));
  });

  it("closes a retained background sample tab when the viewport drops below md", () => {
    seedBackgroundSampleTab();
    const view = render(<SampleSceneProvider>{null}</SampleSceneProvider>);

    viewport.mobile = true;
    act(() => {
      view.rerender(<SampleSceneProvider>{null}</SampleSceneProvider>);
    });

    expect(sampleTabCount()).toBe(0);
  });

  it("closes a stale sample tab on mount if the switch is already off", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
    seedBackgroundSampleTab();

    render(<SampleSceneProvider>{null}</SampleSceneProvider>);

    expect(sampleTabCount()).toBe(0);
  });

  it("is a no-op when there is no sample tab", () => {
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
    render(<SampleSceneProvider>{null}</SampleSceneProvider>);

    expect(() =>
      act(() => {
        useSettingsStore.setState({ visualLayoutEditorEnabled: false });
      }),
    ).not.toThrow();
    expect(useTabsStore.getState().items).toEqual([]);
  });
});
