import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SampleSceneProvider } from "@/components/sample-workspace/sample-scene-provider";
import { LAYOUT_EDITOR_MIN_WIDTH } from "@/lib/layout/editor-width";
import { emptyTabStripLayout, tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";

/**
 * The sample tab follows the EDITOR's width threshold, not the phone
 * breakpoint (L-64): the sample workspace exists only to be the editor's
 * canvas, so it closes at exactly the width the door refuses to open at.
 * This suite drives the real owner rather than mocking a viewport hook the
 * provider no longer reads.
 */
function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

const EPIC_REF: TabRef = { kind: "epic", id: "tab-a" };
const SAMPLE_REF: TabRef = { kind: "sample-workspace", id: "sample-workspace" };

function sampleTabCount(): number {
  return useTabsStore
    .getState()
    .items.filter(
      (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
    ).length;
}

/**
 * Sample tab retained in the strip, NOT the active item, with no surface
 * mounted - built through the ordinary tab machinery rather than through the
 * editor's door (`lib/layout/editor-session.ts`), so this file covers the
 * provider's lifecycle and not the door's.
 */
function seedBackgroundSampleTab(): void {
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    items: [
      { kind: "tab", id: tabItemId(EPIC_REF), ref: EPIC_REF },
      { kind: "tab", id: tabItemId(SAMPLE_REF), ref: SAMPLE_REF },
    ],
    activeItemId: tabItemId(EPIC_REF),
    stripOrder: [EPIC_REF, SAMPLE_REF],
  });
  expect(sampleTabCount()).toBe(1);
}

beforeEach(() => {
  setViewportWidth(LAYOUT_EDITOR_MIN_WIDTH);
  tabCommandCoordinator.resetReconciliationForTesting();
});
afterEach(() => {
  cleanup();
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
});

describe("SampleSceneProvider global close guard", () => {
  it("leaves the background sample tab alone at desktop width", () => {
    seedBackgroundSampleTab();

    render(<SampleSceneProvider>{null}</SampleSceneProvider>);

    expect(sampleTabCount()).toBe(1);
  });

  it("closes a retained background sample tab when the window narrows past the threshold", () => {
    seedBackgroundSampleTab();
    const view = render(<SampleSceneProvider>{null}</SampleSceneProvider>);

    setViewportWidth(LAYOUT_EDITOR_MIN_WIDTH - 1);
    act(() => {
      view.rerender(<SampleSceneProvider>{null}</SampleSceneProvider>);
    });

    expect(sampleTabCount()).toBe(0);
  });

  it("closes a stale sample tab on mount if the window is already narrow", () => {
    setViewportWidth(LAYOUT_EDITOR_MIN_WIDTH - 1);
    seedBackgroundSampleTab();

    render(<SampleSceneProvider>{null}</SampleSceneProvider>);

    expect(sampleTabCount()).toBe(0);
  });

  it("is a no-op when there is no sample tab", () => {
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
    const view = render(<SampleSceneProvider>{null}</SampleSceneProvider>);

    setViewportWidth(LAYOUT_EDITOR_MIN_WIDTH - 1);
    expect(() =>
      act(() => {
        view.rerender(<SampleSceneProvider>{null}</SampleSceneProvider>);
      }),
    ).not.toThrow();
    expect(useTabsStore.getState().items).toEqual([]);
  });
});
