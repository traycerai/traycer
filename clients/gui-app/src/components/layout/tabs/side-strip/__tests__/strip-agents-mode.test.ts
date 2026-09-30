/**
 * `useLiveAgentsInStrip` / `useStripAgentsMode` wire the REAL placement,
 * collapsed, view and layout-editor stores into `liveAgentsInStrip`
 * (`lib/layout/layout-arrangement.ts`, whose own truth table is covered in
 * `layout-arrangement.test.ts`). What is owed here is that each store is the
 * one read, and that the editor's pointer alone turns Tabs only into a preview.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useLiveAgentsInStrip, useStripAgentsMode } from "../strip-agents-mode";

function resetStores(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useSideTabStripStore.setState({ collapsed: false });
  useLayoutEditorStore.setState({
    hoveredSetting: null,
    selectedSetting: null,
  });
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  resetStores();
});

function arrange(
  placement: LayoutArrangement["tabStripPlacement"],
  view: LayoutArrangement["sideStripView"],
): void {
  act(() => {
    useLayoutStore.setState({
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: placement,
        sideStripView: view,
      },
    });
  });
}

describe("useLiveAgentsInStrip", () => {
  it("is true only for an expanded, vertical Activity view, and follows a live collapse and view switch", () => {
    const { result } = renderHook(() => useLiveAgentsInStrip());
    expect(result.current).toBe(false);

    arrange("left", "activity");
    expect(result.current).toBe(true);

    act(() => {
      useSideTabStripStore.getState().setCollapsed(true);
    });
    expect(result.current).toBe(false);

    act(() => {
      useSideTabStripStore.getState().setCollapsed(false);
    });
    arrange("left", "layered");
    expect(result.current).toBe(false);
  });
});

describe("useStripAgentsMode", () => {
  it("is live in the Activity view, even while the editor points at the setting", () => {
    arrange("left", "activity");
    const { result } = renderHook(() => useStripAgentsMode());
    expect(result.current).toBe("live");

    act(() => {
      useLayoutEditorStore.getState().setHoveredSetting("sideStripView");
    });
    expect(result.current).toBe("live");
  });

  it("previews Tabs only while the editor hovers or selects Side tab view, and is otherwise none", () => {
    arrange("left", "layered");
    const { result } = renderHook(() => useStripAgentsMode());
    expect(result.current).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().setHoveredSetting("sideStripView");
    });
    expect(result.current).toBe("preview");

    act(() => {
      useLayoutEditorStore.getState().setHoveredSetting(null);
      useLayoutEditorStore.getState().selectSetting("sideStripView");
    });
    expect(result.current).toBe("preview");
  });

  it("has no room for agents at the top placement or on the collapsed rail, pointed at or not", () => {
    const { result } = renderHook(() => useStripAgentsMode());
    act(() => {
      useLayoutEditorStore.getState().setHoveredSetting("sideStripView");
    });

    arrange("top", "layered");
    expect(result.current).toBeNull();

    arrange("left", "layered");
    act(() => {
      useSideTabStripStore.getState().setCollapsed(true);
    });
    expect(result.current).toBeNull();
  });
});
