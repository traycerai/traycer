import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegionFilter } from "@/components/layout-editor/inspector/region-filter";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * The one field, at the inspector's All settings level. `onArrowDown` and
 * `onEnter` are required: the field always has somewhere to send them, since
 * the store's own `filter` always has an All settings level above it.
 */
function renderFilter(props: {
  readonly onArrowDown: () => void;
  readonly onEnter: () => void;
}): void {
  render(
    <RegionFilter
      ref={null}
      onArrowDown={props.onArrowDown}
      onEnter={props.onEnter}
    />,
  );
}

function field(): HTMLElement {
  return screen.getByRole("textbox", { name: "Find a setting" });
}

beforeEach(() => {
  useLayoutEditorStore.getState().setFilter("");
  useLayoutEditorStore.getState().setKeyboardNav(false);
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().setFilter("");
  useLayoutEditorStore.getState().setKeyboardNav(false);
});

describe("the filter's keys (R2-04)", () => {
  it("takes ArrowDown and hands it to the caller", () => {
    const onArrowDown = vi.fn();
    renderFilter({ onArrowDown, onEnter: vi.fn() });

    // `fireEvent` answers false when the event was canceled, which is the
    // only observable difference between a key left to the browser and one
    // taken and dropped.
    const delivered = fireEvent.keyDown(field(), { key: "ArrowDown" });

    expect(delivered).toBe(false);
    expect(onArrowDown).toHaveBeenCalledTimes(1);
    // `keyboardNav` is a fact about an editor SESSION; the field itself
    // writes no session flag.
    expect(useLayoutEditorStore.getState().keyboardNav).toBe(false);
  });

  it("takes Enter and hands it to the caller", () => {
    const onEnter = vi.fn();
    renderFilter({ onArrowDown: vi.fn(), onEnter });

    const delivered = fireEvent.keyDown(field(), { key: "Enter" });

    expect(delivered).toBe(false);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });
});

describe("clearing the filter (L-125)", () => {
  it("offers a clear button only while there is something to clear", () => {
    renderFilter({ onArrowDown: vi.fn(), onEnter: vi.fn() });

    expect(screen.queryByRole("button", { name: "Clear filter" })).toBeNull();

    fireEvent.change(field(), { target: { value: "mini" } });

    expect(
      screen.queryByRole("button", { name: "Clear filter" }),
    ).not.toBeNull();
  });

  it("empties the filter and returns focus to the field", () => {
    renderFilter({ onArrowDown: vi.fn(), onEnter: vi.fn() });
    const input = field();
    fireEvent.change(input, { target: { value: "mini" } });

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(useLayoutEditorStore.getState().filter).toBe("");
    // A clear that leaves focus on a button that has just disappeared is a
    // keyboard dead end, which is why Escape alone was not enough.
    expect(document.activeElement).toBe(input);
  });

  it("still clears on Escape", () => {
    renderFilter({ onArrowDown: vi.fn(), onEnter: vi.fn() });
    const input = field();
    fireEvent.change(input, { target: { value: "mini" } });

    fireEvent.keyDown(input, { key: "Escape" });

    expect(useLayoutEditorStore.getState().filter).toBe("");
  });
});
