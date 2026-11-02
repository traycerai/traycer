import { act, cleanup, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KEYBOARD_FOCUS_OWNER_PROPS,
  useKeyboardFocusLayoutWithin,
  useShortKeyboardViewport,
} from "@/hooks/ui/use-keyboard-focus-layout";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  IPAD_PRO_11,
  IPHONE_17,
  IPHONE_DUO_OPEN,
  IPHONE_PRO_MAX,
  lowerNativeKeyboard,
  raiseNativeKeyboard,
  restoreKeyboardEnvironment,
  setLayoutViewportHeight,
} from "../../../../__tests__/short-keyboard-viewport-harness";
import { setNativeKeyboardState } from "@/lib/native-keyboard";

class FakeVisualViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
}

function installVisualViewport(viewport: FakeVisualViewport | null): void {
  Object.defineProperty(window, "visualViewport", {
    value: viewport,
    configurable: true,
  });
}

function setScreenOrientation(type: OrientationType): void {
  Object.defineProperty(window.screen, "orientation", {
    configurable: true,
    value: {
      type,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
}

const originalInnerWidth = window.innerWidth;

beforeEach(() => {
  setPhoneLayoutOnly(true);
  // Wider than the phone-portrait limit, the screen on its side.
  window.innerWidth = 1000;
  setScreenOrientation("landscape-primary");
});

afterEach(() => {
  cleanup();
  setPhoneLayoutOnly(false);
  window.innerWidth = originalInnerWidth;
  Reflect.deleteProperty(window.screen, "orientation");
  installVisualViewport(null);
  restoreKeyboardEnvironment();
});

function ShortProbe() {
  return <output>{String(useShortKeyboardViewport())}</output>;
}

function isShort(): boolean {
  return screen.getByRole("status").textContent === "true";
}

describe("useShortKeyboardViewport", () => {
  it.each([
    ["iPhone 17", IPHONE_17],
    ["iPhone 17 Pro Max", IPHONE_PRO_MAX],
    ["iPhone Duo open", IPHONE_DUO_OPEN],
    ["iPad Pro 11", IPAD_PRO_11],
  ])(
    "is short on the %s, from the window less its top inset and the keyboard",
    (_name, viewport) => {
      raiseNativeKeyboard(viewport);
      render(<ShortProbe />);
      expect(isShort()).toBe(true);
    },
  );

  it("takes the top inset off: 406 above the keyboard is short under a 32 status bar, not without one", () => {
    raiseNativeKeyboard({ ...IPAD_PRO_11, top: 0 });
    render(<ShortProbe />);
    expect(isShort()).toBe(false);

    act(() => {
      document.documentElement.style.setProperty(
        "--safe-area-inset-top",
        "32px",
      );
      window.dispatchEvent(new Event("resize"));
    });
    expect(isShort()).toBe(true);
  });

  it("is never short while the keyboard is closed", () => {
    // The inset variable alone, with the plugin saying closed, is not a keyboard.
    setLayoutViewportHeight(IPHONE_17.height);
    document.documentElement.style.setProperty("--keyboard-inset", "208px");
    render(<ShortProbe />);
    expect(isShort()).toBe(false);
  });

  it("follows the keyboard going up and down", () => {
    render(<ShortProbe />);
    expect(isShort()).toBe(false);
    raiseNativeKeyboard(IPHONE_17);
    expect(isShort()).toBe(true);
    lowerNativeKeyboard();
    expect(isShort()).toBe(false);
  });

  it("is not short on a phone held upright, however little height is left", () => {
    setScreenOrientation("portrait-primary");
    window.innerWidth = 400;
    raiseNativeKeyboard({ height: 800, top: 0, inset: 500 });
    render(<ShortProbe />);
    expect(isShort()).toBe(false);
  });

  it("is not short outside the phone shell", () => {
    setPhoneLayoutOnly(false);
    window.innerWidth = 1280;
    raiseNativeKeyboard(IPHONE_17);
    render(<ShortProbe />);
    expect(isShort()).toBe(false);
  });

  describe("on Android, which resizes the window and writes no inset", () => {
    it("reads the window's own height", () => {
      setLayoutViewportHeight(360);
      act(() => {
        setNativeKeyboardState({ open: true, transitioning: false });
      });
      render(<ShortProbe />);
      expect(isShort()).toBe(true);
    });

    it("keeps a tall window's layout", () => {
      setLayoutViewportHeight(800);
      act(() => {
        setNativeKeyboardState({ open: true, transitioning: false });
      });
      render(<ShortProbe />);
      expect(isShort()).toBe(false);
    });

    it("re-reads when the window resizes under the open keyboard", () => {
      setLayoutViewportHeight(800);
      act(() => {
        setNativeKeyboardState({ open: true, transitioning: false });
      });
      render(<ShortProbe />);
      expect(isShort()).toBe(false);

      act(() => {
        setLayoutViewportHeight(360);
        window.dispatchEvent(new Event("resize"));
      });
      expect(isShort()).toBe(true);
    });
  });

  describe("in a mobile browser, where the visual viewport is the evidence", () => {
    it("measures the covered strip with the native state closed", () => {
      setLayoutViewportHeight(600);
      const viewport = new FakeVisualViewport();
      viewport.height = 600;
      installVisualViewport(viewport);
      render(<ShortProbe />);
      expect(isShort()).toBe(false);

      act(() => {
        viewport.height = 300;
        viewport.dispatchEvent(new Event("resize"));
      });
      expect(isShort()).toBe(true);

      act(() => {
        viewport.height = 600;
        viewport.dispatchEvent(new Event("resize"));
      });
      expect(isShort()).toBe(false);
    });
  });
});

/** A scope that tells whether the focus layout serves something inside it. */
function Scope(props: { readonly name: string; readonly children: ReactNode }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const within = useKeyboardFocusLayoutWithin(element);
  return (
    <section ref={setElement} data-testid={props.name} data-within={within}>
      {props.children}
    </section>
  );
}

function Owners() {
  return (
    <>
      <Scope name="reply">
        <div {...KEYBOARD_FOCUS_OWNER_PROPS}>
          <textarea aria-label="Reply" />
          <button type="button">Send</button>
        </div>
      </Scope>
      <Scope name="sibling">
        <div {...KEYBOARD_FOCUS_OWNER_PROPS}>
          <textarea aria-label="Sibling" />
        </div>
      </Scope>
      <input aria-label="Title" />
    </>
  );
}

function within(name: string): boolean {
  return screen.getByTestId(name).getAttribute("data-within") === "true";
}

function focus(label: string): void {
  act(() => {
    screen.getByLabelText(label).focus();
  });
}

describe("useKeyboardFocusLayoutWithin", () => {
  beforeEach(() => {
    raiseNativeKeyboard(IPHONE_17);
    render(<Owners />);
  });

  it("serves the scope holding the focused entry and no sibling", () => {
    expect(within("reply")).toBe(false);
    focus("Reply");
    expect(within("reply")).toBe(true);
    expect(within("sibling")).toBe(false);
  });

  it("keeps the layout through the blur a Send tap causes", () => {
    focus("Reply");
    act(() => {
      screen.getByLabelText("Reply").blur();
    });
    expect(within("reply")).toBe(true);
  });

  it("moves to an entry that is not the layout's to serve", () => {
    focus("Reply");
    focus("Title");
    expect(within("reply")).toBe(false);
  });

  it("moves to another owner", () => {
    focus("Reply");
    focus("Sibling");
    expect(within("reply")).toBe(false);
    expect(within("sibling")).toBe(true);
  });

  it("is left alone by focus on a button", () => {
    focus("Reply");
    act(() => {
      screen.getByRole("button", { name: "Send" }).focus();
    });
    expect(within("reply")).toBe(true);
  });

  it("ends with the keyboard and comes back with it", () => {
    focus("Reply");
    lowerNativeKeyboard();
    expect(within("reply")).toBe(false);
    raiseNativeKeyboard(IPHONE_17);
    expect(within("reply")).toBe(true);
  });
});
