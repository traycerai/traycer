import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LayoutClusterContextMenu,
  LayoutRegionContextMenu,
} from "@/components/layout-editor/region-quick-verbs";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { offeredQuickVerbs } from "@/components/layout-editor/regions/quick-verbs";
import {
  SHOW_HIDE_VERBS,
  SIZE_ONLY_VERBS,
  SIZED_VERBS,
} from "@/components/layout-editor/regions/region-grammar";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { PRESET_VALUES } from "@/lib/layout/layout-presets";
import type { RegionId } from "@/lib/layout/region-id";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

interface CapturedToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

interface CapturedToast {
  readonly message: string;
  readonly id: string;
  readonly action: CapturedToastAction;
  readonly cancel: CapturedToastAction;
  readonly onAutoClose: (() => void) | undefined;
  readonly onDismiss: (() => void) | undefined;
}

const openLayoutEditorMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => [] as Array<CapturedToast>);

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));

vi.mock("@/lib/layout/editor-session", () => ({
  openLayoutEditor: openLayoutEditorMock,
}));

// Sonner renders into a toaster the app mounts elsewhere; what this suite is
// about is what the toast CARRIES, so the call is captured instead.
vi.mock("sonner", () => ({
  toast: (
    message: string,
    options: {
      readonly id: string;
      readonly action: CapturedToastAction;
      readonly cancel: CapturedToastAction;
      readonly onAutoClose: (() => void) | undefined;
      readonly onDismiss: (() => void) | undefined;
    },
  ) => {
    toasts.push({
      message,
      id: options.id,
      action: options.action,
      cancel: options.cancel,
      onAutoClose: options.onAutoClose,
      onDismiss: options.onDismiss,
    });
  },
}));

function Harness(props: { readonly regionId: RegionId }): ReactNode {
  return (
    <LayoutRegionContextMenu regionId={props.regionId}>
      <button type="button" data-testid="region">
        region
      </button>
    </LayoutRegionContextMenu>
  );
}

function openMenu(): void {
  fireEvent.contextMenu(screen.getByTestId("region"));
}

/**
 * A region's effective value, read the way the store resolves it - the base
 * preset under the minimal delta - so an assertion cannot pass merely because
 * a key was written as an override that repeats the base.
 */
function regionValue(regionId: RegionId, key: "shown" | "size"): unknown {
  const state = useLayoutStore.getState();
  const stored = state.overrides[regionId];
  const base = PRESET_VALUES[state.basePreset][regionId];
  return (
    (stored === undefined ? undefined : Reflect.get(stored, key)) ??
    Reflect.get(base, key)
  );
}

beforeEach(() => {
  toasts.length = 0;
  useLayoutStore.getState().replaceAll(DEFAULT_LAYOUT_SNAPSHOT);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useLayoutEditorStore.getState().endSession();
  useLayoutStore.getState().replaceAll(DEFAULT_LAYOUT_SNAPSHOT);
});

describe("offeredQuickVerbs", () => {
  it("offers one of the show/hide pair, never both", () => {
    expect(
      offeredQuickVerbs(SHOW_HIDE_VERBS, { hidden: false, chip: false }),
    ).toEqual(["hide"]);
    expect(
      offeredQuickVerbs(SHOW_HIDE_VERBS, { hidden: true, chip: false }),
    ).toEqual(["show"]);
  });

  it("offers only one verb, ever: hide/show first, the size verb only when the region has no hide", () => {
    // A region with both a hide and a size verb (Todo): hide always wins,
    // so the size verb never surfaces beside it.
    expect(
      offeredQuickVerbs(SIZED_VERBS, { hidden: false, chip: false }),
    ).toEqual(["hide"]);
    expect(
      offeredQuickVerbs(SIZED_VERBS, { hidden: false, chip: true }),
    ).toEqual(["hide"]);
    expect(
      offeredQuickVerbs(SIZED_VERBS, { hidden: true, chip: true }),
    ).toEqual(["show"]);
  });

  it("offers the size a region is NOT in, for a size-only region with no hide/show pair", () => {
    // Access (G6): size-only, so the size verb is the one thing left.
    expect(
      offeredQuickVerbs(SIZE_ONLY_VERBS, { hidden: false, chip: false }),
    ).toEqual(["chip"]);
    expect(
      offeredQuickVerbs(SIZE_ONLY_VERBS, { hidden: false, chip: true }),
    ).toEqual(["full"]);
  });
});

