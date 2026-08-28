import { act } from "@testing-library/react";
import { onTestFinished, vi } from "vitest";

const VIEWPORT_HEIGHT_PX = 700;
const VIEWPORT_WIDTH_PX = 800;
const ITEM_HEIGHT_PX = 90;
const SPACER_HEIGHT_PX = 40;
const LARGE_CONTENT_ROW_COUNT = 400;
const BROWSER_FRAME_MS = 16;

/**
 * Optional override for the scroll container's `scrollHeight` (not list-item
 * shells). Default is a large constant so virtualization has work to do.
 * Ticket 18 pin B needs a realistic max-scroll so following-end does not park
 * at the inflated 36_000px ceiling (which makes every near send look "far"
 * under the 1.5-viewport animated split). Call with `null` to restore default.
 */
let scrollContainerScrollHeightOverridePx: number | null = null;
let messageRowHeightOverrides = new Map<string, number>();
let syntheticScrollEventsEnabled = true;
let legendListTestClockInstalled = false;

/**
 * Real browsers fire `scroll` (and, where supported, `scrollend`) for
 * PROGRAMMATIC `scrollTo` calls too - jsdom fires neither, which forces
 * LegendList's animated-scroll promise to resolve only via its internal
 * `SCROLL_END_MAX_MS` (1500ms) watchdog and `awaitScrollSettle` to resolve
 * only via its 750ms fallback. The shim below restores the browser contract
 * so settles land within frames instead of watchdog windows. Tests that
 * deliberately exercise the never-fires-natively fallback timing (the
 * op1/op2 stale-callback pin) opt out with `false`; resets after the test.
 */
export function setLegendListSyntheticScrollEventsEnabled(
  enabled: boolean,
): void {
  syntheticScrollEventsEnabled = enabled;
  onTestFinished(() => {
    syntheticScrollEventsEnabled = true;
  });
}

/**
 * Opt-in browser-faithful mode: when true, programmatic `scrollTop` /
 * `scrollTo` writes also dispatch a bubbling native `scroll` event.
 * Default stays false so existing suites that park geometry during setup
 * without wanting `onIsAtEndChange` to run are unaffected. Enable per test
 * via `enableLegendListBrowserScrollEvents()`.
 */
let dispatchBrowserScrollEventsOnProgrammaticScroll = false;
let browserScrollEventDispatchDepth = 0;
const MAX_BROWSER_SCROLL_EVENT_DISPATCH_DEPTH = 16;

export function setLegendListScrollContainerScrollHeightOverride(
  heightPx: number | null,
): void {
  scrollContainerScrollHeightOverridePx = heightPx;
  if (heightPx !== null) {
    onTestFinished(() => {
      scrollContainerScrollHeightOverridePx = null;
    });
  }
}

export function setLegendListMessageRowHeightOverrides(
  heights: ReadonlyMap<string, number>,
): void {
  messageRowHeightOverrides = new Map(heights);
  onTestFinished(() => {
    messageRowHeightOverrides = new Map();
  });
}

/**
 * Makes subsequent `scrollTop` / `scrollTo` writes on HTMLElements fire a
 * browser-like `scroll` event (bubbling). Auto-resets when the current test
 * finishes. Use only when a regression must exercise production's
 * `onScroll` → `onIsAtEndChange` chain after a programmatic restore/land.
 */
export function enableLegendListBrowserScrollEvents(): void {
  dispatchBrowserScrollEventsOnProgrammaticScroll = true;
  onTestFinished(() => {
    dispatchBrowserScrollEventsOnProgrammaticScroll = false;
  });
}

function maybeDispatchBrowserScrollEvent(element: HTMLElement): void {
  if (!dispatchBrowserScrollEventsOnProgrammaticScroll) return;
  if (
    browserScrollEventDispatchDepth >= MAX_BROWSER_SCROLL_EVENT_DISPATCH_DEPTH
  ) {
    return;
  }
  browserScrollEventDispatchDepth += 1;
  try {
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  } finally {
    browserScrollEventDispatchDepth -= 1;
  }
}

function rectOf(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  };
}

function isListItemShell(element: HTMLElement): boolean {
  return (
    element.hasAttribute("data-message-id") ||
    element.hasAttribute("data-index")
  );
}

