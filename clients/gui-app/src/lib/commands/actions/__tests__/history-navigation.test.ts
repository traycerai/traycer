import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryHistory,
  type RouterHistory,
} from "@tanstack/react-router";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import { goBack, goForward } from "@/lib/commands/actions/history-navigation";

const WINDOW_ID = "history-nav-action-test-window";

function storageKey(windowId: string): string {
  return `traycer-gui-app:last-route:${windowId}`;
}

// Seed a multi-entry persistent (branded) stack via localStorage so the history
// boots branded without firing any navigation notification.
function seedPersistentHistory(
  entries: ReadonlyArray<string>,
  index: number,
): RouterHistory {
  window.localStorage.setItem(
    storageKey(WINDOW_ID),
    JSON.stringify({ entries, index }),
  );
  return createPersistentMemoryHistory(null, WINDOW_ID);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("goBack / goForward", () => {
  it("no-op when the history carries no controller brand (browser/web)", () => {
    const history = createMemoryHistory({ initialEntries: ["/a", "/b"] });
    const goSpy = vi.spyOn(history, "go");

    goBack({ history });
    goForward({ history });

    expect(goSpy).not.toHaveBeenCalled();
  });

  it("calls go(-1) on the PASSED router's history when a controller reports canGoBack", () => {
    // index 1 of 2 entries → canGoBack() is true.
    const history = seedPersistentHistory(["/epics/e1/t1", "/draft/d1"], 1);
    const goSpy = vi.spyOn(history, "go");

    goBack({ history });

    expect(goSpy).toHaveBeenCalledTimes(1);
    expect(goSpy).toHaveBeenCalledWith(-1);
  });

  it("calls go(1) on the PASSED router's history when a controller reports canGoForward", () => {
    // index 0 of 2 entries → canGoForward() is true.
    const history = seedPersistentHistory(["/epics/e1/t1", "/draft/d1"], 0);
    const goSpy = vi.spyOn(history, "go");

    goForward({ history });

    expect(goSpy).toHaveBeenCalledTimes(1);
    expect(goSpy).toHaveBeenCalledWith(1);
  });

  it("no-op at the start boundary: goBack does NOT call go when canGoBack is false", () => {
    // index 0 → canGoBack() is false; a boundary go(-1) would notify and re-load
    // the current route for nothing.
    const history = seedPersistentHistory(["/epics/e1/t1", "/draft/d1"], 0);
    const goSpy = vi.spyOn(history, "go");

    goBack({ history });

    expect(goSpy).not.toHaveBeenCalled();
  });

  it("no-op at the end boundary: goForward does NOT call go when canGoForward is false", () => {
    // index 1 (last) → canGoForward() is false.
    const history = seedPersistentHistory(["/epics/e1/t1", "/draft/d1"], 1);
    const goSpy = vi.spyOn(history, "go");

    goForward({ history });

    expect(goSpy).not.toHaveBeenCalled();
  });
});
