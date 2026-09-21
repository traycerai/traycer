import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const fromFrame = vi.hoisted(() => vi.fn());
const getAllWebContents = vi.hoisted(() => vi.fn());
const getFocusedWindow = vi.hoisted(() => vi.fn());

vi.mock("electron", () => {
  class BaseWindow {}
  class BrowserWindow extends BaseWindow {
    static getFocusedWindow(): unknown {
      return getFocusedWindow();
    }
    isDestroyed(): boolean {
      return false;
    }
  }
  return {
    BaseWindow,
    BrowserWindow,
    webContents: { fromFrame, getAllWebContents },
  };
});

import { BaseWindow, BrowserWindow } from "electron";
import { reloadFocusedPage } from "../reload-focused-page";

interface FakeContents {
  readonly focusedFrame: object | null;
  readonly devToolsWebContents: FakeContents | null;
  readonly isDestroyed: () => boolean;
  readonly isDevToolsFocused: () => boolean;
  readonly reload: Mock<() => void>;
  readonly reloadIgnoringCache: Mock<() => void>;
}

function fakeContents(options: {
  focusedFrame?: object | null;
  destroyed?: boolean;
  inspector?: FakeContents;
  devToolsFocused?: boolean;
}): FakeContents {
  return {
    focusedFrame: options.focusedFrame ?? null,
    devToolsWebContents: options.inspector ?? null,
    isDestroyed: () => options.destroyed === true,
    isDevToolsFocused: () => options.devToolsFocused === true,
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
  };
}

/** A real `BrowserWindow` instance (per the mock) whose host is `host`. */
function buildWindow(host: FakeContents, destroyed: boolean): BrowserWindow {
  const window = new BrowserWindow();
  Object.defineProperty(window, "webContents", { value: host });
  window.isDestroyed = () => destroyed;
  return window;
}

function windowWith(host: FakeContents): BrowserWindow {
  return buildWindow(host, false);
}

function expectNoReload(...all: readonly FakeContents[]): void {
  for (const contents of all) {
    expect(contents.reload).not.toHaveBeenCalled();
    expect(contents.reloadIgnoringCache).not.toHaveBeenCalled();
  }
}

