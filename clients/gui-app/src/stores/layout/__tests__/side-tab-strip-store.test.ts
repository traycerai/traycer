import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  SIDE_STRIP_DEFAULT_WIDTH_PX,
  SIDE_STRIP_MAX_WIDTH_PX,
  SIDE_STRIP_MIN_WIDTH_PX,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import {
  useSideStripCollapsed,
  useSideTabStripStore,
} from "@/stores/layout/side-tab-strip-store";

const KEY = persistKey(STORE_KEYS.sideTabStrip);

function writeRecord(state: unknown): void {
  window.localStorage.setItem(KEY, JSON.stringify({ state, version: 1 }));
}

function snapshot(): { widthPx: number; collapsed: boolean } {
  const { widthPx, collapsed } = useSideTabStripStore.getState();
  return { widthPx, collapsed };
}

beforeEach(() => {
  window.localStorage.clear();
  useSideTabStripStore.setState({
    widthPx: SIDE_STRIP_DEFAULT_WIDTH_PX,
    collapsed: false,
    dragCollapsed: null,
  });
});

afterEach(() => {
  window.localStorage.clear();
  useSideTabStripStore.setState({
    widthPx: SIDE_STRIP_DEFAULT_WIDTH_PX,
    collapsed: false,
    dragCollapsed: null,
  });
});

describe("writes", () => {
  it.each([
    { name: "keeps a width inside the range", widthPx: 300, stored: 300 },
    {
      name: "clamps to the minimum",
      widthPx: 100,
      stored: SIDE_STRIP_MIN_WIDTH_PX,
    },
    {
      name: "clamps to the maximum",
      widthPx: 900,
      stored: SIDE_STRIP_MAX_WIDTH_PX,
    },
    {
      name: "resolves NaN to the default",
      widthPx: Number.NaN,
      stored: SIDE_STRIP_DEFAULT_WIDTH_PX,
    },
    {
      name: "resolves Infinity to the default",
      widthPx: Number.POSITIVE_INFINITY,
      stored: SIDE_STRIP_DEFAULT_WIDTH_PX,
    },
  ])("setWidthPx $name", ({ widthPx, stored }) => {
    useSideTabStripStore.getState().setWidthPx(widthPx);
    expect(useSideTabStripStore.getState().widthPx).toBe(stored);
  });

  it("persists width and collapsed state", () => {
    useSideTabStripStore.getState().setWidthPx(320);
    useSideTabStripStore.getState().setCollapsed(true);
    const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "");
    expect(stored).toMatchObject({ state: { widthPx: 320, collapsed: true } });
  });
});

describe("dragCollapsed (F9)", () => {
  it("excludes dragCollapsed from what is persisted", () => {
    useSideTabStripStore.getState().setDragCollapsed(true);

    const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "");
    expect(stored).toMatchObject({
      state: { widthPx: SIDE_STRIP_DEFAULT_WIDTH_PX, collapsed: false },
    });
    const storedState = (stored as { state: Record<string, unknown> }).state;
    expect("dragCollapsed" in storedState).toBe(false);
  });

  it("useSideStripCollapsed prefers dragCollapsed while set, and falls back to collapsed", () => {
    const { result } = renderHook(() => useSideStripCollapsed());
    expect(result.current).toBe(false);

    act(() => {
      useSideTabStripStore.getState().setDragCollapsed(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      // A stored `collapsed` write underneath a live drag has no visible
      // effect until the drag clears - dragCollapsed still wins.
      useSideTabStripStore.getState().setCollapsed(true);
      useSideTabStripStore.getState().setDragCollapsed(false);
    });
    expect(result.current).toBe(false);

    act(() => {
      useSideTabStripStore.getState().setDragCollapsed(null);
    });
    // Falls back to the stored `collapsed`, written above.
    expect(result.current).toBe(true);
  });
});

describe("rehydrate", () => {
  it("clamps an out-of-range persisted width", async () => {
    writeRecord({ widthPx: 1200, collapsed: true });
    await useSideTabStripStore.persist.rehydrate();
    expect(snapshot()).toEqual({
      widthPx: SIDE_STRIP_MAX_WIDTH_PX,
      collapsed: true,
    });
  });

  it.each([
    { name: "a junk record", record: { widthPx: "wide", collapsed: "yes" } },
    { name: "a non-object record", record: "junk" },
  ])("resolves $name to the defaults", async ({ record }) => {
    useSideTabStripStore.setState({ widthPx: 300, collapsed: true });
    writeRecord(record);
    await useSideTabStripStore.persist.rehydrate();
    expect(snapshot()).toEqual({
      widthPx: SIDE_STRIP_DEFAULT_WIDTH_PX,
      collapsed: false,
    });
  });

  it("picks up another window's write from a storage event", async () => {
    writeRecord({ widthPx: 280, collapsed: true });
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    await expect
      .poll(() => snapshot())
      .toEqual({ widthPx: 280, collapsed: true });
  });
});