/**
 * LegendList wraps every row in its own absolutely-positioned container and
 * measures THAT element, so the container has to report its row's height
 * here. A container is only ever a single row's wrapper, so matching on the
 * first element child is exact - the scroll container holds the content
 * container, never a row, and so never matches. Without this, a row's
 * wrapper falls through to the viewport height below and the list's content
 * size (and with it `isAtEnd`) diverges from the DOM it is measuring.
 */
function listItemShellFor(element: HTMLElement): HTMLElement | null {
  if (isListItemShell(element)) return element;
  const child = element.firstElementChild;
  return child instanceof HTMLElement && isListItemShell(child) ? child : null;
}

function isSpacerShell(element: HTMLElement): boolean {
  if (element.getAttribute("aria-hidden") === "true") {
    return true;
  }
  const child = element.firstElementChild;
  return (
    child instanceof HTMLElement && child.getAttribute("aria-hidden") === "true"
  );
}

function heightFor(element: HTMLElement): number {
  const itemShell = listItemShellFor(element);
  if (itemShell !== null) {
    const ownMessageId = itemShell.getAttribute("data-message-id");
    const nestedMessageId = itemShell
      .querySelector<HTMLElement>("[data-message-id]")
      ?.getAttribute("data-message-id");
    const messageId = ownMessageId ?? nestedMessageId;
    if (typeof messageId === "string") {
      const override = messageRowHeightOverrides.get(messageId);
      if (override !== undefined) return override;
    }
    return ITEM_HEIGHT_PX;
  }
  if (isSpacerShell(element)) {
    return SPACER_HEIGHT_PX;
  }
  return VIEWPORT_HEIGHT_PX;
}

/**
 * jsdom reports zero-size boxes and a non-sticky scrollTop, so LegendList's
 * layout + `initialScrollAtEnd` bootstrap never settle. Give the scroller a
 * real viewport, stick scroll offsets, measure virtualized rows at the
 * estimated item height, and measure header/footer spacers realistically (a
 * 700px footer breaks bottom-aligned bootstrap in jsdom). Shared between
 * `chat-timeline.test.tsx` and any other suite that mounts a real (unmocked)
 * `@legendapp/list` instance - the old message-list library's testing
 * context had no LegendList equivalent, so this replaces it.
 */