describe("reloadFocusedPage", () => {
  beforeEach(() => {
    fromFrame.mockReset();
    getAllWebContents.mockReset();
    getAllWebContents.mockReturnValue([]);
    getFocusedWindow.mockReset();
    getFocusedWindow.mockReturnValue(null);
  });

  it("is a no-op without a window", () => {
    expect(() => reloadFocusedPage(undefined, false)).not.toThrow();
    expect(fromFrame).not.toHaveBeenCalled();
  });

  it("stays a no-op without a window when no BrowserWindow is focused", () => {
    getFocusedWindow.mockReturnValue(null);
    expect(() => reloadFocusedPage(undefined, false)).not.toThrow();
    expect(fromFrame).not.toHaveBeenCalled();
    expect(getAllWebContents).not.toHaveBeenCalled();
  });

  it("ignores a BaseWindow that is not a BrowserWindow", () => {
    expect(() => reloadFocusedPage(new BaseWindow(), false)).not.toThrow();
    expect(fromFrame).not.toHaveBeenCalled();
  });

  it("does nothing when the window itself is destroyed", () => {
    const host = fakeContents({ focusedFrame: {} });
    reloadFocusedPage(buildWindow(host, true), false);
    expect(fromFrame).not.toHaveBeenCalled();
    expectNoReload(host);
  });

  it("does nothing when the window's host is destroyed", () => {
    const host = fakeContents({ focusedFrame: {}, destroyed: true });
    reloadFocusedPage(windowWith(host), false);
    expect(fromFrame).not.toHaveBeenCalled();
    expectNoReload(host);
  });

  it("reloads the guest that owns the focused frame, not the host", () => {
    const frame = {};
    const guest = fakeContents({});
    const host = fakeContents({ focusedFrame: frame });
    fromFrame.mockReturnValue(guest);

    reloadFocusedPage(windowWith(host), false);

    expect(fromFrame).toHaveBeenCalledWith(frame);
    expect(guest.reload).toHaveBeenCalledTimes(1);
    expect(guest.reloadIgnoringCache).not.toHaveBeenCalled();
    expectNoReload(host);
  });

  it("reloads the host when the focused frame is the application's own", () => {
    const frame = {};
    const host = fakeContents({ focusedFrame: frame });
    fromFrame.mockReturnValue(host);

    reloadFocusedPage(windowWith(host), false);

    expect(host.reload).toHaveBeenCalledTimes(1);
  });

  it("falls back to the host when no frame is focused", () => {
    const host = fakeContents({ focusedFrame: null });
    fromFrame.mockReturnValue(undefined);

    reloadFocusedPage(windowWith(host), false);

    expect(host.reload).toHaveBeenCalledTimes(1);
  });

  it("falls back to the host when the frame maps to no contents", () => {
    const host = fakeContents({ focusedFrame: {} });
    fromFrame.mockReturnValue(undefined);

    reloadFocusedPage(windowWith(host), false);

    expect(host.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload anything when the resolved guest is destroyed", () => {
    const guest = fakeContents({ destroyed: true });
    const host = fakeContents({ focusedFrame: {} });
    fromFrame.mockReturnValue(guest);

    reloadFocusedPage(windowWith(host), false);

    expectNoReload(guest, host);
  });

  it("force reload calls reloadIgnoringCache on the focused guest only", () => {
    const guest = fakeContents({});
    const host = fakeContents({ focusedFrame: {} });
    fromFrame.mockReturnValue(guest);

    reloadFocusedPage(windowWith(host), true);

    expect(guest.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(guest.reload).not.toHaveBeenCalled();
    expectNoReload(host);
  });

  it("force reload on the host uses reloadIgnoringCache too", () => {
    const host = fakeContents({ focusedFrame: null });

    reloadFocusedPage(windowWith(host), true);

    expect(host.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(host.reload).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reloads the inspected guest when its detached inspector is focused (ignoreCache=%s)",
    (ignoreCache) => {
      const inspector = fakeContents({});
      const guest = fakeContents({ inspector });
      const other = fakeContents({});
      const host = fakeContents({ focusedFrame: {} });
      fromFrame.mockReturnValue(inspector);
      getAllWebContents.mockReturnValue([other, host, guest]);

      reloadFocusedPage(windowWith(host), ignoreCache);

      const reloaded = ignoreCache ? "reloadIgnoringCache" : "reload";
      const untouched = ignoreCache ? "reload" : "reloadIgnoringCache";
      expect(guest[reloaded]).toHaveBeenCalledTimes(1);
      expect(guest[untouched]).not.toHaveBeenCalled();
      expectNoReload(inspector, other, host);
    },
  );

  it.each([false, true])(
    "reloads the application when its own inspector is focused (ignoreCache=%s)",
    (ignoreCache) => {
      const inspector = fakeContents({});
      const host = fakeContents({ focusedFrame: {}, inspector });
      const guest = fakeContents({});
      fromFrame.mockReturnValue(inspector);
      getAllWebContents.mockReturnValue([guest, host]);

      reloadFocusedPage(windowWith(host), ignoreCache);

      const reloaded = ignoreCache ? "reloadIgnoringCache" : "reload";
      expect(host[reloaded]).toHaveBeenCalledTimes(1);
      expectNoReload(inspector, guest);
    },
  );

  it("does not reload when the inspected page is destroyed", () => {
    const inspector = fakeContents({});
    const guest = fakeContents({ inspector, destroyed: true });
    const host = fakeContents({ focusedFrame: {} });
    fromFrame.mockReturnValue(inspector);
    getAllWebContents.mockReturnValue([guest, host]);

    reloadFocusedPage(windowWith(host), false);

    expectNoReload(inspector, guest, host);
  });

  it.each([false, true])(
    "reloads the app when its built-in DevTools has focus although the last focused frame was a guest (ignoreCache=%s)",
    (ignoreCache) => {
      const guest = fakeContents({});
      const host = fakeContents({ focusedFrame: {}, devToolsFocused: true });
      fromFrame.mockReturnValue(guest);
      getAllWebContents.mockReturnValue([guest, host]);

      reloadFocusedPage(windowWith(host), ignoreCache);

      const reloaded = ignoreCache ? "reloadIgnoringCache" : "reload";
      expect(host[reloaded]).toHaveBeenCalledTimes(1);
      expectNoReload(guest);
    },
  );

  it("resolves an undefined callback window to the focused BrowserWindow when built-in DevTools has focus", () => {
    const guest = fakeContents({});
    const host = fakeContents({ focusedFrame: {}, devToolsFocused: true });
    fromFrame.mockReturnValue(guest);
    getAllWebContents.mockReturnValue([guest, host]);
    getFocusedWindow.mockReturnValue(windowWith(host));

    reloadFocusedPage(undefined, false);

    expect(host.reload).toHaveBeenCalledTimes(1);
    expectNoReload(guest);
  });
});
