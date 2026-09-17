import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "@tanstack/react-router";
import type { KeybindingRouterSource } from "@/lib/keybindings/router-adapter";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { isMac } from "@/lib/keybindings/platform";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { registerLeaderScope } from "@/lib/keybindings/leader-scope";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";
import type { TabStripItem } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type { OpenSettingsModalOpts } from "@/stores/tabs/system-overlay-types";
import type { SettingsSectionId } from "@/lib/settings-sections";

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
 * The default layout is a Start Page owning the screen, which is what makes
 * the landing rows forwarded; `EPIC_TAB` is the other side of that gate.
 */
const INITIAL_TABS_LAYOUT = {
  items: useTabsStore.getState().items,
  activeItemId: useTabsStore.getState().activeItemId,
};
const EPIC_TAB: TabStripItem = {
  kind: "tab",
  id: "item-epic-a",
  ref: { kind: "epic", id: "epic-a" },
};

function armWithReleaseSpy() {
  const releasePageKeys = vi.fn();
  useScreencastArmedStore.getState().claim("peek-owner", releasePageKeys);
  return { releasePageKeys };
}

function dispatchWindowKey(
  type: "keydown" | "keyup",
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

function dispatchTargetKey(
  target: HTMLElement,
  type: "keydown" | "keyup",
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function seedHistoryModal(openHistory: () => void): void {
  setSystemTabModalApi({
    active: null,
    openSettings: (_opts: OpenSettingsModalOpts) => undefined,
    openHistory,
    close: () => undefined,
    setSection: (_section: SettingsSectionId) => undefined,
    promoteToTab: () => undefined,
    isOverlayActive: () => false,
  });
}

describe("KeybindingProvider screencast armed flag", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    useTabsStore.setState(INITIAL_TABS_LAYOUT);
    const store = useScreencastArmedStore.getState();
    if (store.ownerId !== null) store.release(store.ownerId);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    const store = useScreencastArmedStore.getState();
    if (store.ownerId !== null) store.release(store.ownerId);
    useTabsStore.setState(INITIAL_TABS_LAYOUT);
    setSystemTabModalApi(null);
    vi.restoreAllMocks();
  });

  it("skips a bound app chord while armed and fires it after disarm", () => {
    const router = buildProviderRouterSource("/");
    const openHistory = vi.fn();
    seedHistoryModal(openHistory);
    render(createElement(KeybindingProvider, { router, children: null }));

    expect(getDefaultBindings()["app.history.open"]).toBe("mod+y");

    const chordInit: KeyboardEventInit = {
      code: "KeyY",
      key: "y",
      ...platformModKeys(),
    };

    const { releasePageKeys } = armWithReleaseSpy();
    act(() => {
      dispatchWindowKey("keydown", chordInit);
    });

    expect(openHistory).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/");
    // An UNRESERVED app chord is still the page's while armed, so the tile is
    // never told to release the keys it has forwarded either.
    expect(releasePageKeys).not.toHaveBeenCalled();

    useScreencastArmedStore.getState().release("peek-owner");
    act(() => {
      dispatchWindowKey("keydown", chordInit);
    });

    expect(openHistory).toHaveBeenCalledTimes(1);
  });

  // The streamed half of the reserved-chord table. A native tile gets these
  // because main replays them into this renderer; a streamed tile has no main
  // process in its input path, so the app registry skipping every action while
  // armed was the whole of what stopped them.
  it("fires an app-forwarded chord while armed, after releasing the page's keys", () => {
    const router = buildProviderRouterSource("/");
    const openPalette = vi.fn();
    const unregister = registerDynamicActionHandler(
      "app.palette.open",
      openPalette,
    );
    render(createElement(KeybindingProvider, { router, children: null }));

    expect(getDefaultBindings()["app.palette.open"]).toBe("mod+k");
    const { releasePageKeys } = armWithReleaseSpy();

    // Stands in for the armed tile's own listener, at the same phase and below
    // the window the provider listens on.
    const tile = document.createElement("div");
    document.body.append(tile);
    const tileCaptureHits: string[] = [];
    tile.addEventListener(
      "keydown",
      (event) => {
        tileCaptureHits.push(event.code);
      },
      true,
    );

    let consumed = false;
    act(() => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyK",
        key: "k",
        ...platformModKeys(),
      });
      tile.dispatchEvent(event);
      consumed = event.defaultPrevented;
    });

    expect(openPalette).toHaveBeenCalledTimes(1);
    // Reserved, so the tile's own capture-phase listener never runs and the
    // page is never sent the keystroke. Asserted directly rather than inferred
    // from `defaultPrevented`, because "the app acted" and "the page did not
    // also get it" are two different guarantees and only the second is what
    // stops a chord being handled twice. The tile listens in the CAPTURE
    // phase on its own element (`use-screencast-session`), which the
    // provider's window-capture `stopPropagation` is above.
    expect(consumed).toBe(true);
    expect(tileCaptureHits).toEqual([]);
    // Before the action, not after: the palette takes focus out of the tile's
    // IME input, so the keyup that would have ended this modifier never
    // reaches the page.
    expect(releasePageKeys).toHaveBeenCalledTimes(1);
    expect(releasePageKeys.mock.invocationCallOrder[0]).toBeLessThan(
      openPalette.mock.invocationCallOrder[0],
    );
    unregister();
  });

  // The landing rows keep the surface gate they already have on the native
  // side, and it lives in `reservedBrowserChordsFor` - so a canvas-armed tile
  // is never offered them and its own Cmd+J stays the page's.
  it("fires a landing-forwarded chord while armed only while the Start Page owns the screen", () => {
    const router = buildProviderRouterSource("/");
    const toggleTerminal = vi.fn();
    const unregister = registerDynamicActionHandler(
      "app.terminal.toggle",
      toggleTerminal,
    );
    render(createElement(KeybindingProvider, { router, children: null }));

    expect(getDefaultBindings()["app.terminal.toggle"]).toBe("mod+j");
    const chordInit: KeyboardEventInit = {
      code: "KeyJ",
      key: "j",
      ...platformModKeys(),
    };
    armWithReleaseSpy();

    act(() => {
      dispatchWindowKey("keydown", chordInit);
    });
    expect(toggleTerminal).toHaveBeenCalledTimes(1);

    act(() => {
      useTabsStore.setState({ items: [EPIC_TAB], activeItemId: EPIC_TAB.id });
    });
    let consumed = true;
    act(() => {
      consumed = dispatchWindowKey("keydown", chordInit).defaultPrevented;
    });

    expect(toggleTerminal).toHaveBeenCalledTimes(1);
    expect(consumed).toBe(false);
    unregister();
  });

  /**
   * The DIGIT half of the same exemption, which the chord case above cannot
   * stand in for.
   *
   * A leader binds a modifier MASK (`"mod"`), and the set this exemption is
   * compared against holds full chords resolved from the event - so a leader
   * reserved verbatim would put `"mod"` in that set, `resolveMatchingChord`
   * would answer `mod+1`, and ⌘1 would stay the page's while the panel held a
   * scope for it. `reservedBrowserChordsFor` expanding the leader to its nine
   * digits is what makes this pass, and it is the SAME expansion main replays
   * from on the native side.
   */
  it("fires the panel's tab-number leader while armed, on a digit", () => {
    const router = buildProviderRouterSource("/");
    const switchByDigit = vi.fn();
    const unregister = registerLeaderScope({
      id: "test-landing-digits",
      actions: [
        {
          actionId: "tab.switch.byDigit",
          isActive: () => true,
          dispatch: (digit) => {
            switchByDigit(digit);
            return true;
          },
          dispatchSequence: null,
          sequenceState: null,
        },
      ],
    });
    render(createElement(KeybindingProvider, { router, children: null }));

    expect(getDefaultBindings()["tab.switch.byDigit"]).toBe("mod");
    const { releasePageKeys } = armWithReleaseSpy();
    act(() => {
      dispatchWindowKey("keydown", {
        code: "Digit2",
        key: "2",
        ...platformModKeys(),
      });
    });

    expect(switchByDigit).toHaveBeenCalledWith(2);
    expect(releasePageKeys).toHaveBeenCalledTimes(1);

    // And it keeps the surface gate the chord rows have: on an epic canvas the
    // digit is the page's again.
    act(() => {
      useTabsStore.setState({ items: [EPIC_TAB], activeItemId: EPIC_TAB.id });
    });
    act(() => {
      dispatchWindowKey("keydown", {
        code: "Digit2",
        key: "2",
        ...platformModKeys(),
      });
    });
    expect(switchByDigit).toHaveBeenCalledTimes(1);
    unregister();
  });

  // The browser-scoped rows are the other half of the same table and must NOT
  // be exempted: the screencast controller claims them for the tile, and an
  // app registry that fired first would take the tab chords off it.
  it("leaves the browser's own reserved chords to the armed tile", () => {
    const router = buildProviderRouterSource("/");
    const newTab = vi.fn();
    const unregister = registerDynamicActionHandler("tab.new", newTab);
    render(createElement(KeybindingProvider, { router, children: null }));

    const { releasePageKeys } = armWithReleaseSpy();
    let consumed = true;
    act(() => {
      consumed = dispatchWindowKey("keydown", {
        code: "KeyT",
        key: "t",
        ...platformModKeys(),
      }).defaultPrevented;
    });

    expect(newTab).not.toHaveBeenCalled();
    expect(consumed).toBe(false);
    expect(releasePageKeys).not.toHaveBeenCalled();
    unregister();
  });

  it("ignores a stale release from a superseded owner", () => {
    const store = useScreencastArmedStore.getState();
    store.claim("owner-a", () => undefined);
    store.claim("owner-b", () => undefined);

    store.release("owner-a");

    expect(useScreencastArmedStore.getState().ownerId).toBe("owner-b");
  });

  it("lets a consumed app chord keyup reach its focused target", () => {
    const router = buildProviderRouterSource("/");
    seedHistoryModal(() => undefined);
    render(createElement(KeybindingProvider, { router, children: null }));

    const target = document.createElement("button");
    target.type = "button";
    document.body.append(target);
    const bubble = vi.fn();
    target.addEventListener("keyup", bubble);

    const chordInit: KeyboardEventInit = {
      code: "KeyY",
      key: "y",
      ...platformModKeys(),
    };

    act(() => {
      dispatchTargetKey(target, "keydown", chordInit);
    });

    let keyup: KeyboardEvent | undefined;
    act(() => {
      keyup = dispatchTargetKey(target, "keyup", chordInit);
    });

    expect(keyup?.defaultPrevented).toBe(false);
    expect(bubble).toHaveBeenCalledTimes(1);
  });
});
