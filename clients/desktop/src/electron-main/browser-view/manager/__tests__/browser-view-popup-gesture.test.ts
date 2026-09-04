import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  BROWSER_VIEW_POPUP_GESTURE_WINDOW_MS,
  trackBrowserViewPopupGesture,
} from "../browser-view-popup-gesture";

class FakeOpener extends EventEmitter {
  gesture(type: string): void {
    this.emit("input-event", {}, { type });
  }
}

describe("trackBrowserViewPopupGesture", () => {
  it("consumes a gesture observed inside the window", () => {
    let now = 1_000;
    const opener = new FakeOpener();
    const gesture = trackBrowserViewPopupGesture(opener, () => now);
    opener.gesture("mouseDown");
    now += BROWSER_VIEW_POPUP_GESTURE_WINDOW_MS;
    expect(gesture.consume()).toBe(true);
  });

  it("expires a gesture older than the window", () => {
    let now = 1_000;
    const opener = new FakeOpener();
    const gesture = trackBrowserViewPopupGesture(opener, () => now);
    opener.gesture("mouseDown");
    now += BROWSER_VIEW_POPUP_GESTURE_WINDOW_MS + 1;
    expect(gesture.consume()).toBe(false);
  });

  it("is single-use: one click cannot open two popups", () => {
    const now = 1_000;
    const opener = new FakeOpener();
    const gesture = trackBrowserViewPopupGesture(opener, () => now);
    opener.gesture("keyDown");
    expect(gesture.consume()).toBe(true);
    expect(gesture.consume()).toBe(false);
  });

  it("ignores non-activating input types", () => {
    const now = 1_000;
    const opener = new FakeOpener();
    const gesture = trackBrowserViewPopupGesture(opener, () => now);
    opener.gesture("mouseMove");
    expect(gesture.consume()).toBe(false);
  });

  it("never consumes without an observed gesture", () => {
    const opener = new FakeOpener();
    const gesture = trackBrowserViewPopupGesture(opener, () => 1_000);
    expect(gesture.consume()).toBe(false);
  });

  it("fails closed when the input stream is unobservable", () => {
    const opener = new FakeOpener();
    opener.on = (): never => {
      throw new Error("no input stream");
    };
    const gesture = trackBrowserViewPopupGesture(opener, () => 1_000);
    expect(gesture.consume()).toBe(false);
    gesture.dispose();
  });

  it("stops observing after dispose", () => {
    let now = 1_000;
    const opener = new FakeOpener();
    const gesture = trackBrowserViewPopupGesture(opener, () => now);
    gesture.dispose();
    opener.gesture("mouseDown");
    now += 1;
    expect(gesture.consume()).toBe(false);
    expect(opener.listenerCount("input-event")).toBe(0);
  });
});
