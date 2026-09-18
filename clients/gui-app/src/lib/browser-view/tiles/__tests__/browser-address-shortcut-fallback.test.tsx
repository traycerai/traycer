import "../../../../../__tests__/test-browser-apis";
import { useRef, type ReactElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryHistory } from "@tanstack/react-router";
import type { KeybindingRouterSource } from "@/lib/keybindings/router-adapter";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { isMac } from "@/lib/keybindings/platform";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";
import { PaneFocusProbeContext } from "@/components/epic-tabs/pane-visibility-context";
import { useAddressDraft } from "@/components/epic-canvas/renderers/use-address-draft";
import { useBrowserAddressShortcut } from "@/lib/browser-view/tiles/browser-address-shortcut";

/**
 * A minimal stand-in for a browser tile's chrome: real `useAddressDraft` (so
 * `focusAddress` really calls `input.focus()` + `input.select()`) and the
 * real `useBrowserAddressShortcut` registration, without the weight of
 * `ElectronTabSurface` / `BrowserPeekTile`'s host wiring. Both real tiles
 * register the same way, so exercising the hook here through the real
 * `KeybindingProvider` covers the dispatcher-side fallback rules the two
 * heavier suites (`agent-browser-tile.test.tsx`,
 * `browser-peek-tile-shortcuts.test.tsx`) don't need to restate.
 */
function AddressProbe(props: {
  readonly enabled: boolean;
  readonly label: string;
}): ReactElement {
  const tileRef = useRef<HTMLDivElement | null>(null);
  // Destructured into locals (matching `browser-tile-toolbar.tsx`'s own
  // consumption of this controller) rather than used as `draft.x` inline:
  // the `react-hooks/refs` rule can't see through a property access on a
  // custom hook's return value and flags it as reading a ref during render.
  const { focusAddress, setAddressInput, addressValue, onAddressChange } =
    useAddressDraft(`https://example.com/${props.label}`);
  useBrowserAddressShortcut({
    enabled: props.enabled,
    tileRef,
    focusAddress,
  });
  return (
    <div ref={tileRef} data-testid={`tile-${props.label}`}>
      <div data-testid={`page-${props.label}`}>native page area</div>
      <input
        aria-label={`Address ${props.label}`}
        ref={setAddressInput}
        value={addressValue}
        onChange={(event) => onAddressChange(event.currentTarget.value)}
      />
    </div>
  );
}

function buildProviderRouterSource(
  initialPathname: string,
): KeybindingRouterSource {
  const history = createMemoryHistory({ initialEntries: [initialPathname] });
  const navigate: KeybindingRouterSource["navigate"] = () => Promise.resolve();
  return {
    get state() {
      return { location: { pathname: history.location.pathname } };
    },
    history,
    navigate,
  };
}

function platformModKeys(): {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
} {
  if (isMac()) return { metaKey: true, ctrlKey: false };
  return { metaKey: false, ctrlKey: true };
}

/**
 * Dispatched on the actual focused element rather than on `window`: the
 * fallback logic in `focusBrowserAddressForShortcut` reads `event.target`
 * and `event.composedPath()` to tell an editable field apart from a bare
 * click-away, so the test has to reproduce where a real keydown actually
 * originates (the focused element), not just that it reaches the window
 * listener.
 */
function dispatchModL(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "l",
    code: "KeyL",
    ...platformModKeys(),
  });
  target.dispatchEvent(event);
  return event;
}

function addressInput(label: string): HTMLInputElement {
  const input = screen.getByRole("textbox", { name: `Address ${label}` });
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`expected an input for Address ${label}`);
  }
  return input;
}

