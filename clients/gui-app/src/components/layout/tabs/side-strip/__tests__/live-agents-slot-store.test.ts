/**
 * D9: where the strip wants the active task's live agents drawn. The slot
 * store itself (publish/withdraw, one slot per window) and
 * `useLiveAgentsInStrip`'s wiring of the real placement, collapsed and view
 * stores into `liveAgentsInStrip` (`lib/layout/layout-arrangement.ts`, whose
 * own truth table is covered in `layout-arrangement.test.ts`).
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  publishLiveAgentsSlot,
  useLiveAgentsInStrip,
  useLiveAgentsSlot,
  useLiveAgentsSlotMode,
} from "@/components/layout/tabs/side-strip/live-agents-slot-store";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

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

describe("publishLiveAgentsSlot / useLiveAgentsSlot", () => {
  it("is null for a tab with nothing published", () => {
    const { result } = renderHook(() => useLiveAgentsSlot("tab-a"));
    expect(result.current).toBeNull();
  });

  it("publishes the element for its own tab only", () => {
    const element = document.createElement("div");
    const tabA = renderHook(() => useLiveAgentsSlot("tab-a"));
    const tabB = renderHook(() => useLiveAgentsSlot("tab-b"));

    act(() => {
      publishLiveAgentsSlot("tab-a", element);
    });

    expect(tabA.result.current).toBe(element);
    expect(tabB.result.current).toBeNull();
  });

  it("withdraws on the returned cleanup", () => {
    const element = document.createElement("div");
    const { result } = renderHook(() => useLiveAgentsSlot("tab-a"));
    let withdraw: () => void = () => undefined;

    act(() => {
      withdraw = publishLiveAgentsSlot("tab-a", element);
    });
    expect(result.current).toBe(element);

    act(() => {
      withdraw();
    });
    expect(result.current).toBeNull();
  });

  it("a superseded publish's cleanup does not withdraw the newer one", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    const { result } = renderHook(() => useLiveAgentsSlot("tab-a"));
    let withdrawFirst: () => void = () => undefined;

    act(() => {
      withdrawFirst = publishLiveAgentsSlot("tab-a", first);
      publishLiveAgentsSlot("tab-a", second);
    });
    expect(result.current).toBe(second);

    act(() => {
      withdrawFirst();
    });
    // The first slot's own cleanup ran after a newer one replaced it; it must
    // not clear the slot out from under the second publish.
    expect(result.current).toBe(second);
  });

  it("publishing for a different tab clears the previous tab's slot", () => {
    const element = document.createElement("div");
    const tabA = renderHook(() => useLiveAgentsSlot("tab-a"));
    const tabB = renderHook(() => useLiveAgentsSlot("tab-b"));

    act(() => {
      publishLiveAgentsSlot("tab-a", element);
    });
    expect(tabA.result.current).toBe(element);

    act(() => {
      publishLiveAgentsSlot("tab-b", element);
    });
    expect(tabA.result.current).toBeNull();
    expect(tabB.result.current).toBe(element);
  });
});

describe("useLiveAgentsInStrip", () => {
  it("is false at the shipped default (top, layered)", () => {
    const { result } = renderHook(() => useLiveAgentsInStrip());
    expect(result.current).toBe(false);
  });

  it("is true once the strip is a vertical, expanded Activity view", () => {
    act(() => {
      useLayoutStore.setState({
        arrangement: {
          ...DEFAULT_ARRANGEMENT,
          tabStripPlacement: "left",
          sideStripView: "activity",
        },
      });
    });

    const { result } = renderHook(() => useLiveAgentsInStrip());
    expect(result.current).toBe(true);
  });

  it("follows a live collapse of the strip", () => {
    act(() => {
      useLayoutStore.setState({
        arrangement: {
          ...DEFAULT_ARRANGEMENT,
          tabStripPlacement: "right",
          sideStripView: "activity",
        },
      });
    });
    const { result } = renderHook(() => useLiveAgentsInStrip());
    expect(result.current).toBe(true);

    act(() => {
      useSideTabStripStore.getState().setCollapsed(true);
    });
    expect(result.current).toBe(false);
  });

  it("follows a live switch back to Layered", () => {
    act(() => {
      useLayoutStore.setState({
        arrangement: {
          ...DEFAULT_ARRANGEMENT,
          tabStripPlacement: "left",
          sideStripView: "activity",
        },
      });
    });
    const { result } = renderHook(() => useLiveAgentsInStrip());
    expect(result.current).toBe(true);

    act(() => {
      useLayoutStore.setState((state) => ({
        arrangement: { ...state.arrangement, sideStripView: "layered" },
      }));
    });
    expect(result.current).toBe(false);
  });
});

/**
 * `useLiveAgentsSlotMode`: `"live"` when the strip actually lists live
 * agents; `"preview"` while it does not but Tabs and agents would show there
 * and the layout editor is pointing at Side tab view (C3, the ghost the row
 * offers before the pick is made); `null` otherwise, including where the
 * strip has no room for the part at all (top placement, collapsed).
 */
describe("useLiveAgentsSlotMode", () => {
  function verticalExpanded(view: "layered" | "activity"): void {
    act(() => {
      useLayoutStore.setState({
        arrangement: {
          ...DEFAULT_ARRANGEMENT,
          tabStripPlacement: "left",
          sideStripView: view,
        },
      });
    });
  }

  it("is live once the strip is a vertical, expanded Activity view", () => {
    verticalExpanded("activity");
    const { result } = renderHook(() => useLiveAgentsSlotMode());
    expect(result.current).toBe("live");
  });

  it("is null in Tabs only with nothing pointed at", () => {
    verticalExpanded("layered");
    const { result } = renderHook(() => useLiveAgentsSlotMode());
    expect(result.current).toBeNull();
  });

  it("is preview in Tabs only while the editor hovers Side tab view's setting", () => {
    verticalExpanded("layered");
    const { result } = renderHook(() => useLiveAgentsSlotMode());

    act(() => {
      useLayoutEditorStore.getState().setHoveredSetting("sideStripView");
    });

    expect(result.current).toBe("preview");
  });

  it("is preview in Tabs only while the editor has Side tab view selected", () => {
    verticalExpanded("layered");
    const { result } = renderHook(() => useLiveAgentsSlotMode());

    act(() => {
      useLayoutEditorStore.getState().selectSetting("sideStripView");
    });

    expect(result.current).toBe("preview");
  });

  it("is null at the top placement even while the editor points at the setting", () => {
    act(() => {
      useLayoutStore.setState({
        arrangement: { ...DEFAULT_ARRANGEMENT, sideStripView: "layered" },
      });
      useLayoutEditorStore.getState().setHoveredSetting("sideStripView");
    });

    const { result } = renderHook(() => useLiveAgentsSlotMode());

    expect(result.current).toBeNull();
  });

  it("is null while the strip is collapsed, even while the editor points at the setting", () => {
    verticalExpanded("layered");
    act(() => {
      useSideTabStripStore.getState().setCollapsed(true);
      useLayoutEditorStore.getState().setHoveredSetting("sideStripView");
    });

    const { result } = renderHook(() => useLiveAgentsSlotMode());

    expect(result.current).toBeNull();
  });

  it("stays live rather than preview once the view actually is Activity, even while pointed at", () => {
    verticalExpanded("activity");
    act(() => {
      useLayoutEditorStore.getState().setHoveredSetting("sideStripView");
    });

    const { result } = renderHook(() => useLiveAgentsSlotMode());

    expect(result.current).toBe("live");
  });
});
