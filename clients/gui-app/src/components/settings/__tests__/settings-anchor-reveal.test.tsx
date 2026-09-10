import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { useSettingsAnchorReveal } from "@/components/settings/use-settings-anchor-reveal";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

/**
 * The reveal watcher, tested for the two things that actually broke it.
 *
 * 1. Finding the element ends the REQUEST but must not end the MARK. Those two
 *    lifetimes originally shared one effect, and since clearing the request
 *    mutates a value that effect depends on, React tore the effect down the
 *    instant it succeeded — and the teardown stripped the attribute it had
 *    just set. The row scrolled into view and simply never lit up.
 *
 * 2. Scrolling must move ONLY the pane the row lives in. `scrollIntoView`
 *    moves every scrollable ancestor, and in the modal that dragged the whole
 *    dialog — header, rail and all — up along with the panel.
 *
 * So the assertions below are about STATE AFTER SETTLING and about WHICH
 * element moved — not about whether some call happened. A test that only
 * asserted a scroll method was invoked would have passed against both bugs.
 *
 * jsdom does no layout, so it has no `checkVisibility` and every
 * `offsetParent` is null. The suite installs a `checkVisibility` that answers
 * the one question layout would: is the element inside a `hidden` subtree?
 */

const ANCHOR = "test-anchor";

/**
 * Two nested scrollable panes around the row, mirroring the modal: the outer
 * one is the dialog's container, the inner one is the panel pane. jsdom does
 * no layout, so the geometry that decides "does this pane scroll?" is stubbed
 * on the elements by the test, and `scrollTo` — absent in jsdom — is a spy.
 */
function Harness(props: { readonly section: "general" | "appearance" }) {
  useSettingsAnchorReveal(props.section);
  return (
    <div data-testid="outer" style={{ overflowY: "auto" }}>
      <div data-testid="pane" style={{ overflowY: "auto" }}>
        <div data-settings-anchor={ANCHOR}>row</div>
      </div>
    </div>
  );
}

/**
 * The row behind a concealing wrapper, as a host scope gate keeps its content
 * mounted but hidden while the host connects.
 */
function ConcealedHarness(props: { readonly concealed: boolean }) {
  useSettingsAnchorReveal("general");
  return (
    <div data-testid="outer" style={{ overflowY: "auto" }}>
      <div data-testid="pane" style={{ overflowY: "auto" }}>
        <div hidden={props.concealed}>
          <div data-settings-anchor={ANCHOR}>row</div>
        </div>
      </div>
    </div>
  );
}

/** A watcher with one named anchor on screen. */
function AnchorHarness(props: { readonly anchor: string }) {
  useSettingsAnchorReveal("general");
  return (
    <div data-testid="outer" style={{ overflowY: "auto" }}>
      <div data-testid="pane" style={{ overflowY: "auto" }}>
        <div data-settings-anchor={props.anchor}>row</div>
      </div>
    </div>
  );
}

/**
 * A surface around a panel, for requests that name a section and no anchor.
 * The pane carries the marker exactly as both settings surfaces render it;
 * the panel inside is either one built on the shared shell or a bespoke one
 * with no marker of its own, and neither may matter.
 */
function PageHarness(props: {
  readonly section: "general" | "appearance";
  readonly panel: "shell" | "bespoke";
}) {
  useSettingsAnchorReveal(props.section);
  const row = <div data-settings-anchor={ANCHOR}>row</div>;
  return (
    <div data-testid="outer" style={{ overflowY: "auto" }}>
      <div
        data-testid="pane"
        data-settings-panel-pane
        style={{ overflowY: "auto" }}
      >
        {props.panel === "shell" ? (
          <div data-settings-panel-shell>{row}</div>
        ) : (
          <section>{row}</section>
        )}
      </div>
    </div>
  );
}

/** Runs the watcher's `requestAnimationFrame` poll forward one tick. */
function flushFrame(): void {
  act(() => {
    vi.advanceTimersByTime(16);
  });
}

function flashedElement(): Element | null {
  return document.querySelector("[data-settings-anchor-flash]");
}