describe("focusBrowserAddressForShortcut fallback through the real KeybindingProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    const store = useScreencastArmedStore.getState();
    if (store.ownerId !== null) store.release(store.ownerId);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    const store = useScreencastArmedStore.getState();
    if (store.ownerId !== null) store.release(store.ownerId);
  });

  it("focuses and fully selects the address bar on mod+L when focus is unowned (body)", () => {
    const router = buildProviderRouterSource("/");
    render(
      <KeybindingProvider router={router}>
        <AddressProbe enabled label="a" />
      </KeybindingProvider>,
    );
    document.body.focus();

    let event: KeyboardEvent | undefined;
    act(() => {
      event = dispatchModL(document.body);
    });

    const input = addressInput("a");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(input.value.length).toBeGreaterThan(0);
    expect(event?.defaultPrevented).toBe(true);
  });

  it("falls back to the pane's unique tile when unowned focus sits on a non-editable control outside it (a tab-strip button)", () => {
    const router = buildProviderRouterSource("/");
    render(
      <KeybindingProvider router={router}>
        <AddressProbe enabled label="a" />
        <button type="button" data-testid="tab-strip-button">
          Tab
        </button>
      </KeybindingProvider>,
    );
    const tabStripButton = screen.getByTestId("tab-strip-button");
    tabStripButton.focus();
    expect(document.activeElement).toBe(tabStripButton);

    act(() => {
      dispatchModL(tabStripButton);
    });

    expect(document.activeElement).toBe(addressInput("a"));
  });

  it("leaves mod+L to an editable field outside the tile instead of stealing focus (e.g. the chat composer)", () => {
    const router = buildProviderRouterSource("/");
    render(
      <KeybindingProvider router={router}>
        <AddressProbe enabled label="a" />
        <input aria-label="Chat composer" />
      </KeybindingProvider>,
    );
    const composer = screen.getByRole("textbox", { name: "Chat composer" });
    composer.focus();
    expect(document.activeElement).toBe(composer);

    act(() => {
      dispatchModL(composer);
    });

    expect(document.activeElement).toBe(composer);
  });

  it("leaves mod+L to a contentEditable field outside the tile instead of stealing focus", () => {
    const router = buildProviderRouterSource("/");
    render(
      <KeybindingProvider router={router}>
        <AddressProbe enabled label="a" />
        <div
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label="Rich text editor"
        >
          draft text
        </div>
      </KeybindingProvider>,
    );
    const editor = screen.getByRole("textbox", { name: "Rich text editor" });
    // jsdom does not compute `isContentEditable` from the attribute (no
    // layout/editing-host implementation), so stub the browser-computed
    // property directly - `isEditableEventTarget` reads only that, not the
    // raw attribute, so a real browser's `true` here has to be simulated by
    // hand (see `editable-target.test.ts` for the same shim).
    Object.defineProperty(editor, "isContentEditable", {
      value: true,
      configurable: true,
    });
    editor.focus();
    expect(document.activeElement).toBe(editor);

    act(() => {
      dispatchModL(editor);
    });

    expect(document.activeElement).toBe(editor);
  });

  it("does not steal focus for a pane that is not the focused one, even with two tiles on screen", () => {
    const router = buildProviderRouterSource("/");
    render(
      <KeybindingProvider router={router}>
        <PaneFocusProbeContext.Provider value={() => true}>
          <AddressProbe enabled label="active" />
        </PaneFocusProbeContext.Provider>
        <PaneFocusProbeContext.Provider value={() => false}>
          <AddressProbe enabled label="inactive" />
        </PaneFocusProbeContext.Provider>
      </KeybindingProvider>,
    );
    document.body.focus();

    act(() => {
      dispatchModL(document.body);
    });

    expect(document.activeElement).toBe(addressInput("active"));
    const inactiveInput = addressInput("inactive");
    expect(document.activeElement).not.toBe(inactiveInput);
    expect(inactiveInput.selectionStart).toBe(inactiveInput.selectionEnd);
  });

  it("does nothing when two panes are simultaneously focused and neither tile is the unique candidate", () => {
    const router = buildProviderRouterSource("/");
    render(
      <KeybindingProvider router={router}>
        <PaneFocusProbeContext.Provider value={() => true}>
          <AddressProbe enabled label="left" />
        </PaneFocusProbeContext.Provider>
        <PaneFocusProbeContext.Provider value={() => true}>
          <AddressProbe enabled label="right" />
        </PaneFocusProbeContext.Provider>
      </KeybindingProvider>,
    );
    document.body.focus();

    act(() => {
      dispatchModL(document.body);
    });

    expect(document.activeElement).toBe(document.body);
  });

  it("ignores a disabled tile - a chord with no enabled candidate never claims the address bar", () => {
    const router = buildProviderRouterSource("/");
    render(
      <KeybindingProvider router={router}>
        <AddressProbe enabled={false} label="a" />
      </KeybindingProvider>,
    );
    document.body.focus();

    act(() => {
      dispatchModL(document.body);
    });

    expect(document.activeElement).toBe(document.body);
  });

  it("leaves mod+L to a blocking dialog instead of the address bar", () => {
    const router = buildProviderRouterSource("/");
    render(
      <KeybindingProvider router={router}>
        <AddressProbe enabled label="a" />
      </KeybindingProvider>,
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    document.body.focus();

    act(() => {
      dispatchModL(document.body);
    });

    expect(document.activeElement).not.toBe(addressInput("a"));
  });
});
