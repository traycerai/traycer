import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "@tanstack/react-router";
import type { KeybindingRouterSource } from "@/lib/keybindings/router-adapter";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { isMac } from "@/lib/keybindings/platform";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";
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
    const store = useScreencastArmedStore.getState();
    if (store.ownerId !== null) store.release(store.ownerId);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    const store = useScreencastArmedStore.getState();
    if (store.ownerId !== null) store.release(store.ownerId);
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

    useScreencastArmedStore.getState().claim("peek-owner");
    act(() => {
      dispatchWindowKey("keydown", chordInit);
    });

    expect(openHistory).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/");

    useScreencastArmedStore.getState().release("peek-owner");
    act(() => {
      dispatchWindowKey("keydown", chordInit);
    });

    expect(openHistory).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale release from a superseded owner", () => {
    const store = useScreencastArmedStore.getState();
    store.claim("owner-a");
    store.claim("owner-b");

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
