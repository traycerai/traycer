import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { StatusBarKeybindingBridge } from "@/components/layout/status-bar/status-bar-keybinding-bridge";

// Dynamic-handler dispatch never touches the router (see
// `dispatchAction`/`registerDynamicActionHandler` in dispatch.ts), so every
// field here is a no-op - this just satisfies the parameter type, the same
// shape `rate-limit-icon.test.tsx` uses for its own dynamic action.
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

function resetStore(): void {
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  window.localStorage.clear();
}

function placement(): string {
  return useLayoutStore.getState().statusBar.placement;
}

beforeEach(resetStore);
afterEach(() => {
  cleanup();
  resetStore();
});

describe("<StatusBarKeybindingBridge />", () => {
  it("registers the toggle handler on mount and flips placement header -> status-bar -> header", () => {
    render(<StatusBarKeybindingBridge />);

    expect(placement()).toBe("header");

    act(() => {
      expect(dispatchAction("app.status-bar.toggle", NOOP_ROUTER)).toBe(true);
    });
    expect(placement()).toBe("status-bar");

    act(() => {
      expect(dispatchAction("app.status-bar.toggle", NOOP_ROUTER)).toBe(true);
    });
    expect(placement()).toBe("header");
  });

  it("reads placement at invocation time, not at registration time", () => {
    render(<StatusBarKeybindingBridge />);

    // Change placement out from under the handler by some other writer (the
    // Layout page, the context menu) between registration and dispatch.
    act(() => {
      useLayoutStore.getState().setStatusBarPlacement("status-bar");
    });

    act(() => {
      dispatchAction("app.status-bar.toggle", NOOP_ROUTER);
    });
    // Toggling from "status-bar" (the CURRENT value) goes to "header" - if the
    // handler had captured "header" at registration it would incorrectly
    // toggle back to "status-bar" here.
    expect(placement()).toBe("header");
  });

  it("no-ops the action once the bridge unmounts", () => {
    const { unmount } = render(<StatusBarKeybindingBridge />);
    unmount();

    let fired = false;
    act(() => {
      fired = dispatchAction("app.status-bar.toggle", NOOP_ROUTER);
    });
    expect(fired).toBe(false);
    expect(placement()).toBe("header");
  });
});