describe("<LayoutRegionContextMenu />", () => {
  // The chat display settings (audit R1, R3) take the same hide path as the
  // minimap. Each row resolves its own toast before finishing (there is one
  // pending-verb slot, module-wide) so it leaves nothing for a later test's
  // own `Analytics.track` spy to catch (L-19, L-46).
  it.each([
    { regionId: "minimap", name: "Minimap" },
    { regionId: "thinking", name: "Thinking" },
    { regionId: "timestamps", name: "Timestamps" },
  ] as const)(
    "hides $name and announces it with an Undo",
    ({ regionId, name }) => {
      render(<Harness regionId={regionId} />);
      openMenu();

      fireEvent.click(screen.getByTestId(`layout-quick-verb-${regionId}-hide`));

      expect(regionValue(regionId, "shown")).toBe("hidden");
      expect(toasts.at(-1)?.message).toBe(`${name} hidden`);
      expect(toasts.at(-1)?.action.label).toBe("Undo");
      toasts.at(-1)?.onAutoClose?.();
    },
  );

  // A second verb replaces the first's toast rather than stacking beside it, so
  // the only Undo on screen is always the last verb's. Only one verb is ever
  // offered at once now, so the two opens have to be two DIFFERENT states of
  // the same region - hide, then (now hidden) show - rather than two verbs
  // offered side by side in one menu.
  it("shows one toast at a time, whichever verb fired", () => {
    render(<Harness regionId="todo" />);

    openMenu();
    fireEvent.click(screen.getByTestId("layout-quick-verb-todo-hide"));
    const hideToast = toasts.at(-1);

    openMenu();
    fireEvent.click(screen.getByTestId("layout-quick-verb-todo-show"));

    expect(hideToast?.id).toBeTypeOf("string");
    expect(toasts.at(-1)?.id).toBe(hideToast?.id);
  });

  // The case a snapshot-based Undo gets wrong: something ELSE changes the same
  // region while the toast is up. Undo must put back the one leaf the verb
  // wrote and leave the rest where it now stands. Needs Hide, so Todo
  // (SIZED_VERBS) stands in for Access here too.
  it("puts back only the leaf the verb wrote, not the region as it was", () => {
    render(<Harness regionId="todo" />);
    openMenu();
    fireEvent.click(screen.getByTestId("layout-quick-verb-todo-hide"));
    expect(regionValue("todo", "shown")).toBe("hidden");
    const hideToast = toasts.at(-1);

    // Written from outside this menu - the Layout settings page, another
    // window - while the toast is still on screen.
    useLayoutStore.getState().setRegionValues("todo", { size: "chip" });

    hideToast?.action.onClick();

    expect(regionValue("todo", "shown")).toBe("shown");
    expect(regionValue("todo", "size")).toBe("chip");
  });

  it("brings a rail panel back to auto, not pinned open (L-47)", () => {
    useLayoutStore.getState().setRegionValues("railComments", {
      shown: "hidden",
    });
    render(<Harness regionId="railComments" />);
    openMenu();

    fireEvent.click(screen.getByTestId("layout-quick-verb-railComments-show"));

    expect(regionValue("railComments", "shown")).toBe("auto");
  });

  it("opens the editor on the region the menu was over, with a tab origin", () => {
    render(<Harness regionId="mic" />);
    openMenu();

    fireEvent.click(screen.getByTestId("customize-layout-menu-item"));

    expect(openLayoutEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "direct_ui",
        entry: "pointer",
        target: "mic",
        origin: { kind: "tab" },
      }),
    );
  });

  it("offers the same way in from the toast", () => {
    render(<Harness regionId="minimap" />);
    openMenu();
    fireEvent.click(screen.getByTestId("layout-quick-verb-minimap-hide"));

    expect(toasts.at(-1)?.cancel.label).toBe("Customize layout...");
    toasts.at(-1)?.cancel.onClick();

    expect(openLayoutEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: "minimap" }),
    );
  });

  // Chat display settings (audit R1, R3): Tool activity is Closed by
  // default, so its one offered verb is the size verb, worded as an
  // open/close pair like Thinking's. It resolves its own toast before
  // finishing, for the same reason as the hide rows above.
  it("offers to open a closed Tool activity, and opening it sets size full", () => {
    render(<Harness regionId="toolActivity" />);
    openMenu();

    fireEvent.click(screen.getByTestId("layout-quick-verb-toolActivity-full"));

    expect(regionValue("toolActivity", "size")).toBe("full");
    expect(toasts.at(-1)?.message).toBe("Tool activity open");
    toasts.at(-1)?.onAutoClose?.();
  });
});

