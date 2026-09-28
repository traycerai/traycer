import { createElement, useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runLayoutEditorMotion,
  setLayoutInspectorNode,
} from "@/lib/layout/editor-motion";
import {
  installFakeViewTransitions,
  type FakeViewTransition,
} from "@/lib/layout/test-support/fake-view-transition";
import { registerTileRect } from "@/lib/browser-view/tiles/tile-rect-registry";
import type { LayoutDockMode } from "@/stores/layout/layout-editor-store";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";

/**
 * The L-30 guards and what carries the editor in and out (5.2).
 *
 * jsdom implements neither `startViewTransition` nor `getAnimations`, which is
 * the production fallback's own condition, so both are installed explicitly
 * here: a suite that never installs them can only ever observe one of the two
 * paths and would pass whatever the guard decided.
 */

const TILE_KEY: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

let transitions: Array<FakeViewTransition> = [];
let uninstallViewTransitions: () => void = () => undefined;
let deregisterTile: (() => void) | null = null;
let originalMatchMedia: typeof window.matchMedia;

function setPrefersReducedMotion(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      ...originalMatchMedia(query),
      matches,
    }),
  });
}

function presentNativeTile(): void {
  const surface = document.createElement("div");
  surface.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 600,
    bottom: 400,
    width: 600,
    height: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  deregisterTile = registerTileRect(TILE_KEY, surface);
}

/** The panel as the shell's ref callback hands it to the module. */
function mountInspector(): HTMLElement {
  const inspector = document.createElement("div");
  inspector.setAttribute("data-layout-inspector", "");
  document.body.append(inspector);
  setLayoutInspectorNode(inspector);
  return inspector;
}

/** One pending CSS animation on the element, finished when the test says so. */
function stubExitAnimation(element: HTMLElement): { finish: () => void } {
  let settle: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  Object.defineProperty(element, "getAnimations", {
    configurable: true,
    writable: true,
    value: () => [{ finished }],
  });
  return { finish: settle };
}

function enter(dockMode: LayoutDockMode, apply: () => void): void {
  runLayoutEditorMotion({ phase: "enter", entry: "pointer", dockMode, apply });
}

/** The transition the call under test started, or a failure saying it did not. */
function startedTransition(): FakeViewTransition {
  const transition = transitions.at(0);
  if (transition === undefined) throw new Error("no view transition started");
  return transition;
}