function scrollSpies(): {
  readonly outer: Mock;
  readonly pane: Mock;
} {
  const outer = vi.fn();
  const pane = vi.fn();
  for (const [testId, spy, scrollHeight] of [
    ["outer", outer, 2000],
    ["pane", pane, 2000],
  ] as const) {
    const element = document.querySelector(`[data-testid="${testId}"]`);
    if (element === null) throw new Error(`no ${testId} in harness`);
    for (const [key, value] of [
      ["scrollTo", spy],
      ["scrollHeight", scrollHeight],
      ["clientHeight", 400],
    ] as const) {
      Object.defineProperty(element, key, { value, configurable: true });
    }
  }
  return { outer, pane };
}

function armReveal(anchor: string): void {
  act(() => {
    useSettingsSearchStore.getState().requestReveal("general", anchor);
  });
}

function pending(): unknown {
  return useSettingsSearchStore.getState().pendingReveal;
}

beforeEach(() => {
  vi.useFakeTimers();
  useSettingsSearchStore.setState({ pendingReveal: null });
  Object.defineProperty(Element.prototype, "checkVisibility", {
    configurable: true,
    value: function checkVisibility(this: Element): boolean {
      return this.closest("[hidden]") === null;
    },
  });
});

afterEach(() => {
  // Explicit, as the sibling suites do: without it the previous test's tree
  // stays in the document and the next `scrollSpies()` finds — and fails to
  // redefine — the old pane.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(Element.prototype, "checkVisibility");
});

