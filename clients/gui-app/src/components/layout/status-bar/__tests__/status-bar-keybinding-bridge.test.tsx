import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { setMobileApp } from "@/lib/mobile-app";
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
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  window.localStorage.clear();
}

/** Both readings' bars, since the toggle is about the SURFACE (L-156). */
function hosts(): ReadonlyArray<string> {
  const { arrangement } = useLayoutStore.getState();
  return [arrangement.usageHost, arrangement.resourceHost];
}

beforeEach(resetStore);
afterEach(() => {
  cleanup();
  setMobileApp(false);
  resetStore();
});

describe("<StatusBarKeybindingBridge />", () => {
  it("registers the toggle handler on mount and flips placement status-bar -> header -> status-bar", () => {
    render(<StatusBarKeybindingBridge />);

    expect(hosts()).toEqual(["status-bar", "status-bar"]);

    act(() => {
      expect(dispatchAction("app.status-bar.toggle", NOOP_ROUTER)).toBe(true);
    });
    expect(hosts()).toEqual(["header", "header"]);

    act(() => {
      expect(dispatchAction("app.status-bar.toggle", NOOP_ROUTER)).toBe(true);
    });
    expect(hosts()).toEqual(["status-bar", "status-bar"]);
  });

  it("reads placement at invocation time, not at registration time", () => {
    render(<StatusBarKeybindingBridge />);

    // Change placement out from under the handler by some other writer (the
    // Layout page, the context menu) between registration and dispatch.
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        usageHost: "header",
        resourceHost: "header",
      });
    });

    act(() => {
      dispatchAction("app.status-bar.toggle", NOOP_ROUTER);
    });
    // With nothing left in the strip the toggle brings both back - if the
    // handler had captured the empty strip at registration it would
    // incorrectly send them up again here.
    expect(hosts()).toEqual(["status-bar", "status-bar"]);
  });

  it("brings back exactly what it sent up, two presses later (L-160)", () => {
    // The arrangement L-156 exists for: the gauge up, the readout down. A
    // toggle that flattened it would put the gauge in the strip on the way
    // back, and the chord path writes the store directly, so there is no
    // Undo to reach for.
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        usageHost: "header",
        usageSide: "right",
      });
    });

    render(<StatusBarKeybindingBridge />);

    act(() => {
      dispatchAction("app.status-bar.toggle", NOOP_ROUTER);
    });
    // The strip was still holding the monitor, so the surface toggle empties
    // it; the reading already up there is not dragged back down, and neither
    // reading changes ends (L-156).
    expect(hosts()).toEqual(["header", "header"]);
    expect(useLayoutStore.getState().arrangement.resourceSide).toBe("right");

    act(() => {
      dispatchAction("app.status-bar.toggle", NOOP_ROUTER);
    });
    expect(hosts()).toEqual(["header", "status-bar"]);
    expect(useLayoutStore.getState().arrangement.usageSide).toBe("right");
  });

  it("registers nothing in the installed mobile app", () => {
    setMobileApp(true);

    render(<StatusBarKeybindingBridge />);

    // The gate is the action's own `desktopOnly` flag, read here rather than
    // hard-coded at the mount site, so the palette's filter and this
    // registration answer to the same fact.
    let fired = true;
    act(() => {
      fired = dispatchAction("app.status-bar.toggle", NOOP_ROUTER);
    });
    expect(fired).toBe(false);
    expect(hosts()).toEqual(["status-bar", "status-bar"]);
  });

  it("no-ops the action once the bridge unmounts", () => {
    const { unmount } = render(<StatusBarKeybindingBridge />);
    unmount();

    let fired = false;
    act(() => {
      fired = dispatchAction("app.status-bar.toggle", NOOP_ROUTER);
    });
    expect(fired).toBe(false);
    expect(hosts()).toEqual(["status-bar", "status-bar"]);
  });
});