/** A macrotask tick, which drains every pending microtask chain. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  originalMatchMedia = window.matchMedia.bind(window);
  const installed = installFakeViewTransitions();
  transitions = installed.transitions;
  uninstallViewTransitions = installed.uninstall;
});

afterEach(() => {
  deregisterTile?.();
  deregisterTile = null;
  setLayoutInspectorNode(null);
  uninstallViewTransitions();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  document.documentElement.removeAttribute("data-reduce-panel-motion");
  document.documentElement.removeAttribute("data-layout-transition");
  document.body.replaceChildren();
});

describe("the L-30 guard matrix (5.2)", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly dockMode: LayoutDockMode;
    readonly entry: "pointer" | "keyboard";
    readonly arrange: () => void;
    readonly transitions: boolean;
  }> = [
    {
      name: "a pointer gesture on a side dock with nothing in the way",
      dockMode: "right",
      entry: "pointer",
      arrange: () => undefined,
      transitions: true,
    },
    {
      name: "a left dock, which is the same case mirrored",
      dockMode: "left",
      entry: "pointer",
      arrange: () => undefined,
      transitions: true,
    },
    {
      name: "keyboard entry",
      dockMode: "right",
      entry: "keyboard",
      arrange: () => undefined,
      transitions: false,
    },
    {
      name: "a presented native browser tile",
      dockMode: "right",
      entry: "pointer",
      arrange: presentNativeTile,
      transitions: false,
    },
    {
      name: "the OS reduced-motion preference",
      dockMode: "right",
      entry: "pointer",
      arrange: () => {
        setPrefersReducedMotion(true);
      },
      transitions: false,
    },
    {
      name: "the app's own Panel animations switch",
      dockMode: "right",
      entry: "pointer",
      arrange: () => {
        document.documentElement.setAttribute("data-reduce-panel-motion", "");
      },
      transitions: false,
    },
    {
      name: "a floating inspector, which reflows no shell to glide",
      dockMode: "float",
      entry: "pointer",
      arrange: () => undefined,
      transitions: false,
    },
    {
      name: "a browser with no View Transition API",
      dockMode: "right",
      entry: "pointer",
      arrange: () => {
        Reflect.deleteProperty(document, "startViewTransition");
      },
      transitions: false,
    },
  ];

  it.each(cases)("$name", (testCase) => {
    testCase.arrange();
    const apply = vi.fn();

    runLayoutEditorMotion({
      phase: "enter",
      entry: testCase.entry,
      dockMode: testCase.dockMode,
      apply,
    });

    const started = transitions.at(0);
    expect(started !== undefined).toBe(testCase.transitions);
    // Whichever path ran, the session change happened exactly once: a guard
    // changes the motion and never the outcome.
    started?.runUpdate();
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe("the named groups (5.2)", () => {
  it("names them for the transition and takes the names off again", async () => {
    enter("right", () => undefined);

    expect(
      document.documentElement.getAttribute("data-layout-transition"),
    ).toBe("enter right");

    startedTransition().finish();
    await tick();

    expect(
      document.documentElement.hasAttribute("data-layout-transition"),
    ).toBe(false);
  });

  it("carries the phase and the dock side, which is how the pseudo-elements learn them (L-66)", () => {
    enter("left", () => undefined);

    expect(
      document.documentElement.getAttribute("data-layout-transition"),
    ).toBe("enter left");

    runLayoutEditorMotion({
      phase: "exit",
      entry: "pointer",
      dockMode: "left",
      apply: () => undefined,
    });

    // The exit's shell snapshot grows where the entry's shrinks, so the
    // stylesheet has to be able to tell them apart.
    expect(
      document.documentElement.getAttribute("data-layout-transition"),
    ).toBe("exit left");
  });

  it("marks the arrived panel so its own slide never replays (G2-01)", async () => {
    const inspector = mountInspector();
    enter("right", () => undefined);

    // Stamped INSIDE the update callback, before the new state is captured, so
    // the snapshot is the panel at rest.
    expect(inspector.hasAttribute("data-entered")).toBe(false);
    startedTransition().runUpdate();
    expect(inspector.getAttribute("data-entered")).toBe("1");

    startedTransition().finish();
    await tick();

    // And it outlives the transition: the mark, not the running transition, is
    // what keeps the panel's `layout-inspector-in` from starting once the
    // names come off.
    expect(inspector.getAttribute("data-entered")).toBe("1");
  });

  it("keeps them while a second transition that replaced the first is running", async () => {
    enter("right", () => undefined);
    // Leaving again inside the entry's own 220ms. The browser skips the first
    // transition, so its settlement arrives while the second is still going.
    runLayoutEditorMotion({
      phase: "exit",
      entry: "pointer",
      dockMode: "right",
      apply: () => undefined,
    });

    transitions.at(0)?.finish();
    await tick();

    expect(
      document.documentElement.hasAttribute("data-layout-transition"),
    ).toBe(true);

    transitions.at(1)?.finish();
    await tick();

    expect(
      document.documentElement.hasAttribute("data-layout-transition"),
    ).toBe(false);
  });

  it("un-names them when finished rejects (the update callback threw)", async () => {
    enter("right", () => undefined);
    startedTransition().reject();
    await tick();

    expect(
      document.documentElement.hasAttribute("data-layout-transition"),
    ).toBe(false);
  });
});

describe("the fallback exit (5.2)", () => {
  it("holds the session open until the inspector has slid out", async () => {
    const inspector = mountInspector();
    const animation = stubExitAnimation(inspector);
    const apply = vi.fn();

    runLayoutEditorMotion({
      phase: "exit",
      entry: "keyboard",
      dockMode: "right",
      apply,
    });

    expect(inspector.getAttribute("data-exiting")).toBe("1");
    expect(apply).not.toHaveBeenCalled();

    animation.finish();
    await tick();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(inspector.hasAttribute("data-exiting")).toBe(false);
  });

  it("ends the session in the same frame when there is no animation to wait for", () => {
    const inspector = mountInspector();
    Object.defineProperty(inspector, "getAnimations", {
      configurable: true,
      writable: true,
      value: () => [],
    });
    const apply = vi.fn();

    runLayoutEditorMotion({
      phase: "exit",
      entry: "keyboard",
      dockMode: "right",
      apply,
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(inspector.hasAttribute("data-exiting")).toBe(false);
  });

  it("ends the session when there is no inspector to animate", () => {
    const apply = vi.fn();

    runLayoutEditorMotion({
      phase: "exit",
      entry: "keyboard",
      dockMode: "right",
      apply,
    });

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("does not hold an ENTRY back for anything", () => {
    // A re-open inside the previous session's slide-out (G3-05): the panel is
    // still wearing the exit attribute and its exit animation is still pending.
    const inspector = mountInspector();
    stubExitAnimation(inspector);
    inspector.setAttribute("data-exiting", "1");
    const apply = vi.fn();

    runLayoutEditorMotion({
      phase: "enter",
      entry: "keyboard",
      dockMode: "right",
      apply,
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(inspector.hasAttribute("data-exiting")).toBe(false);
  });
});

/**
 * R2-05. `apply` begins the session, and `beginSession` fires
 * `useLayoutRegion`'s store subscription synchronously - so what React has
 * COMMITTED at that moment decides which surface's instances register. On the
 * transition path that is settled for free, because the callback runs a frame
 * after the door's own work. On the fallback path it is not, and the session
 * used to begin against the outgoing tab's last committed render.
 *
 * What is observed here is a pending commit rather than a region registry: a
 * render scheduled before the call, and whether the DOM shows it by the time
 * `apply` runs. That is the fact the door depends on, and it is true of the
 * tab activation without this suite having to stand one up.
 */
