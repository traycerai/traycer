import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelLayoutDrag,
  layoutDragActive,
} from "@/components/layout-editor/canvas/drag-engine";
import { armSurfaceDrag } from "@/components/layout-editor/canvas/surface-drag";
import { SURFACE_PLACEMENT } from "@/components/layout-editor/canvas/surface-placement";
import { LayoutEditor } from "@/components/layout-editor/layout-editor";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The notification feed is the one external boundary here: the relay row's
 * signal is what `merged-notifications` classifies as blocking, and standing
 * up a host feed to produce one would test that store, not this root.
 */
const feed = vi.hoisted(() => ({ blocking: 0 }));
vi.mock(
  "@/stores/notifications/merged-notifications",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/stores/notifications/merged-notifications")
    >()),
    useBlockingAttentionCount: () => feed.blocking,
  }),
);

/**
 * The other external boundary: the provider level's limit checklist observes
 * the status bar's own rate-limit cache (L-96), which needs a host runtime and
 * a query client this root has neither of. What the windows ARE is
 * `provider-limits-choose.test.tsx`'s subject; here the level only has to
 * mount so the ladder and the back row can be driven through it.
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
    // `LayoutEditor` wraps its inspector body in this directly (the shared
    // watched-usage read), which resolves a host scope the same way the
    // reader's own standalone fallback did - needing the `<HostRuntimeProvider>`
    // this root has none of. Nothing here reads ambient usage content, so a
    // pass-through is the whole fix.
    LayoutUsageProvider: (props: { readonly children: ReactNode }) =>
      props.children,
  }),
);

function mountColumn(): HTMLDivElement {
  const column = document.createElement("div");
  const control = document.createElement("button");
  column.append(control);
  document.body.append(column);
  return column;
}

function openSession(): void {
  useLayoutEditorStore.getState().beginSession({
    entry: "pointer",
    source: "direct_ui",
    startedAt: 0,
    origin: { kind: "tab" },
  });
}

function hideTheMic(): void {
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
  });
}

function escape(target: EventTarget): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * A named radio group INSIDE the inspector, or null. Scoped to it because the
 * canvas draws its own placement bar with the same names (`Sidebar side` among
 * them): the claim is about the form the inspector shows, not about the page.
 */
function inspectorRadioGroup(name: string): HTMLElement | null {
  const inspector = document.querySelector("[data-layout-inspector]");
  if (!(inspector instanceof HTMLElement))
    throw new Error("the inspector is not mounted");
  return within(inspector).queryByRole("radiogroup", { name });
}

function chord(shift: boolean): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    metaKey: true,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  feed.blocking = 0;
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
  cancelLayoutDrag();
  cleanup();
  document.body.replaceChildren();
  useLayoutEditorStore.getState().endSession();
});

