/**
 * Native keyboard bridge properties.
 *
 * The Keyboard plugin is faked at the package boundary and gui-app's state
 * setter is mocked, so these drive the four plugin events directly and read
 * back the two things the bridge publishes: the `--keyboard-inset` custom
 * property the shell's safe-height tokens subtract, and gui-app's
 * open/transitioning state.
 *
 * The central claim is the one the shipped bug broke - the inset returns to 0
 * whenever the keyboard is closed, in every event order iOS delivers. A
 * programmatic dismissal (`use-drag-to-dismiss-keyboard` blurs the field, which
 * is how every dismissal in this app happens) makes iOS send the hide pair in
 * reverse, and while the reset lived in the `keyboardWillHide` handler the
 * stale-event guard there skipped it - stranding the whole `h-safe-dvh` shell
 * a keyboard's height short of the screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginListenerHandle } from "@capacitor/core";
import type { KeyboardInfo } from "@capacitor/keyboard";

const { publishState } = vi.hoisted(() => ({ publishState: vi.fn() }));
vi.mock("@traycer-clients/gui-app", () => ({
  setNativeKeyboardState: publishState,
}));

import { startNativeKeyboardBridge } from "../src/web/native-keyboard-bridge";

type ShowEvent = "keyboardWillShow" | "keyboardDidShow";
type HideEvent = "keyboardWillHide" | "keyboardDidHide";

const KEYBOARD_PX = 336;

/** Records the bridge's listeners so a test can deliver events in any order. */
class FakeKeyboard {
  private readonly listeners = new Map<
    ShowEvent | HideEvent,
    (info: KeyboardInfo) => void
  >();

  addListener(
    eventName: ShowEvent | HideEvent,
    listenerFunc: (info: KeyboardInfo) => void,
  ): Promise<PluginListenerHandle> {
    this.listeners.set(eventName, listenerFunc);
    return Promise.resolve({ remove: () => Promise.resolve() });
  }

  show(eventName: ShowEvent, keyboardHeight: number): void {
    this.emit(eventName, keyboardHeight);
  }

  hide(eventName: HideEvent): void {
    this.emit(eventName, 0);
  }

  private emit(eventName: ShowEvent | HideEvent, keyboardHeight: number): void {
    const listener = this.listeners.get(eventName);
    if (listener === undefined) {
      throw new Error(`bridge attached no ${eventName} listener`);
    }
    listener({ keyboardHeight });
  }
}

function startBridge(drivesInset: boolean): FakeKeyboard {
  const plugin = new FakeKeyboard();
  startNativeKeyboardBridge({ plugin, drivesInset });
  return plugin;
}

function raiseKeyboard(plugin: FakeKeyboard): void {
  plugin.show("keyboardWillShow", KEYBOARD_PX);
  plugin.show("keyboardDidShow", KEYBOARD_PX);
}

function inset(): string {
  return document.documentElement.style.getPropertyValue("--keyboard-inset");
}

describe("startNativeKeyboardBridge", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--keyboard-inset");
    document.documentElement.classList.remove("traycer-native-keyboard");
    publishState.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drives the inset from will-show through will-hide when events are ordered", () => {
    const plugin = startBridge(true);
    // `willShow` fires before the animation, which is what lets the shell's
    // safe-height tokens glide with the keyboard rather than jump after it.
    plugin.show("keyboardWillShow", KEYBOARD_PX);
    expect(inset()).toBe("336px");
    plugin.show("keyboardDidShow", KEYBOARD_PX);
    expect(inset()).toBe("336px");
    plugin.hide("keyboardWillHide");
    expect(inset()).toBe("0px");
    plugin.hide("keyboardDidHide");
    expect(inset()).toBe("0px");
  });

  it("clears the inset when the hide pair arrives in reverse order", () => {
    const plugin = startBridge(true);
    raiseKeyboard(plugin);
    expect(inset()).toBe("336px");

    plugin.hide("keyboardDidHide");
    plugin.hide("keyboardWillHide");

    expect(inset()).toBe("0px");
  });

  it("clears the inset when keyboardWillHide never arrives at all", () => {
    const plugin = startBridge(true);
    raiseKeyboard(plugin);

    plugin.hide("keyboardDidHide");

    expect(inset()).toBe("0px");
  });

  it("still ignores a stale keyboardWillHide rather than starting a phantom transition", () => {
    const plugin = startBridge(true);
    raiseKeyboard(plugin);
    plugin.hide("keyboardDidHide");
    publishState.mockClear();

    plugin.hide("keyboardWillHide");

    expect(publishState).not.toHaveBeenCalled();
  });

  it("rests at the settled height when didShow corrects willShow", () => {
    const plugin = startBridge(true);
    plugin.show("keyboardWillShow", KEYBOARD_PX);

    plugin.show("keyboardDidShow", KEYBOARD_PX + 45);

    expect(inset()).toBe("381px");
  });

  it("leaves the inset consistent when the watchdog force-settles a dropped didHide", () => {
    vi.useFakeTimers();
    const plugin = startBridge(true);
    raiseKeyboard(plugin);

    plugin.hide("keyboardWillHide");
    vi.advanceTimersByTime(700);

    expect(inset()).toBe("0px");
    expect(publishState).toHaveBeenLastCalledWith({
      open: false,
      transitioning: false,
    });
  });

  it("ignores a keyboardDidShow that lands after a hide was already declared", () => {
    vi.useFakeTimers();
    const plugin = startBridge(true);
    plugin.show("keyboardWillShow", KEYBOARD_PX);
    plugin.hide("keyboardWillHide");

    // The show's own did- event, arriving after the hide superseded it.
    // Honouring it would cancel the close watchdog and republish the old
    // height, and with no didHide behind it the inset would stay there - the
    // same stranding this module exists to prevent, mirrored onto the show side.
    plugin.show("keyboardDidShow", KEYBOARD_PX);
    vi.advanceTimersByTime(700);

    expect(inset()).toBe("0px");
    expect(publishState).toHaveBeenLastCalledWith({
      open: false,
      transitioning: false,
    });
  });

  it("writes no inset on a shell whose webview resizes itself", () => {
    const plugin = startBridge(false);

    raiseKeyboard(plugin);

    expect(inset()).toBe("");
    expect(
      document.documentElement.classList.contains("traycer-native-keyboard"),
    ).toBe(false);
    expect(publishState).toHaveBeenLastCalledWith({
      open: true,
      transitioning: false,
    });
  });
});