describe("layout_quick_verb analytics (L-19, L-46)", () => {
  it("sends one event with undone: true when Undo is clicked", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    render(<Harness regionId="minimap" />);
    openMenu();
    fireEvent.click(screen.getByTestId("layout-quick-verb-minimap-hide"));
    expect(trackSpy).not.toHaveBeenCalled();

    toasts.at(-1)?.action.onClick();

    expect(trackSpy).toHaveBeenCalledExactlyOnceWith(
      AnalyticsEvent.LayoutQuickVerb,
      { region: "minimap", verb: "hide", undone: true },
    );
  });

  it.each([
    { how: "auto-expires", callback: "onAutoClose" },
    { how: "is dismissed without Undo", callback: "onDismiss" },
  ] as const)(
    "sends one event with undone: false when the toast $how",
    ({ callback }) => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      render(<Harness regionId="minimap" />);
      openMenu();
      fireEvent.click(screen.getByTestId("layout-quick-verb-minimap-hide"));

      toasts.at(-1)?.[callback]?.();

      expect(trackSpy).toHaveBeenCalledExactlyOnceWith(
        AnalyticsEvent.LayoutQuickVerb,
        { region: "minimap", verb: "hide", undone: false },
      );
    },
  );

  // Only one verb is ever offered at once now, so the two opens are two
  // different states of the same region - hide, then (now hidden) show.
  it("sends undone: false for a verb whose toast a second verb replaces", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    render(<Harness regionId="todo" />);

    openMenu();
    fireEvent.click(screen.getByTestId("layout-quick-verb-todo-hide"));
    expect(trackSpy).not.toHaveBeenCalled();

    openMenu();
    fireEvent.click(screen.getByTestId("layout-quick-verb-todo-show"));

    // The first verb's toast was replaced before it ever resolved, so it is
    // reported here - as "stood", never undone - rather than lost.
    expect(trackSpy).toHaveBeenCalledExactlyOnceWith(
      AnalyticsEvent.LayoutQuickVerb,
      { region: "todo", verb: "hide", undone: false },
    );

    toasts.at(-1)?.onAutoClose?.();

    expect(trackSpy).toHaveBeenCalledTimes(2);
    expect(trackSpy).toHaveBeenLastCalledWith(AnalyticsEvent.LayoutQuickVerb, {
      region: "todo",
      verb: "show",
      undone: false,
    });
  });

  it("sends undone: false when 'Customize layout...' is chosen instead of Undo", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    render(<Harness regionId="minimap" />);
    openMenu();
    fireEvent.click(screen.getByTestId("layout-quick-verb-minimap-hide"));

    toasts.at(-1)?.cancel.onClick();

    expect(trackSpy).toHaveBeenCalledExactlyOnceWith(
      AnalyticsEvent.LayoutQuickVerb,
      { region: "minimap", verb: "hide", undone: false },
    );
  });
});

/**
 * One root for a whole strip of regions (G3-10). The verbs still belong to the
 * item the pointer was on, which is the thing a shared root could get wrong.
 */
