import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { setMobileApp, setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  isMobileViewport,
  useIsMobileViewport,
} from "@/hooks/ui/use-mobile-viewport";

/**
 * The hook answers a POLICY first and a width second, and both halves have a
 * defect behind them.
 *
 * The shim here is deliberately able to LIE: `matches` and `innerWidth` are
 * set independently, because the stale-rotation defect lives exactly in the
 * window where a WKWebView reports the two out of step. A shim that kept them
 * consistent could not fail the fixed hook or the broken one.
 */
interface FakeViewport {
  /** What the media query says right now - the value `change` fires with. */
  matches: boolean;
  /** What `window.innerWidth` says right now, settled or not. */
  innerWidth: number;
}

const MOBILE_BREAKPOINT = 768;
const NARROW_WIDTH = MOBILE_BREAKPOINT - 100;
const WIDE_WIDTH = MOBILE_BREAKPOINT + 256;

const viewport: FakeViewport = { matches: false, innerWidth: WIDE_WIDTH };
const changeListeners = new Set<() => void>();

function setInnerWidth(width: number): void {
  viewport.innerWidth = width;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

/** The media query flipping, on its own - dimensions untouched. */
function fireMediaQueryChange(matches: boolean): void {
  viewport.matches = matches;
  act(() => {
    for (const listener of [...changeListeners]) listener();
  });
}

/** The dimensions settling, on their own - no second `change` event. */
function fireResize(width: number): void {
  act(() => {
    setInnerWidth(width);
    window.dispatchEvent(new Event("resize"));
  });
}

function Probe() {
  const mobile = useIsMobileViewport();
  return <span data-testid="shell">{mobile ? "phone" : "desktop"}</span>;
}

function shell(): string {
  return screen.getByTestId("shell").textContent;
}

const originalMatchMedia = window.matchMedia.bind(window);
const originalInnerWidth = window.innerWidth;

beforeEach(() => {
  changeListeners.clear();
  viewport.matches = false;
  setInnerWidth(WIDE_WIDTH);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches(): boolean {
        // Only the breakpoint this hook asks about is faked; anything else
        // keeps the shared shim's answer.
        return query === `(width < ${String(MOBILE_BREAKPOINT)}px)`
          ? viewport.matches
          : originalMatchMedia(query).matches;
      },
      media: query,
      onchange: null,
      addEventListener: (type: string, listener: () => void) => {
        if (type === "change") changeListeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === "change") changeListeners.delete(listener);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  cleanup();
  // Module-level and process-lifetime in the real app, so nothing else resets
  // them - and left true the policy flag would make every width case below
  // pass vacuously.
  setMobileApp(false);
  setPhoneLayoutOnly(false);
  changeListeners.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  setInnerWidth(originalInnerWidth);
});

/**
 * A phone-layout-only bundle has no other layout to offer, so the flag SHORT-
 * CIRCUITS the query rather than being weighed against it.
 *
 * A tablet is the case that decides it, and the width below is chosen to be
 * that case: iPad portrait sits comfortably on the desktop side of the
 * breakpoint, which is exactly why the app used to mount the desktop shell
 * there. The query is left telling the truth throughout - a test that also
 * nudged the shim would pass whether or not the short-circuit existed.
 */
describe("in a phone-layout-only bundle", () => {
  it("is the phone layout at a width the query calls desktop", () => {
    setPhoneLayoutOnly(true);

    render(<Probe />);

    expect(shell()).toBe("phone");
    expect(viewport.matches).toBe(false);
    expect(window.innerWidth).toBe(WIDE_WIDTH);
  });

  it("cannot be moved off it by a resize", () => {
    // No rotation reaches this in the shipped app - iOS is portrait-locked on
    // iPad too - but a WKWebView still resizes for the keyboard and for the
    // status-bar height, and neither may swap the shell.
    setPhoneLayoutOnly(true);
    render(<Probe />);

    fireResize(WIDE_WIDTH + 400);

    expect(shell()).toBe("phone");
  });

  it("answers the same imperatively, so the palette cannot diverge", () => {
    setPhoneLayoutOnly(true);

    expect(isMobileViewport()).toBe(true);
  });

  /**
   * THE SEPARATION, and the bug that earned it.
   *
   * These two flags are not synonyms and the hook reads only the first. The
   * mobile bundle is served to a plain browser tab as well as to Capacitor -
   * the internal launcher's `gui-app` dev stream - where the native flag is
   * false and the phone stylesheet is loaded anyway. Keying layout off the
   * native flag would leave that tab picking desktop in JS against phone CSS,
   * where `hidden md:block` computes to `display: none` and takes real
   * controls off the page.
   */
  it("is not the installed-app flag: that one alone decides no layout", () => {
    setMobileApp(true);

    render(<Probe />);

    expect(shell()).toBe("desktop");
    expect(isMobileViewport()).toBe(false);
  });

  it("is not conditional on being native, so the dev browser agrees with its CSS", () => {
    // The mobile entry sets this unconditionally; only the product flag is
    // gated on the runtime. Both halves of that pairing are asserted here
    // because either one drifting reopens the defect above.
    setPhoneLayoutOnly(true);
    setMobileApp(false);

    render(<Probe />);

    expect(shell()).toBe("phone");
  });
});

/**
 * The width half, which the installed app never reaches but every browser and
 * Electron window does.
 */
describe("useIsMobileViewport on a width-driven surface", () => {
  it("reads the breakpoint the window opened at", () => {
    render(<Probe />);

    expect(shell()).toBe("desktop");
  });

  // THE WEDGE. A window narrowing past the breakpoint, query first. The old
  // hook answered `innerWidth < MOBILE_BREAKPOINT` here, read the stale wide
  // value, and cached "desktop" for a narrow window.
  it("follows the media query when the rotation has not settled the width yet", () => {
    render(<Probe />);
    expect(shell()).toBe("desktop");

    fireMediaQueryChange(true);

    expect(shell()).toBe("phone");
    // The lie is still in place: this is the fix, not the shim being tidy.
    expect(window.innerWidth).toBe(WIDE_WIDTH);
  });

  it("stays on the query's answer once the width catches up", () => {
    render(<Probe />);
    fireMediaQueryChange(true);
    expect(shell()).toBe("phone");

    // No second `change` - the query already flipped. This is the event the
    // old hook had no subscription for at all.
    fireResize(NARROW_WIDTH);

    expect(shell()).toBe("phone");
  });

  it("does not wedge in the desktop shell across a full there-and-back", () => {
    viewport.matches = true;
    setInnerWidth(NARROW_WIDTH);
    render(<Probe />);
    expect(shell()).toBe("phone");

    fireMediaQueryChange(false);
    fireResize(WIDE_WIDTH);
    expect(shell()).toBe("desktop");

    // And back to narrow, the leg that used to stick.
    fireMediaQueryChange(true);
    fireResize(NARROW_WIDTH);
    expect(shell()).toBe("phone");
  });

  // The self-heal. If the `change` event is missed or coalesced, the resize
  // that accompanies it still has to land the right shell rather than leaving
  // the app waiting for an unrelated render.
  it("recovers from a missed change event on a plain resize", () => {
    render(<Probe />);

    viewport.matches = true;
    fireResize(NARROW_WIDTH);

    expect(shell()).toBe("phone");
  });

  it("unsubscribes from the window events it added", () => {
    const { unmount } = render(<Probe />);

    unmount();
    viewport.matches = true;
    // No `act` warning and no state update on an unmounted tree: if the
    // listeners survived, React would complain here.
    window.dispatchEvent(new Event("resize"));

    expect(changeListeners.size).toBe(0);
  });
});
