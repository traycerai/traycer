import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDocumentVisibilitySubscribersForTests,
  __setBrowserDocumentHiddenForTests,
  setDesktopWindowOnScreen,
} from "@/lib/dom/document-visibility";
import {
  __resetVisibleIntervalWakeupsForTests,
  __visibleIntervalWakeupsForTests,
  startVisibleInterval,
} from "@/lib/dom/visible-interval";

beforeEach(() => {
  vi.useFakeTimers();
  __setBrowserDocumentHiddenForTests(false);
  setDesktopWindowOnScreen(true);
  __resetDocumentVisibilitySubscribersForTests();
  __resetVisibleIntervalWakeupsForTests();
});

afterEach(() => {
  __setBrowserDocumentHiddenForTests(false);
  setDesktopWindowOnScreen(true);
  __resetDocumentVisibilitySubscribersForTests();
  __resetVisibleIntervalWakeupsForTests();
  vi.useRealTimers();
});

describe("startVisibleInterval", () => {
  it("ticks on the interval while visible and records those wakeups", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval({
      tick,
      intervalMs: 250,
      fireOnShow: false,
    });

    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(__visibleIntervalWakeupsForTests()).toBe(4);

    stop();
  });

  it("records zero interval wakeups while the document is hidden", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval({
      tick,
      intervalMs: 250,
      fireOnShow: true,
    });
    vi.advanceTimersByTime(250);
    expect(__visibleIntervalWakeupsForTests()).toBe(1);

    __setBrowserDocumentHiddenForTests(true);
    const atHide = __visibleIntervalWakeupsForTests();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(__visibleIntervalWakeupsForTests()).toBe(atHide);

    stop();
  });

  it("records zero interval wakeups while the desktop window is off screen and Page Visibility stays visible", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval({
      tick,
      intervalMs: 250,
      fireOnShow: false,
    });
    expect(document.visibilityState).toBe("visible");

    setDesktopWindowOnScreen(false);
    vi.advanceTimersByTime(1000);
    expect(tick).not.toHaveBeenCalled();
    expect(__visibleIntervalWakeupsForTests()).toBe(0);

    stop();
  });

  it("does not fire immediately on start when already visible", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval({
      tick,
      intervalMs: 250,
      fireOnShow: true,
    });
    expect(tick).not.toHaveBeenCalled();
    expect(__visibleIntervalWakeupsForTests()).toBe(0);
    stop();
  });

  it("fires once on hide then show when fireOnShow is true, then restarts the interval from the show", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval({
      tick,
      intervalMs: 1000,
      fireOnShow: true,
    });

    vi.advanceTimersByTime(400);
    __setBrowserDocumentHiddenForTests(true);
    expect(tick).not.toHaveBeenCalled();

    __setBrowserDocumentHiddenForTests(false);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(__visibleIntervalWakeupsForTests()).toBe(1);

    vi.advanceTimersByTime(400);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600);
    expect(tick).toHaveBeenCalledTimes(2);

    stop();
  });

  it("does not fire on show when fireOnShow is false; it only restarts the interval", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval({
      tick,
      intervalMs: 250,
      fireOnShow: false,
    });
    __setBrowserDocumentHiddenForTests(true);
    __setBrowserDocumentHiddenForTests(false);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("starts on the first show when constructed while hidden", () => {
    __setBrowserDocumentHiddenForTests(true);
    const tick = vi.fn();
    const stop = startVisibleInterval({
      tick,
      intervalMs: 250,
      fireOnShow: true,
    });
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(tick).not.toHaveBeenCalled();

    __setBrowserDocumentHiddenForTests(false);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops ticking after dispose, including a later show", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval({
      tick,
      intervalMs: 250,
      fireOnShow: true,
    });
    stop();
    __setBrowserDocumentHiddenForTests(true);
    __setBrowserDocumentHiddenForTests(false);
    vi.advanceTimersByTime(1000);
    expect(tick).not.toHaveBeenCalled();
    expect(__visibleIntervalWakeupsForTests()).toBe(0);
  });
});