export function installLegendListViewportMetrics(): void {
  const scrollTopByElement = new WeakMap<HTMLElement, number>();
  const scrollLeftByElement = new WeakMap<HTMLElement, number>();

  const getBoundingClientRectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return rectOf(0, 0, VIEWPORT_WIDTH_PX, heightFor(this));
    });

  const clientHeightSpy = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return heightFor(this);
    });
  const clientWidthSpy = vi
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockImplementation(function () {
      return VIEWPORT_WIDTH_PX;
    });
  const offsetHeightSpy = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return heightFor(this);
    });
  const offsetWidthSpy = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockImplementation(function () {
      return VIEWPORT_WIDTH_PX;
    });
  const scrollHeightSpy = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      if (listItemShellFor(this) !== null || isSpacerShell(this)) {
        return heightFor(this);
      }
      if (scrollContainerScrollHeightOverridePx !== null) {
        return scrollContainerScrollHeightOverridePx;
      }
      // Large enough that virtualization has work to do.
      return LARGE_CONTENT_ROW_COUNT * ITEM_HEIGHT_PX;
    });
  const scrollWidthSpy = vi
    .spyOn(HTMLElement.prototype, "scrollWidth", "get")
    .mockImplementation(function () {
      return VIEWPORT_WIDTH_PX;
    });

  // jsdom's scrollTop setter is a no-op; LegendList's initialScrollAtEnd
  // bootstrap only converges when native scroll offsets stick.
  const scrollTopGetSpy = vi
    .spyOn(HTMLElement.prototype, "scrollTop", "get")
    .mockImplementation(function (this: HTMLElement) {
      return scrollTopByElement.get(this) ?? 0;
    });
  const scrollTopSetSpy = vi
    .spyOn(HTMLElement.prototype, "scrollTop", "set")
    .mockImplementation(function (this: HTMLElement, value: number) {
      const previous = scrollTopByElement.get(this) ?? 0;
      scrollTopByElement.set(this, value);
      // Mirror browsers: only fire when the stored offset actually changed.
      // The comparison suppresses same-offset re-entrant writes; divergent
      // writers are bounded by maybeDispatchBrowserScrollEvent's depth guard.
      if (previous !== value) {
        maybeDispatchBrowserScrollEvent(this);
      }
    });
  const scrollLeftGetSpy = vi
    .spyOn(HTMLElement.prototype, "scrollLeft", "get")
    .mockImplementation(function (this: HTMLElement) {
      return scrollLeftByElement.get(this) ?? 0;
    });
  const scrollLeftSetSpy = vi
    .spyOn(HTMLElement.prototype, "scrollLeft", "set")
    .mockImplementation(function (this: HTMLElement, value: number) {
      scrollLeftByElement.set(this, value);
    });

  // jsdom does not define HTMLElement.scrollTo. Seed a configurable no-op so
  // Vitest can spy on it, then remove that seed after restoreAllMocks puts it
  // back; the prototype leaves each test exactly as it entered.
  const seededScrollTo = !Object.hasOwn(HTMLElement.prototype, "scrollTo");
  if (seededScrollTo) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
    onTestFinished(() => {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    });
  }

  // LegendList feature-detects scrollend support via `"onscrollend" in
  // target` before listening for it; jsdom has no such property. Seed it so
  // the library's target-aware scrollend finish (near-target check included)
  // races ahead of its idle/max timers instead of never being registered.
  const seededOnScrollEnd = !("onscrollend" in HTMLElement.prototype);
  if (seededOnScrollEnd) {
    Object.defineProperty(HTMLElement.prototype, "onscrollend", {
      configurable: true,
      writable: true,
      value: null,
    });
    onTestFinished(() => {
      Reflect.deleteProperty(HTMLElement.prototype, "onscrollend");
    });
  }
  // Browser contract (partially) restored for programmatic scrolls (see
  // `setLegendListSyntheticScrollEventsEnabled`): a real browser fires
  // `scrollend` once a `scrollTo` it issued itself stops moving. Dispatch it
  // in a later animation frame so listeners registered synchronously after
  // the `scrollTo` call still catch it. The shared browser clock advances
  // these frames and LegendList's timers together.
  //
  // Deliberately NO synthetic `scroll` event: ticket 19's capture-phase
  // classifier and the scroll-only reader-departure detection both key off
  // `scroll`, and a frame-delayed dispatch can land after the library's
  // ownership window has closed - reading as an OS-scrollbar-drag departure
  // and yanking anchors into free-scrolling (58 tests go red). Tests that
  // need the classifier to observe a write keep firing `scroll` explicitly
  // (`fireCaptureScrollAfterLibraryWrite` and friends), exactly as before.
  //
  // Timing: the dispatch waits ~10 frames (~160ms at jsdom's 16ms rAF
  // cadence), NOT one. LegendList finishes a NON-animated scroll through its
  // own 100ms `finishScrollTo` timer, which is what reconciles internal
  // scroll state (`isAtEnd` etc.) with the DOM; a scrollend that wakes
  // `awaitScrollSettle` before that timer lets `validate` read stale state
  // (the retry-exhaustion test settles "valid" off a pre-reconcile
  // `isAtEnd`). Frames preserve the browser's paint-order relationship
  // between the library reconciliation and the later `scrollend` event.
  const dispatchSyntheticScrollEnd = (target: HTMLElement): void => {
    if (!syntheticScrollEventsEnabled) return;
    let remainingFrames = 10;
    const tick = (): void => {
      remainingFrames -= 1;
      if (remainingFrames <= 0) {
        target.dispatchEvent(new Event("scrollend"));
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const scrollToSpy = vi
    .spyOn(HTMLElement.prototype, "scrollTo")
    .mockImplementation(function scrollToShim(
      this: HTMLElement,
      ...args: Array<number | ScrollToOptions | undefined>
    ): void {
      const first = args[0];
      if (typeof first === "number") {
        const second = args[1];
        this.scrollLeft = first;
        // Assigning scrollTop goes through the setter above, which optionally
        // dispatches a browser-like scroll event under the opt-in flag.
        this.scrollTop = typeof second === "number" ? second : 0;
        dispatchSyntheticScrollEnd(this);
        return;
      }
      if (typeof first === "object") {
        if (typeof first.left === "number") {
          this.scrollLeft = first.left;
        }
        if (typeof first.top === "number") {
          this.scrollTop = first.top;
        }
        dispatchSyntheticScrollEnd(this);
      }
    });

  onTestFinished(() => {
    scrollToSpy.mockRestore();
    scrollLeftSetSpy.mockRestore();
    scrollLeftGetSpy.mockRestore();
    scrollTopSetSpy.mockRestore();
    scrollTopGetSpy.mockRestore();
    scrollWidthSpy.mockRestore();
    scrollHeightSpy.mockRestore();
    offsetWidthSpy.mockRestore();
    offsetHeightSpy.mockRestore();
    clientWidthSpy.mockRestore();
    clientHeightSpy.mockRestore();
    getBoundingClientRectSpy.mockRestore();
    if (seededScrollTo) {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
  });
}

/**
 * Own the nondeterministic browser clock at the test boundary while leaving
 * the real LegendList implementation mounted. This virtualizes only browser
 * scheduling primitives used by the list and ChatMessages; React, DOM layout
 * shims, observers, list measurement, and scroll event handling stay
 * integrated.
 */
export function installLegendListTestClock(): void {
  if (legendListTestClockInstalled) {
    restoreLegendListTestClock();
  }

  // DOM Testing Library only recognizes fake timers when a Jest-compatible
  // clock is present. Vitest uses the same Sinon clock but does not expose the
  // `jest` facade, so bridge the one method waitFor needs. Without this,
  // waitFor installs a fake interval and then waits forever for real time.
  const originalJestDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "jest",
  );
  Object.defineProperty(globalThis, "jest", {
    configurable: true,
    writable: true,
    value: {
      advanceTimersByTime: (milliseconds: number): void => {
        vi.advanceTimersByTime(milliseconds);
      },
    },
  });
  onTestFinished(() => {
    if (originalJestDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "jest");
      return;
    }
    Object.defineProperty(globalThis, "jest", originalJestDescriptor);
  });

  vi.useFakeTimers({
    toFake: [
      "Date",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  legendListTestClockInstalled = true;

  // Keep the fake browser scheduler test-scoped even when another teardown
  // hook throws before it reaches its normal restoration path. Vitest reuses
  // forks between files, so leaking it would contaminate an unrelated suite.
  onTestFinished(() => {
    restoreLegendListTestClock();
  });
}

/** Discard scheduled work from the unmounted list and restore wall time. */
export function restoreLegendListTestClock(): void {
  if (!legendListTestClockInstalled) return;
  vi.clearAllTimers();
  vi.useRealTimers();
  legendListTestClockInstalled = false;
}

/** Advance browser time inside React's update boundary. */
export async function advanceLegendListTime(
  milliseconds: number,
): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

/**
 * Advance frame-by-frame so work scheduled by one render/effect participates
 * in the next frame exactly as it does in a browser.
 */
export async function advanceLegendListFrames(
  frameCount: number,
): Promise<void> {
  for (let frame = 0; frame < frameCount; frame += 1) {
    await advanceLegendListTime(BROWSER_FRAME_MS);
  }
}

/**
 * LegendList's `initialScrollAtEnd` bootstrap and layout measurement need 12
 * frames in jsdom. That window also crosses the installed library's 100ms
 * non-animated `finishScrollTo` deadline and the synthetic `scrollend` fired
 * on frame 10. Virtual time makes the contract deterministic without replacing
 * LegendList or sleeping on the runner's wall clock.
 */
export async function settleLegendList(): Promise<void> {
  // The base branch's split ChatMessages suites install the virtual browser
  // clock above. This branch replaces those suites with one consolidated
  // integration suite whose race coverage intentionally keeps the real
  // scheduler. Preserve both contracts: virtualize callers that opt in, and
  // retain the prior browser-like settle for callers that do not.
  if (!legendListTestClockInstalled) {
    await act(async () => {
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 80);
      });
    });
    return;
  }

  await advanceLegendListFrames(12);
}