describe("the mounted editor root", () => {
  it("draws nothing and leaves the column alone until a session opens", () => {
    const column = mountColumn();

    const view = render(<LayoutEditor column={column} />);

    expect(view.container.querySelector("[data-layout-inspector]")).toBeNull();
    expect(column.hasAttribute("aria-hidden")).toBe(false);
    expect(column.hasAttribute("data-layout-editing")).toBe(false);
    expect(column.hasAttribute("data-inspector-dock")).toBe(false);
  });

  it("docks the inspector beside the column and firewalls the column", () => {
    const column = mountColumn();
    const view = render(<LayoutEditor column={column} />);

    act(() => {
      openSession();
    });

    const inspector = view.container.querySelector("[data-layout-inspector]");
    expect(inspector?.getAttribute("data-dock-mode")).toBe("right");
    expect(column.getAttribute("aria-hidden")).toBe("true");
    expect(column.getAttribute("data-layout-editing")).toBe("1");
    // The column carries the dock itself: the left-inset rule reads this
    // attribute, not a `:has()` over the inspector.
    expect(column.getAttribute("data-inspector-dock")).toBe("right");

    act(() => {
      useLayoutEditorStore.getState().setDockMode("left");
    });
    expect(
      view.container
        .querySelector("[data-layout-inspector]")
        ?.getAttribute("data-dock-mode"),
    ).toBe("left");
    expect(column.getAttribute("data-inspector-dock")).toBe("left");

    act(() => {
      useLayoutEditorStore.getState().endSession();
    });
    expect(column.hasAttribute("aria-hidden")).toBe(false);
    expect(column.hasAttribute("data-layout-editing")).toBe(false);
    expect(column.hasAttribute("data-inspector-dock")).toBe(false);
  });

  it("walks the layout history on Mod+Z and Mod+Shift+Z (L-18)", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);

    act(() => {
      openSession();
      hideTheMic();
    });
    expect(getLayoutSnapshot().overrides.mic).toEqual({ shown: "hidden" });

    act(() => {
      chord(false);
    });
    expect(getLayoutSnapshot().overrides.mic).toBeUndefined();

    act(() => {
      chord(true);
    });
    expect(getLayoutSnapshot().overrides.mic).toEqual({ shown: "hidden" });
  });

  it("leaves the chord alone when no session is open", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);

    act(() => {
      openSession();
      hideTheMic();
      useLayoutEditorStore.getState().endSession();
      useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
    });

    // `endSession` empties the history, so a leaked listener's undo would be
    // a no-op; the harm it would do is swallowing Cmd+Z in the app's own
    // text fields, which is what `defaultPrevented` shows.
    const event = chord(false);

    expect(event.defaultPrevented).toBe(false);
    expect(getLayoutSnapshot().overrides.mic).toEqual({ shown: "hidden" });
  });

  it("walks the Escape ladder from wherever the keyboard is (L-31, I-02)", () => {
    const column = mountColumn();
    const view = render(<LayoutEditor column={column} />);

    act(() => {
      openSession();
      useLayoutEditorStore.getState().select("usageLimits");
    });

    // Focus is on `<body>`, which is exactly where selecting a region used to
    // leave it: the panel-scoped listener never saw the key from here.
    expect(document.activeElement).not.toBe(document.body);
    document.body.focus();

    act(() => {
      escape(document.body);
    });
    // First rung: the selected row closes, its area stays open.
    expect(useLayoutEditorStore.getState().selected).toBeNull();
    expect(useLayoutEditorStore.getState().area).toBe("statusBar");

    act(() => {
      escape(document.body);
    });
    // Second rung: back to All settings, with focus left on the row for the
    // area the ladder just left (I-02).
    expect(useLayoutEditorStore.getState().area).toBeNull();
    expect(useLayoutEditorStore.getState().session).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-layout-area")).toBe(
      "statusBar",
    );

    // Off the bottom rung: Escape never closes the editor (audit F5).
    act(() => {
      escape(document.body);
    });
    expect(useLayoutEditorStore.getState().session).not.toBeNull();
    expect(useLayoutEditorStore.getState().area).toBeNull();
    expect(
      view.container.querySelector("[data-layout-inspector]"),
    ).not.toBeNull();
  });

  it("leaves Escape alone when no session is open", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(useLayoutEditorStore.getState().selected).toBeNull();
    // The ladder is armed only while a session is live: outside one, Escape
    // belongs to whatever else in the app is listening for it.
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves Escape to an overlay that has taken focus", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);

    act(() => {
      openSession();
      useLayoutEditorStore.getState().select("usageLimits");
    });
    act(() => {
      escape(menu);
    });

    // The menu dismisses itself; the level the user was reading stays open.
    expect(useLayoutEditorStore.getState().selected).toBe("usageLimits");
  });

  // Finding 1 (final-review/canvas-and-editor): Escape used to only pop the
  // inspector selection, leaving an in-hand surface drag's own listeners
  // live - the pointer release right after still wrote the placement. The
  // fix consumes Escape as a drag cancel first (L-31's own top rung), before
  // it ever reaches `popInspectorLevel`.
  it("Escape cancels an in-flight surface drag instead of deselecting it (finding 1)", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);

    act(() => {
      openSession();
      useLayoutEditorStore.getState().selectSurface("topBar");
    });

    const container = document.createElement("div");
    container.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const node = document.createElement("div");
    container.append(node);
    document.body.append(container);

    const arm = (event: Event): void => {
      if (!(event instanceof PointerEvent)) return;
      armSurfaceDrag({
        event,
        node,
        container,
        edges: SURFACE_PLACEMENT.topBar.edges,
        current: SURFACE_PLACEMENT.topBar.current(
          useLayoutStore.getState().arrangement,
        ),
        onDrop: SURFACE_PLACEMENT.topBar.write,
      });
    };
    node.addEventListener("pointerdown", arm);
    act(() => {
      node.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 1,
          button: 0,
          clientX: 100,
          clientY: 50,
        }),
      );
    });
    node.removeEventListener("pointerdown", arm);
    act(() => {
      // Crosses the activation distance, landing solidly inside the left
      // band - a real drop here would write `tabStripPlacement`.
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 1,
          clientX: 10,
          clientY: 56,
        }),
      );
    });

    expect(layoutDragActive()).toBe(true);
    expect(document.querySelectorAll("[data-layout-drop-zone]").length).toBe(3);

    const before = useLayoutEditorStore.getState().history.past.length;
    const arrangementBefore = useLayoutStore.getState().arrangement;

    act(() => {
      escape(document.body);
    });

    // The drag is torn down, not the selection.
    expect(layoutDragActive()).toBe(false);
    expect(document.querySelectorAll("[data-layout-drop-zone]").length).toBe(0);
    expect(useLayoutEditorStore.getState().selectedSurface).toBe("topBar");

    // The drag's own listeners are gone, so the release that follows the
    // cancel writes nothing.
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
      );
    });

    expect(useLayoutStore.getState().arrangement).toBe(arrangementBefore);
    expect(useLayoutEditorStore.getState().history.past.length).toBe(before);
  });

  it("draws the shared back row over the area level (L-89)", () => {
    const column = mountColumn();
    const view = render(<LayoutEditor column={column} />);

    act(() => {
      openSession();
    });
    expect(
      view.container.querySelector("[data-layout-inspector-back]"),
    ).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().select("usageLimits");
    });
    expect(
      view.container.querySelector("[data-layout-inspector-back]")?.textContent,
    ).toBe("All settings");
  });

  // The store half - `selectSurface` writes `area` - is
  // `layout-editor-store.test.ts`'s. This is the half after it: the mounted
  // inspector reads that `area` and draws the area's own rows, so a canvas
  // selection of a surface lands the user on the form that places it.
  it("opens the Task tabs area when the tab strip surface is selected: its Tab placement row is on screen, the Sidebar's is not", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);
    act(() => {
      openSession();
    });
    // At All settings neither area's own rows are drawn, so what appears next
    // is the selection's doing.
    expect(inspectorRadioGroup("Tab placement")).toBeNull();
    expect(inspectorRadioGroup("Sidebar side")).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().selectSurface("topBar");
    });

    expect(useLayoutEditorStore.getState().area).toBe("topBar");
    expect(inspectorRadioGroup("Tab placement")).not.toBeNull();
    expect(inspectorRadioGroup("Sidebar side")).toBeNull();
  });

  it("opens the Sidebar area when the sidebar surface is selected: its Sidebar side row is on screen, the Task tabs' is not", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);
    act(() => {
      openSession();
      useLayoutEditorStore.getState().selectSurface("topBar");
    });
    expect(inspectorRadioGroup("Tab placement")).not.toBeNull();

    act(() => {
      useLayoutEditorStore.getState().selectSurface("sidebar");
    });

    expect(useLayoutEditorStore.getState().area).toBe("sidebar");
    expect(inspectorRadioGroup("Sidebar side")).not.toBeNull();
    expect(inspectorRadioGroup("Tab placement")).toBeNull();
  });

  it("raises the relay row only while something is blocking on the user (4.8)", () => {
    const column = mountColumn();
    const view = render(<LayoutEditor column={column} />);

    act(() => {
      openSession();
    });
    expect(view.container.textContent).not.toContain(
      "An agent is waiting for you",
    );

    feed.blocking = 1;
    act(() => {
      view.rerender(<LayoutEditor column={column} />);
    });

    expect(view.container.textContent).toContain("An agent is waiting for you");
  });
});

