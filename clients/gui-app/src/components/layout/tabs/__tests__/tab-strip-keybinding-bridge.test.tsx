import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { TabStripKeybindingBridge } from "@/components/layout/tabs/tab-strip-keybinding-bridge";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import type { TabStripPlacement } from "@/lib/layout/layout-arrangement";
import { setMobileApp } from "@/lib/mobile-app";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

// Dynamic-handler dispatch never touches the router, so every field is a no-op.
const NOOP_ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

function placement(): TabStripPlacement {
  return useLayoutStore.getState().arrangement.tabStripPlacement;
}

function setPlacement(next: TabStripPlacement): void {
  useLayoutStore.getState().setArrangement({
    ...useLayoutStore.getState().arrangement,
    tabStripPlacement: next,
  });
}

function toggle(): boolean {
  let fired = false;
  act(() => {
    fired = dispatchAction("app.tabs.vertical.toggle", NOOP_ROUTER);
  });
  return fired;
}

function resetStores(): void {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutEditorStore.getState().endSession();
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  setMobileApp(false);
  resetStores();
});

describe("<TabStripKeybindingBridge />", () => {
  // The top -> left -> top round trip through the mounted shell is
  // app-shell-lifecycle-bridges' "registers the vertical-tabs toggle in either
  // placement". This file owns the rest of the chord's mapping and what the
  // shell test cannot see.
  it("brings the tabs back to the top from the right", () => {
    setPlacement("right");
    render(<TabStripKeybindingBridge />);

    expect(toggle()).toBe(true);
    expect(placement()).toBe("top");
  });

  it("reads the placement at invocation, not at registration", () => {
    render(<TabStripKeybindingBridge />);
    act(() => {
      setPlacement("left");
    });

    toggle();
    expect(placement()).toBe("top");
  });

  it("is one undo step inside a layout editor session", () => {
    useLayoutEditorStore.getState().beginSession({
      entry: "keyboard",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
    render(<TabStripKeybindingBridge />);

    toggle();
    expect(useLayoutEditorStore.getState().history.past).toHaveLength(1);

    useLayoutEditorStore.getState().undo();
    expect(placement()).toBe("top");
  });

  // Finding 8: this toggle now goes through the same one writer
  // (`writeArrangementField`) as the placement bar's drop and the dock's
  // rows - a gesture that touches a field this action does not own would be
  // a second write path.
  it("touches only tabStripPlacement", () => {
    // A non-default field first: against the default arrangement, a write
    // rebuilt from `DEFAULT_ARRANGEMENT` would look identical.
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      taskTabLayout: "shrink",
    });
    const before = useLayoutStore.getState().arrangement;
    render(<TabStripKeybindingBridge />);

    toggle();

    expect(useLayoutStore.getState().arrangement).toEqual({
      ...before,
      tabStripPlacement: "left",
    });
  });

  it("registers nothing in the installed mobile app", () => {
    setMobileApp(true);
    render(<TabStripKeybindingBridge />);

    expect(toggle()).toBe(false);
    expect(placement()).toBe("top");
  });

  it("no-ops the action once the bridge unmounts", () => {
    const { unmount } = render(<TabStripKeybindingBridge />);
    unmount();

    expect(toggle()).toBe(false);
    expect(placement()).toBe("top");
  });
});
