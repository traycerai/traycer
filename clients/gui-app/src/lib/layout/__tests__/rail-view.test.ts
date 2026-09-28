import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSidebarSide } from "@/lib/layout/rail-view";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * Finding 8: the rail's "Move sidebar to..." writer, migrated onto
 * `writeArrangementField` - the same one writer the placement bar's drop and
 * the dock's `SidebarSideRow` use (D14), so a move from any of the three
 * takes the same recorded-gesture path.
 */

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
});

afterEach(() => {
  useLayoutEditorStore.getState().endSession();
});

describe("setSidebarSide", () => {
  it("is one recorded gesture inside a layout editor session, and undo restores it", () => {
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });

    setSidebarSide("right");

    expect(useLayoutEditorStore.getState().history.past).toHaveLength(1);
    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("right");

    useLayoutEditorStore.getState().undo();
    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("left");
  });

  it("writes against the arrangement as it is NOW, not a snapshot taken earlier", () => {
    useLayoutStore.setState({
      arrangement: {
        ...useLayoutStore.getState().arrangement,
        usageHost: "header",
      },
    });
    const before = useLayoutStore.getState().arrangement;

    setSidebarSide("right");

    // Every other field is the live one, the moved `usageHost` included.
    expect(useLayoutStore.getState().arrangement).toEqual({
      ...before,
      sidebarSide: "right",
    });
  });
});
