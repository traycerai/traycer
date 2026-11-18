import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetEpicParkingForTests,
  isEpicParked,
} from "@/lib/epics/epic-parking";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
// Importing the module is enough to run its side effects - no render needed.
// Deliberately NOT importing "@/lib/epics/epic-parking-open-tabs" directly:
// this file exists to prove `TopLevelTabHost` is what wires the open-tab
// mirror into parking, so the only way it can see that mirror is through
// this import. Removing the shell's side-effect import must redden this.
import "@/components/layout/top-level-tab-host";

/**
 * Renderer parking's open-tab mirror (`epic-parking-open-tabs.ts`) only runs
 * once something imports it. In production that is a side-effect import in
 * `TopLevelTabHost` - the retention pool itself, since it is what unmounts a
 * hidden tab's surface past `retainedTopLevelSurfaces` and leaves the tab's
 * session warm. Every other test in this suite imports the mirror directly
 * (or transitively through other production wiring), so none of them would
 * catch that one import line being deleted from the shell - the app would
 * break and nothing here would redden. This test's only production import is
 * `TopLevelTabHost` itself, so it is the one pin that actually depends on the
 * shell doing the wiring.
 */
describe("TopLevelTabHost wires renderer parking's open-tab mirror", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    vi.useRealTimers();
  });

  it("parks a tab opened hidden, once TopLevelTabHost has been imported", () => {
    const EPIC = "epic-shell-wires-parking-mirror";
    const TAB = "tab-shell-wires-parking-mirror";
    useEpicCanvasStore.getState().openEpicTabWithId(TAB, EPIC, EPIC);
    try {
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      useEpicCanvasStore.getState().closeTab(TAB);
    }
  });
});
