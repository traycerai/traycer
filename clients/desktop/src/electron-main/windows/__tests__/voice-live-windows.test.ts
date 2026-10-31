import { describe, expect, it } from "vitest";
import { CloseToTray } from "../close-to-tray";
import {
  installVoiceLiveReset,
  VoiceLiveWindows,
  type DidFailLoadListener,
  type VoiceLiveResetTarget,
} from "../voice-live-windows";

/**
 * A window whose document lifecycle the test fires by hand, with the events
 * Electron would raise: a navigation starting (also for a same-document or a
 * later cancelled one), a navigation committing, an error page committing,
 * the renderer going, the window destroyed.
 */
class FakeWindow implements VoiceLiveResetTarget {
  private navigated: Array<() => void> = [];
  private failed: DidFailLoadListener[] = [];
  private gone: Array<() => void> = [];
  private closed: Array<() => void> = [];
  readonly webContents = {
    on: (
      event: "did-navigate" | "did-fail-load" | "render-process-gone",
      listener: (() => void) | DidFailLoadListener,
    ): void => {
      if (event === "did-navigate") this.navigated.push(listener as () => void);
      else if (event === "did-fail-load") {
        this.failed.push(listener as DidFailLoadListener);
      } else this.gone.push(listener as () => void);
    },
  };

  on(_event: "closed", listener: () => void): void {
    this.closed.push(listener);
  }

  commitNavigation(): void {
    for (const listener of this.navigated) listener();
  }

  failLoad(isMainFrame: boolean): void {
    for (const listener of this.failed) {
      listener(
        undefined,
        -105,
        "ERR_NAME_NOT_RESOLVED",
        "app://x",
        isMainFrame,
      );
    }
  }

  rendererGone(): void {
    for (const listener of this.gone) listener();
  }

  destroy(): void {
    for (const listener of this.closed) listener();
  }
}

/** The close intercept over `windows`, on macOS, with the registry's other windows irrelevant. */
function interceptOver(windows: VoiceLiveWindows): {
  readonly closer: CloseToTray;
  readonly hidden: string[];
} {
  const hidden: string[] = [];
  const closer = new CloseToTray({
    platform: "darwin",
    hasTray: () => Promise.resolve(false),
    isQuitting: () => false,
    readQuitMode: () => Promise.resolve("background"),
    windows: {
      isLive: () => true,
      otherOpenWindowCount: () => 0,
      otherHiddenWindowCount: () => 0,
      hide: (windowId) => {
        hidden.push(windowId);
      },
      close: () => undefined,
    },
    requestQuit: () => undefined,
    showNoticeOnce: () => undefined,
    voiceLive: (windowId) => windows.isLive(windowId),
  });
  return { closer, hidden };
}

describe("installVoiceLiveReset", () => {
  it("starts a new renderer idle, whatever an earlier one reported", () => {
    const windows = new VoiceLiveWindows();
    windows.set("w1", true);

    installVoiceLiveReset(new FakeWindow(), "w1", windows);

    expect(windows.isLive("w1")).toBe(false);
  });

  it("returns to idle when a navigation commits, a main-frame error page commits, the renderer goes, or the window is destroyed", () => {
    const windows = new VoiceLiveWindows();
    const window = new FakeWindow();
    installVoiceLiveReset(window, "w1", windows);

    windows.set("w1", true);
    window.commitNavigation();
    expect(windows.isLive("w1")).toBe(false);

    windows.set("w1", true);
    window.failLoad(false);
    expect(windows.isLive("w1")).toBe(true);
    window.failLoad(true);
    expect(windows.isLive("w1")).toBe(false);

    windows.set("w1", true);
    window.rendererGone();
    expect(windows.isLive("w1")).toBe(false);

    windows.set("w1", true);
    window.destroy();
    expect(windows.isLive("w1")).toBe(false);
  });

  it("keeps a live window's close a hide while only navigations that never commit have happened", () => {
    // A same-document navigation and a navigation the guard cancels raise no
    // commit event; the fake fires nothing for them, as Electron does, and
    // the document, its controller and its microphone are still there.
    const windows = new VoiceLiveWindows();
    const window = new FakeWindow();
    installVoiceLiveReset(window, "w1", windows);
    windows.set("w1", true);
    const { closer, hidden } = interceptOver(windows);
    const event = { prevented: 0, preventDefault: () => undefined };
    event.preventDefault = () => {
      event.prevented += 1;
    };

    expect(closer.interceptClose("w1", event)).toBe(true);
    expect(event.prevented).toBe(1);
    expect(hidden).toEqual(["w1"]);

    // Once a document commits, the same close is an ordinary macOS close.
    window.commitNavigation();
    const later = { prevented: 0, preventDefault: () => undefined };
    expect(closer.interceptClose("w1", later)).toBe(false);
    expect(later.prevented).toBe(0);
  });
});