describe("<LayoutClusterContextMenu />", () => {
  function Cluster(): ReactNode {
    return (
      <LayoutClusterContextMenu>
        <div data-testid="cluster">
          <span data-layout-region="minimap" data-testid="first">
            first
          </span>
          <span data-layout-region="access" data-testid="second">
            second
          </span>
        </div>
      </LayoutClusterContextMenu>
    );
  }

  it("offers the verbs of the item the pointer was over", () => {
    render(<Cluster />);

    fireEvent.contextMenu(screen.getByTestId("second"));

    expect(
      screen.queryByTestId("layout-quick-verb-access-chip"),
    ).not.toBeNull();
    expect(screen.queryByTestId("layout-quick-verb-minimap-hide")).toBeNull();
  });

  it("opens nothing over the strip's own gaps", () => {
    render(<Cluster />);

    fireEvent.contextMenu(screen.getByTestId("cluster"));

    expect(screen.queryByTestId("layout-quick-verb-access-chip")).toBeNull();
    expect(screen.queryByTestId("layout-quick-verb-minimap-hide")).toBeNull();
  });

  /**
   * A cluster is a CONTAINER, and one may hold controls that own their own
   * right-click - a file row in Changed files, a queue item (L-144).
   *
   * The innermost menu wins, and this is the measurement that says so rather
   * than the module's old claim that both would fire: Radix composes the
   * caller's handler ahead of its own opener and skips that opener once the
   * event is default-prevented, and the inner trigger has already prevented it
   * by the time the event reaches the cluster's. Nothing in
   * `region-quick-verbs.tsx` arbitrates it, so this is the only thing that
   * would notice if the primitive stopped behaving that way.
   */
  it("leaves a press on an inner control's own menu to that menu", () => {
    render(
      <LayoutClusterContextMenu>
        <div data-testid="cluster">
          <span data-layout-region="changedFiles" data-testid="row">
            <ContextMenu>
              <ContextMenuTrigger
                render={
                  <button type="button" data-testid="inner">
                    a row with a menu
                  </button>
                }
              />
              <ContextMenuContent>
                <ContextMenuItem data-testid="inner-item">
                  Reveal in Finder
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            <span data-testid="row-header">3 files changed</span>
          </span>
        </div>
      </LayoutClusterContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("inner"));

    expect(screen.queryByTestId("inner-item")).not.toBeNull();
    expect(
      screen.queryByTestId("layout-quick-verb-changedFiles-hide"),
    ).toBeNull();

    // And the row's own header, which nothing else is listening on, still
    // gets the verbs.
    fireEvent.contextMenu(screen.getByTestId("row-header"));

    expect(
      screen.queryByTestId("layout-quick-verb-changedFiles-hide"),
    ).not.toBeNull();
  });
});

/**
 * What the menu does NOT answer (L-150(2)).
 *
 * The real chat dock is wrapped in a cluster menu for every user at rest, and
 * a dock row is a named region, so every descendant of one resolved to it:
 * selecting a file path and right-clicking it opened the quick verbs and took
 * Electron's Copy away. The same held for a link inside a Background item and
 * for any editable that lands in the dock, and a press on the frame's own
 * padding suppressed the app's menu and opened nothing at all.
 *
 * The presses below are NATIVE bubbling `contextmenu` events, because what is
 * being measured is `defaultPrevented` at the end of the dispatch - which is
 * the only thing Chromium consults before sending `ShowContextMenu`, and the
 * only thing that decides whether Electron's `context-menu` ever fires.
 */
