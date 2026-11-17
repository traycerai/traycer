import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresetsBlock } from "@/components/layout-editor/inspector/presets-block";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

// Split from `presets-block.test.tsx` to keep each file under the 10 s budget.

const toast = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  toast.mockClear();
  toast.dismiss.mockClear();
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("View changes (L-89 overturned: no separate level)", () => {
  it("shows a line per change with its own revert, which puts that one back", () => {
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "right",
      });
    });
    render(<PresetsBlock reveal={vi.fn()} />);

    expect(screen.getByTestId("preset-status-line").textContent).toBe(
      "Default",
    );
    expect(screen.queryAllByTestId("preset-card-modified")).toHaveLength(0);
    expect(screen.queryByTestId("changed-dot")).toBeNull();
    const note = screen.getByTestId("preset-kept-note");
    expect(note.textContent).toBe(
      "Presets keep your arrangement: 1 change under Arrangement.",
    );
    expect(
      screen
        .getByRole("button", { name: "Apply Default" })
        .getAttribute("aria-describedby")
        ?.split(" "),
    ).toContain(note.id);
    const toggle = screen.getByRole("button", { name: "View changes" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(
      screen
        .getByRole("button", { name: "Hide changes" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    const list = screen.getByTestId("layout-change-list");
    expect(list.textContent).toContain("Tab placement");

    fireEvent.click(
      screen.getByRole("button", { name: "Revert Tab placement" }),
    );

    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
      DEFAULT_ARRANGEMENT.tabStripPlacement,
    );
  });
});

describe("panels the rail shows are not a preset's to change", () => {
  function showFileTree(): void {
    act(() => {
      useLayoutStore
        .getState()
        .setRegionValues("railFileTree", { shown: "shown" });
    });
  }

  it("reads Default, not Modified, with File Tree shown", () => {
    showFileTree();
    render(<PresetsBlock reveal={vi.fn()} />);

    expect(screen.getByTestId("preset-status-line").textContent).toBe(
      "Default",
    );
    expect(screen.queryAllByTestId("preset-card-modified")).toHaveLength(0);
  });

  it("lists File Tree under Arrangement against Default, even with Compact applied, and its revert clears it", () => {
    act(() => {
      useLayoutStore.getState().applyPreset("compact");
    });
    showFileTree();
    render(<PresetsBlock reveal={vi.fn()} />);
    const toggle = screen.queryByRole("button", { name: "View changes" });
    if (toggle !== null) fireEvent.click(toggle);

    const arrangement = within(
      screen.getByTestId("layout-change-list"),
    ).getByRole("region", { name: "Arrangement" });
    expect(arrangement.textContent).toContain("File Tree");
    expect(arrangement.textContent).toContain("Default: ");
    expect(arrangement.textContent).not.toContain("Compact: ");

    fireEvent.click(screen.getByRole("button", { name: "Revert File Tree" }));

    expect(useLayoutStore.getState().overrides.railFileTree).toBeUndefined();
  });
});

describe("View changes' revert keeps focus in the list, or moves it to the applied card when the list empties", () => {
  function openViewChanges(): void {
    render(<PresetsBlock reveal={vi.fn()} />);
    // Whether the list is open is app-wide state that outlives one render,
    // so an earlier test may have left it open.
    const toggle = screen.queryByRole("button", { name: "View changes" });
    if (toggle !== null) fireEvent.click(toggle);
    screen.getByRole("button", { name: "Hide changes" });
  }

  function changeLineKeys(): ReadonlyArray<string> {
    return [
      ...screen
        .getByTestId("layout-change-list")
        .querySelectorAll("[data-change-line]"),
    ].flatMap((node) => {
      const key = node.getAttribute("data-change-line");
      return key === null ? [] : [key];
    });
  }

  it("reverting the first of three lines focuses the new first line - the old second line's ↺", () => {
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "right",
        sidebarSide: "left",
        minimapSide: "left",
      });
    });
    openViewChanges();
    expect(changeLineKeys()).toEqual([
      "tabStripPlacement",
      "sidebarSide",
      "minimapSide",
    ]);

    const revertTabPlacement = screen.getByRole("button", {
      name: "Revert Tab placement",
    });
    revertTabPlacement.focus();
    fireEvent.click(revertTabPlacement);

    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
      DEFAULT_ARRANGEMENT.tabStripPlacement,
    );
    const revertSidebarSide = screen.getByRole("button", {
      name: "Revert Sidebar side",
    });
    expect(document.activeElement).toBe(revertSidebarSide);
    expect(document.activeElement).not.toBe(document.body);
    expect(changeLineKeys()).toEqual(["sidebarSide", "minimapSide"]);
  });

  it("reverting the last of two lines focuses the remaining line's ↺", () => {
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "right",
        sidebarSide: "left",
      });
    });
    openViewChanges();
    expect(changeLineKeys()).toEqual(["tabStripPlacement", "sidebarSide"]);

    const revertSidebarSide = screen.getByRole("button", {
      name: "Revert Sidebar side",
    });
    revertSidebarSide.focus();
    fireEvent.click(revertSidebarSide);

    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("right");
    const revertTabPlacement = screen.getByRole("button", {
      name: "Revert Tab placement",
    });
    expect(document.activeElement).toBe(revertTabPlacement);
    expect(document.activeElement).not.toBe(document.body);
    expect(changeLineKeys()).toEqual(["tabStripPlacement"]);
  });

  it("reverting the only line empties the list, unmounts View changes, and focuses the applied preset's card", () => {
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "right",
      });
    });
    openViewChanges();
    expect(changeLineKeys()).toEqual(["tabStripPlacement"]);

    const revertTabPlacement = screen.getByRole("button", {
      name: "Revert Tab placement",
    });
    revertTabPlacement.focus();
    fireEvent.click(revertTabPlacement);

    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
      DEFAULT_ARRANGEMENT.tabStripPlacement,
    );
    expect(screen.queryByTestId("layout-change-list")).toBeNull();
    expect(screen.queryByRole("button", { name: "View changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide changes" })).toBeNull();
    const appliedCard = screen.getByRole("button", { name: "Apply Default" });
    expect(document.activeElement).toBe(appliedCard);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("reverting the last Styles line focuses the first Arrangement line's ↺", () => {
    act(() => {
      useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "right",
      });
    });
    openViewChanges();
    expect(changeLineKeys()).toEqual(["mic.display", "tabStripPlacement"]);

    const revertMicrophone = screen.getByRole("button", {
      name: "Revert Microphone",
    });
    revertMicrophone.focus();
    fireEvent.click(revertMicrophone);

    expect(useLayoutStore.getState().overrides.mic).toBeUndefined();
    const revertTabPlacement = screen.getByRole("button", {
      name: "Revert Tab placement",
    });
    expect(document.activeElement).toBe(revertTabPlacement);
    expect(document.activeElement).not.toBe(document.body);
    expect(changeLineKeys()).toEqual(["tabStripPlacement"]);
  });
});
