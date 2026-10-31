import { describe, expect, it } from "vitest";
import {
  installVoiceLiveReset,
  VoiceLiveWindows,
  type VoiceLiveResetTarget,
} from "../voice-live-windows";

type NavigationListener = (details: { readonly isMainFrame: boolean }) => void;

/** A window whose renderer lifecycle the test fires by hand. */
class FakeWindow implements VoiceLiveResetTarget {
  private navigation: NavigationListener[] = [];
  private gone: Array<() => void> = [];
  private closed: Array<() => void> = [];
  readonly webContents = {
    on: (
      event: "did-start-navigation" | "render-process-gone",
      listener: NavigationListener | (() => void),
    ): void => {
      if (event === "did-start-navigation") {
        this.navigation.push(listener as NavigationListener);
      } else {
        this.gone.push(listener as () => void);
      }
    },
  };

  on(_event: "closed", listener: () => void): void {
    this.closed.push(listener);
  }

  startNavigation(isMainFrame: boolean): void {
    for (const listener of this.navigation) listener({ isMainFrame });
  }

  rendererGone(): void {
    for (const listener of this.gone) listener();
  }

  destroy(): void {
    for (const listener of this.closed) listener();
  }
}

describe("installVoiceLiveReset", () => {
  it("starts a new renderer idle, whatever an earlier one reported", () => {
    const windows = new VoiceLiveWindows();
    windows.set("w1", true);

    installVoiceLiveReset(new FakeWindow(), "w1", windows);

    expect(windows.isLive("w1")).toBe(false);
  });

  it("returns to idle when the main frame navigates, the renderer goes, or the window is destroyed; a subframe navigation keeps the flag", () => {
    const windows = new VoiceLiveWindows();
    const window = new FakeWindow();
    installVoiceLiveReset(window, "w1", windows);

    windows.set("w1", true);
    window.startNavigation(false);
    expect(windows.isLive("w1")).toBe(true);
    window.startNavigation(true);
    expect(windows.isLive("w1")).toBe(false);

    windows.set("w1", true);
    window.rendererGone();
    expect(windows.isLive("w1")).toBe(false);

    windows.set("w1", true);
    window.destroy();
    expect(windows.isLive("w1")).toBe(false);
  });
});