describe("useSettingsAnchorReveal", () => {
  it("leaves the mark lit after the request is cleared", () => {
    render(<Harness section="general" />);
    scrollSpies();
    armReveal(ANCHOR);
    flushFrame();

    // The request is spent...
    expect(useSettingsSearchStore.getState().pendingReveal).toBeNull();
    // ...and the mark is still there. This is the regression.
    expect(flashedElement()).not.toBeNull();
  });

  it("scrolls the row's own pane and nothing outside it", () => {
    render(<Harness section="general" />);
    const { outer, pane } = scrollSpies();
    armReveal(ANCHOR);
    flushFrame();

    expect(pane).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("centers the row in its pane", () => {
    render(<Harness section="general" />);
    const { pane } = scrollSpies();
    const paneElement = document.querySelector('[data-testid="pane"]');
    const row = document.querySelector(`[data-settings-anchor="${ANCHOR}"]`);
    if (paneElement === null || row === null) throw new Error("harness");
    // Pane's viewport starts at y=100 and is 400 tall (see scrollSpies); the
    // row is 40 tall and sits 700px below the pane's top edge on screen while
    // the pane is already scrolled by 50. Centering puts the row's middle at
    // the pane's middle: (700 + 50) - (400 - 40) / 2 = 570.
    Object.defineProperty(paneElement, "scrollTop", { value: 50 });
    vi.spyOn(paneElement, "getBoundingClientRect").mockReturnValue(
      rect(100, 400),
    );
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(800, 40));
    armReveal(ANCHOR);
    flushFrame();

    expect(pane).toHaveBeenCalledWith(expect.objectContaining({ top: 570 }));
  });

  it("retires the mark once the flash window passes", () => {
    render(<Harness section="general" />);
    scrollSpies();
    armReveal(ANCHOR);
    flushFrame();
    expect(flashedElement()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(flashedElement()).toBeNull();
  });

  it("clears a request whose anchor never appears, and lights nothing", () => {
    render(<Harness section="general" />);
    scrollSpies();
    armReveal("never-here");
    // Past the 3s deadline, polling a frame at a time.
    for (let tick = 0; tick < 200; tick += 1) flushFrame();

    expect(useSettingsSearchStore.getState().pendingReveal).toBeNull();
    expect(flashedElement()).toBeNull();
  });

  it("re-lights on a second request for the same anchor", () => {
    // What `requestedAt` exists for: clicking the same result twice has to
    // show it again, even though section and anchor are unchanged.
    render(<Harness section="general" />);
    scrollSpies();
    armReveal(ANCHOR);
    flushFrame();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(flashedElement()).toBeNull();

    armReveal(ANCHOR);
    flushFrame();
    expect(flashedElement()).not.toBeNull();
  });

  it("removes the mark when the surface unmounts mid-flash", () => {
    const view = render(<Harness section="general" />);
    scrollSpies();
    armReveal(ANCHOR);
    flushFrame();
    const row = document.querySelector(`[data-settings-anchor="${ANCHOR}"]`);
    expect(row?.hasAttribute("data-settings-anchor-flash")).toBe(true);

    act(() => {
      view.unmount();
    });
    expect(row?.hasAttribute("data-settings-anchor-flash")).toBe(false);
  });

  // A scope gate keeps its content mounted but hidden while the host
  // connects. Found-but-hidden must not spend the request: nothing would be
  // lit, nothing would scroll into view, and the row would then appear with
  // the request already gone.
  it("waits for a concealed row to become visible before revealing it", () => {
    const view = render(<ConcealedHarness concealed />);
    const { pane } = scrollSpies();
    armReveal(ANCHOR);
    for (let tick = 0; tick < 30; tick += 1) flushFrame();

    expect(flashedElement()).toBeNull();
    expect(pane).not.toHaveBeenCalled();
    expect(pending()).not.toBeNull();

    view.rerender(<ConcealedHarness concealed={false} />);
    flushFrame();

    expect(flashedElement()).not.toBeNull();
    expect(pane).toHaveBeenCalledTimes(1);
    expect(pending()).toBeNull();
  });

  // The deadline is the REQUEST's: a watcher that only starts looking later
  // must not grant an old request a fresh window.
  it("drops a request that expired before any watcher mounted", () => {
    armReveal(ANCHOR);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    render(<AnchorHarness anchor={ANCHOR} />);
    scrollSpies();
    flushFrame();

    expect(flashedElement()).toBeNull();
    expect(pending()).toBeNull();
  });

  // Reopened well inside the request's own deadline, so only the close can
  // have retired it.
  it("abandons its request when the surface closes, so a reopen reveals nothing", () => {
    const view = render(<AnchorHarness anchor="elsewhere" />);
    armReveal(ANCHOR);
    flushFrame();
    act(() => {
      view.unmount();
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(pending()).toBeNull();

    render(<AnchorHarness anchor={ANCHOR} />);
    scrollSpies();
    for (let tick = 0; tick < 10; tick += 1) flushFrame();

    expect(flashedElement()).toBeNull();
    expect(pending()).toBeNull();
  });

  // The phone's section list arms the request and THEN navigates into a panel,
  // so the request predates the watcher — and React's development
  // double-mount runs the watcher's unmount cleanup before its real mount.
  it("keeps a request armed before the watcher mounted through a double mount", () => {
    armReveal(ANCHOR);
    render(
      <StrictMode>
        <AnchorHarness anchor={ANCHOR} />
      </StrictMode>,
    );
    // Let the tick a deferred clear would run on pass on its own, before
    // any frame: the double mount must have cancelled it, so the request is
    // still there to be found.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(pending()).not.toBeNull();
    scrollSpies();
    flushFrame();

    expect(flashedElement()).not.toBeNull();
    expect(pending()).toBeNull();
  });

  describe("page results", () => {
    it("scrolls the section's pane to the top and marks nothing", () => {
      render(<PageHarness section="general" panel="shell" />);
      const { pane, outer } = scrollSpies();
      armPageReveal("general");
      flushFrame();

      expect(pane).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
      expect(outer).not.toHaveBeenCalled();
      expect(flashedElement()).toBeNull();
      expect(pending()).toBeNull();
    });

    it("scrolls the pane for a bespoke panel that carries no marker of its own", () => {
      render(<PageHarness section="general" panel="bespoke" />);
      const { pane, outer } = scrollSpies();
      armPageReveal("general");
      flushFrame();

      expect(pane).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
      expect(outer).not.toHaveBeenCalled();
      expect(pending()).toBeNull();
    });

    it("waits for the requested section rather than scrolling the one on screen", () => {
      const view = render(<PageHarness section="general" panel="shell" />);
      const { pane } = scrollSpies();
      armPageReveal("appearance");
      for (let tick = 0; tick < 10; tick += 1) flushFrame();

      expect(pane).not.toHaveBeenCalled();
      expect(pending()).not.toBeNull();

      view.rerender(<PageHarness section="appearance" panel="shell" />);
      flushFrame();

      expect(pane).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
      expect(pending()).toBeNull();
    });
  });
});

function armPageReveal(section: "general" | "appearance"): void {
  act(() => {
    useSettingsSearchStore.getState().requestReveal(section, null);
  });
}

function rect(top: number, height: number): DOMRect {
  return {
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
