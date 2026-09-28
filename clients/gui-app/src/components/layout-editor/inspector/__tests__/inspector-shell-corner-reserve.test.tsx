import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InspectorShell } from "@/components/layout-editor/inspector/inspector-shell";
import {
  useLayoutEditorStore,
  type LayoutDockMode,
} from "@/stores/layout/layout-editor-store";

/**
 * Docked left, the inspector header sits at the window's top-left corner, so
 * it alone keeps the traffic-light reserve; docked right or floating it does
 * not.
 */
const CORNER_RESERVE_CLASS =
  "wco:pl-[max(0.875rem,var(--window-leading-inset))]";

function setDockMode(dockMode: LayoutDockMode): void {
  useLayoutEditorStore.setState({ dockMode });
}

function renderHeader(): HTMLElement {
  const { container } = render(
    <InspectorShell onExit={() => {}}>{null}</InspectorShell>,
  );
  const header = container.querySelector<HTMLElement>(
    "[data-layout-inspector-header]",
  );
  if (header === null) throw new Error("inspector header not rendered");
  return header;
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutEditorStore.getState().endSession();
  setDockMode("right");
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("inspector header corner reserve", () => {
  it("keeps the traffic-light reserve docked left alone, following a live dock change", () => {
    setDockMode("left");
    const header = renderHeader();
    expect(header.classList.contains(CORNER_RESERVE_CLASS)).toBe(true);
    expect(header.classList.contains("pl-3.5")).toBe(true);

    for (const [dockMode, reserved] of [
      ["right", false],
      ["float", false],
      ["left", true],
    ] as const) {
      act(() => {
        setDockMode(dockMode);
      });
      expect(header.classList.contains(CORNER_RESERVE_CLASS), dockMode).toBe(
        reserved,
      );
      // The reserve is added on top of the header's own padding, never in
      // place of it.
      expect(header.classList.contains("pl-3.5"), dockMode).toBe(true);
    }
  });
});