describe("a press the operating system's own menu serves", () => {
  function press(node: HTMLElement): MouseEvent {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      node.dispatchEvent(event);
    });
    return event;
  }

  function renderDock(): void {
    render(
      <LayoutClusterContextMenu>
        <div data-testid="dock">
          <span data-layout-region="changedFiles" data-testid="row">
            <span data-testid="row-header">3 files changed</span>
            <span data-testid="path">src/app.ts</span>
            <a href="https://example.com" data-testid="link">
              open
            </a>
            <input data-testid="field" defaultValue="note" />
          </span>
          <span data-testid="padding">the frame&apos;s own padding</span>
        </div>
      </LayoutClusterContextMenu>,
    );
  }

  function verbsShowing(): boolean {
    return screen.queryByTestId("layout-quick-verb-changedFiles-hide") !== null;
  }

  it("leaves a link and an editable field inside a named row alone", () => {
    renderDock();

    for (const testId of ["link", "field"]) {
      const event = press(screen.getByTestId(testId));

      expect(event.defaultPrevented).toBe(false);
      expect(verbsShowing()).toBe(false);
    }
  });

  it("leaves a press inside a text selection alone", () => {
    renderDock();
    const path = screen.getByTestId("path");
    const range = document.createRange();
    range.selectNodeContents(path);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const event = press(path);

    expect(event.defaultPrevented).toBe(false);
    expect(verbsShowing()).toBe(false);

    // And with the selection gone, the same press is the editor's again.
    selection?.removeAllRanges();
    const again = press(path);

    expect(again.defaultPrevented).toBe(true);
    expect(verbsShowing()).toBe(true);
  });

  it("leaves the cluster's own padding to whatever owns it", () => {
    renderDock();

    const event = press(screen.getByTestId("padding"));

    // Not a dead gesture: nothing opens AND nothing is prevented, so the app's
    // own menu still raises where it used to.
    expect(event.defaultPrevented).toBe(false);
    expect(verbsShowing()).toBe(false);
  });

  it("still opens the verbs on the row's own header", () => {
    renderDock();

    const event = press(screen.getByTestId("row-header"));

    expect(verbsShowing()).toBe(true);
    // Radix's trigger prevents the event itself once it opens, which is what
    // keeps the native menu from arriving on top of the verbs.
    expect(event.defaultPrevented).toBe(true);
  });

  it("stands down for a region menu too, which wraps chrome the same way", () => {
    render(
      <LayoutRegionContextMenu regionId="minimap">
        <span data-testid="chrome">
          <a href="https://example.com" data-testid="chrome-link">
            open
          </a>
          <span data-testid="chrome-body">body</span>
        </span>
      </LayoutRegionContextMenu>,
    );

    const onLink = press(screen.getByTestId("chrome-link"));

    expect(onLink.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("layout-quick-verb-minimap-hide")).toBeNull();

    const onBody = press(screen.getByTestId("chrome-body"));

    expect(onBody.defaultPrevented).toBe(true);
    expect(
      screen.queryByTestId("layout-quick-verb-minimap-hide"),
    ).not.toBeNull();
  });
});

/**
 * The same strip, with the regions named by the hook the app really uses
 * instead of by hand (L-129).
 *
 * The suite above stamps `data-layout-region` itself, so it passed for three
 * rounds while every cluster in the product answered a right-click with
 * nothing: the hook only named a node inside an editor session, and quick
 * verbs are a gesture for normal use (L-19). A cluster test that writes the
 * attribute cannot see that, which is why this one does not.
 */
describe("<LayoutClusterContextMenu /> over regions the app named itself", () => {
  function LiveItem(props: {
    readonly regionId: RegionId;
    readonly testId: string;
  }): ReactNode {
    const { ref } = useLayoutRegion({
      regionId: props.regionId,
      instanceId: null,
    });
    return (
      <span ref={ref} data-testid={props.testId}>
        <span data-testid={`${props.testId}-glyph`}>item</span>
      </span>
    );
  }

  function LiveCluster(): ReactNode {
    return (
      <LayoutClusterContextMenu>
        <div data-testid="live-cluster">
          <LiveItem regionId="minimap" testId="live-minimap" />
          <LiveItem regionId="access" testId="live-access" />
        </div>
      </LayoutClusterContextMenu>
    );
  }

  it("offers the pointed-at item's verbs at rest, with no session open", () => {
    expect(useLayoutEditorStore.getState().session).toBeNull();
    render(<LiveCluster />);

    // On the glyph, not on the named element: the pointer lands on whatever a
    // control draws, and the region is its closest named ancestor.
    fireEvent.contextMenu(screen.getByTestId("live-access-glyph"));

    expect(
      screen.queryByTestId("layout-quick-verb-access-chip"),
    ).not.toBeNull();
    expect(screen.queryByTestId("layout-quick-verb-minimap-hide")).toBeNull();
  });

  it("offers them inside a session too", () => {
    render(<LiveCluster />);
    act(() => {
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });
    });

    fireEvent.contextMenu(screen.getByTestId("live-minimap-glyph"));

    expect(
      screen.queryByTestId("layout-quick-verb-minimap-hide"),
    ).not.toBeNull();
  });
});