describe("the commit the fallback entry begins in (R2-05)", () => {
  interface PendingRender {
    readonly container: HTMLElement;
    /** Schedules a render React has NOT committed when this returns. */
    readonly schedule: (text: string) => void;
    readonly unmount: () => void;
  }

  function mountPendingRender(): PendingRender {
    let text = "outgoing";
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    const read = (): string => text;
    function Pane(): ReactNode {
      return useSyncExternalStore(subscribe, read);
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    flushSync(() => {
      root.render(createElement(Pane));
    });
    return {
      container,
      schedule: (next: string) => {
        text = next;
        for (const listener of listeners) listener();
      },
      unmount: () => {
        flushSync(() => {
          root.unmount();
        });
        container.remove();
      },
    };
  }

  /**
   * React warns about updates made outside `act` when the flag is on, and an
   * update this test needs to leave PENDING is exactly what `act` would flush.
   */
  let previousActFlag: unknown = undefined;

  beforeEach(() => {
    previousActFlag = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  afterEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActFlag);
  });

  it("lands the work the door already scheduled before apply runs", () => {
    const pending = mountPendingRender();
    pending.schedule("sample");
    // The premise: without this the test could pass on a render that had
    // already committed, which is not the case the fix is about.
    expect(pending.container.textContent).toBe("outgoing");

    let seenByApply: string | null = null;
    runLayoutEditorMotion({
      phase: "enter",
      entry: "keyboard",
      dockMode: "right",
      apply: () => {
        seenByApply = pending.container.textContent;
      },
    });

    expect(seenByApply).toBe("sample");
    pending.unmount();
  });

  it("leaves the transition path's old snapshot alone", () => {
    // The transition captures the OLD state when it starts, and the app
    // column's snapshot is the tab content: flushing here would swap the tab
    // abruptly before the picture the transition is about to glide.
    const pending = mountPendingRender();
    pending.schedule("sample");

    enter("right", () => undefined);

    expect(pending.container.textContent).toBe("outgoing");
    startedTransition().runUpdate();
    pending.unmount();
  });
});