describe("the inspector chrome", () => {
  function openInspectorMenu(): void {
    // Radix's DropdownMenuTrigger opens on pointerdown, not the click event.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Inspector options" }),
      { button: 0 },
    );
  }

  function openMoreWaysOut(): void {
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More ways out" }),
      { button: 0 },
    );
  }

  it("writes the dock mode from the ⋯ menu, and the checked radio reflects the store", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);
    act(() => {
      openSession();
    });

    openInspectorMenu();
    expect(
      screen
        .getByRole("menuitemradio", { name: "Dock right" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Dock left" }));
    expect(useLayoutEditorStore.getState().dockMode).toBe("left");

    openInspectorMenu();
    expect(
      screen
        .getByRole("menuitemradio", { name: "Dock left" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("menuitemradio", { name: "Dock right" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Float" }));
    expect(useLayoutEditorStore.getState().dockMode).toBe("float");
  });

  it("disables the Discard item until something has changed", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);
    act(() => {
      openSession();
    });

    openMoreWaysOut();
    const untouched = screen.getByRole("menuitem", {
      name: /Discard session changes/,
    });
    expect(
      untouched.getAttribute("data-disabled") === "" ||
        untouched.getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });

  it("leaves the layout and the session untouched when Discard's confirm is cancelled", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);
    act(() => {
      openSession();
      hideTheMic();
    });

    openMoreWaysOut();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Discard session changes/ }),
    );
    fireEvent.click(screen.getByTestId("confirm-cancel"));

    expect(getLayoutSnapshot().overrides.mic).toEqual({ shown: "hidden" });
    expect(useLayoutEditorStore.getState().session).not.toBeNull();
  });

  it("restores the entry snapshot and ends the session on Discard confirm", () => {
    const column = mountColumn();
    const view = render(<LayoutEditor column={column} />);
    act(() => {
      openSession();
    });
    const entry = getLayoutSnapshot();

    act(() => {
      hideTheMic();
    });
    expect(getLayoutSnapshot().overrides.mic).toEqual({ shown: "hidden" });

    openMoreWaysOut();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Discard session changes/ }),
    );
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(getLayoutSnapshot()).toEqual(entry);
    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(view.container.querySelector("[data-layout-inspector]")).toBeNull();
  });

  // Item 4: a check reads as a selected state, which Done in a "way out" menu
  // is not - so its icon slot is an empty `aria-hidden` spacer that only keeps
  // the label lined up with Discard's, never a check glyph.
  it("gives Done an empty icon slot rather than a check, while Discard keeps its icon", () => {
    const column = mountColumn();
    render(<LayoutEditor column={column} />);
    act(() => {
      openSession();
    });

    openMoreWaysOut();

    const doneItem = screen.getByRole("menuitem", { name: /^Done/ });
    expect(doneItem.querySelector("svg")).toBeNull();
    expect(doneItem.querySelector('[aria-hidden="true"]')).not.toBeNull();

    const discardItem = screen.getByRole("menuitem", {
      name: /Discard session changes/,
    });
    expect(discardItem.querySelector("svg")).not.toBeNull();
  });
});
