import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InspectorShell,
  type InspectorExit,
} from "@/components/layout-editor/inspector/inspector-shell";
import {
  LayoutAllSettings,
  LayoutAreaLevel,
} from "@/components/layout-editor/inspector/layout-form";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The provider row's limit checklist reads the status bar's rate-limit cache
 * (L-96), which wants a host runtime this keyboard harness has no business
 * standing up. The windows themselves are `provider-limits-choose.test.tsx`'s
 * subject.
 */
vi.mock(
  "@/components/layout-editor/inspector/provider-limit-windows",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/layout-editor/inspector/provider-limit-windows")
    >()),
    ProviderLimitWindowsReader: (props: {
      readonly children: (limits: {
        windows: ReadonlyArray<never>;
        drawnKeys: ReadonlyArray<never>;
      }) => ReactNode;
    }) => props.children({ windows: [], drawnKeys: [] }),
  }),
);

/**
 * The body `layout-editor.tsx` mounts, with which of the two levels shows read
 * straight off the editor store's own `area`. Nothing here belongs in the
 * components under test; the harness only composes them the way the editor
 * root does, so the keyboard model can be driven without a session, a canvas
 * and a firewall around it.
 *
 * Escape is deliberately NOT part of it: the ladder is the editor root's own
 * `document` listener (I-02), and `layout-editor.test.tsx` drives it there.
 */
function Harness(props: {
  readonly onExit: (reason: InspectorExit) => void;
}): ReactNode {
  const area = useLayoutEditorStore((state) => state.area);
  return (
    <InspectorShell onExit={props.onExit}>
      {area === null ? (
        <LayoutAllSettings />
      ) : (
        <LayoutAreaLevel key={area} area={area} />
      )}
    </InspectorShell>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({
    instances: new Map(),
    dockMode: "right",
    floatPosition: null,
    lockedBy: "none",
  });
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("inspector keyboard model (L-31)", () => {
  it("walks the areas with arrows, and the focused row opens its area", () => {
    render(<Harness onExit={() => {}} />);

    const filterInput = screen.getByRole("textbox", { name: "Find a setting" });

    // ArrowDown from the filter reaches the first area row (L-31). Task tabs
    // is declared first (region-grammar.ts's `SURFACE_GROUPS`), so it is the
    // first row regardless of the registry's own key order.
    fireEvent.keyDown(filterInput, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-layout-area")).toBe(
      "topBar",
    );

    // ArrowDown again walks to the next row.
    const firstRow = document.activeElement;
    if (firstRow === null) throw new Error("expected a focused row");
    fireEvent.keyDown(firstRow, { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(firstRow);
    expect(document.activeElement?.getAttribute("data-layout-area")).toBe(
      "sidebar",
    );

    // Back to the first row, which opens its area (a native button, so Enter
    // and Space reach it as a click).
    const secondRow = document.activeElement;
    if (secondRow === null) throw new Error("expected a focused row");
    fireEvent.keyDown(secondRow, { key: "ArrowUp" });
    const backAtFirstRow = document.activeElement;
    if (backAtFirstRow === null) throw new Error("expected a focused row");
    expect(backAtFirstRow.getAttribute("data-layout-area")).toBe("topBar");
    fireEvent.click(backAtFirstRow);
    expect(useLayoutEditorStore.getState().area).toBe("topBar");
    // `@testing-library/jest-dom` is not wired into this repo's vitest
    // setup, so presence is read via `query*` + a plain null check.
    expect(screen.queryByText("Task tabs")).not.toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Find a setting" }),
    ).toBeNull();
  });

  it("returns focus to the filter on ArrowUp from the first row", () => {
    render(<Harness onExit={() => {}} />);
    const filterInput = screen.getByRole("textbox", { name: "Find a setting" });

    fireEvent.keyDown(filterInput, { key: "ArrowDown" });
    const firstRow = document.activeElement;
    if (firstRow === null) throw new Error("expected a focused row");
    expect(firstRow.getAttribute("data-layout-area")).toBe("topBar");

    fireEvent.keyDown(firstRow, { key: "ArrowUp" });
    expect(document.activeElement).toBe(filterInput);
  });

  it("leaves Enter alone when the filter matches nothing", () => {
    render(<Harness onExit={() => {}} />);
    const filterInput = screen.getByRole("textbox", { name: "Find a setting" });

    fireEvent.change(filterInput, { target: { value: "zzzz" } });
    fireEvent.keyDown(filterInput, { key: "Enter" });

    expect(useLayoutEditorStore.getState().area).toBeNull();
  });

  it("keeps an area whose region now reads the typed state word, and opens it with that row on Enter", () => {
    // Todo's own name and keywords never say "chip" - "Full row" is its
    // default state word - so ITS match here can only come from the row's own
    // CURRENT state, not from label/keyword search (Model also matches "chip",
    // as its own registry keyword, but ranks below a state-word hit).
    useLayoutStore.getState().setRegionValues("todo", { size: "chip" });
    render(<Harness onExit={() => {}} />);
    const filterInput = screen.getByRole("textbox", { name: "Find a setting" });

    fireEvent.change(filterInput, { target: { value: "chip" } });
    expect(
      document.querySelector('[data-layout-find-result="todo"]'),
    ).not.toBeNull();
    expect(screen.queryByText("Task tabs")).toBeNull();

    fireEvent.keyDown(filterInput, { key: "Enter" });

    expect(useLayoutEditorStore.getState().area).toBe("composer");
    expect(useLayoutEditorStore.getState().selected).toBe("todo");
    expect(useLayoutEditorStore.getState().openRows).toContain("todo");
  });
});

describe("the shared back row (L-89)", () => {
  it("takes focus on the way into an area and walks back out of it", () => {
    render(<Harness onExit={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /Task tabs/ }));

    const back = screen.getByRole("button", { name: "All settings" });
    expect(document.activeElement).toBe(back);
    expect(useLayoutEditorStore.getState().area).toBe("topBar");

    fireEvent.click(back);
    expect(useLayoutEditorStore.getState().area).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Find a setting" }),
    ).not.toBeNull();
  });
});
