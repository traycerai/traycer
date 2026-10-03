import {
  createMemoryHistory,
  type RouterHistory,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistentMemoryHistory,
  getHistoryController,
  type PersistentHistoryController,
} from "../persistent-history";
import {
  cancelDeferredJsonWrites,
  flushDeferredJsonWrite,
} from "@/lib/persist/deferred-json-storage";

function storageKey(windowId: string): string {
  return `traycer-gui-app:last-route:${windowId}`;
}

// Serialization is now debounced ~100ms after each navigation; call this
// before a disk assertion to materialize whatever is currently pending,
// mirroring the app's own pagehide/beforeunload/hidden lifecycle flush.
function flushHistory(windowId: string): void {
  flushDeferredJsonWrite(storageKey(windowId));
}

function controllerOf(history: RouterHistory): PersistentHistoryController {
  const controller = getHistoryController(history);
  if (controller === null) {
    throw new Error("expected a branded persistent-history controller");
  }
  return controller;
}

interface PersistedSnapshot {
  readonly entries: ReadonlyArray<string>;
  readonly index: number;
}

function readPersisted(windowId: string): PersistedSnapshot | null {
  const raw = window.localStorage.getItem(storageKey(windowId));
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entries" in parsed) ||
    !("index" in parsed)
  ) {
    throw new Error("unexpected persisted shape");
  }
  const { entries, index } = parsed;
  if (
    !Array.isArray(entries) ||
    !entries.every((entry): entry is string => typeof entry === "string") ||
    typeof index !== "number"
  ) {
    throw new Error("unexpected persisted shape");
  }
  return { entries, index };
}

/**
 * Builds a stack on a fresh window via real navigation. The shell override seeds
 * the first entry; each `push` appends one. Returns the branded history with the
 * cursor at the last entry.
 */
function seedStack(
  windowId: string,
  entries: ReadonlyArray<string>,
): RouterHistory {
  const [first, ...rest] = entries;
  const history = createPersistentMemoryHistory(first, windowId);
  rest.forEach((href) => history.push(href));
  return history;
}

function readEntryKeyOf(state: unknown): string {
  if (typeof state !== "object" || state === null) {
    throw new Error("expected a location state object");
  }
  if (!("__TSR_key" in state) || typeof state.__TSR_key !== "string") {
    throw new Error("expected a stamped __TSR_key");
  }
  return state.__TSR_key;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  // A test that pushes/replaces without an explicit flush leaves a write
  // queued in the shared deferred-json-storage module (a singleton keyed by
  // storage key, not reset by clearing localStorage above). Left alone, the
  // NEXT test's `createPersistentMemoryHistory` would auto-flush it via
  // `loadPersistedState` and read back a stale prior test's stack.
  cancelDeferredJsonWrites();
});

describe("createPersistentMemoryHistory", () => {
  it("treats bare landing as an explicit shell override", () => {
    window.localStorage.setItem(
      storageKey("window-a"),
      JSON.stringify({ entries: ["/epics/epic-a/tab-a"], index: 0 }),
    );

    const history = createPersistentMemoryHistory("/", "window-a");
    expect(history.location.pathname).toBe("/");
    expect(window.localStorage.getItem(storageKey("window-a"))).toBeNull();
  });

  it("keeps explicit epic initial routes as shell overrides", () => {
    window.localStorage.setItem(
      storageKey("window-a"),
      JSON.stringify({ entries: ["/epics/epic-a/tab-a"], index: 0 }),
    );

    const history = createPersistentMemoryHistory(
      "/epics/epic-b/tab-b",
      "window-a",
    );

    expect(history.location.pathname).toBe("/epics/epic-b/tab-b");
  });

  it("restores remembered history for the current window when no shell route is provided", () => {
    window.localStorage.setItem(
      storageKey("window-a"),
      JSON.stringify({ entries: ["/epics/epic-a/tab-a"], index: 0 }),
    );
    window.localStorage.setItem(
      storageKey("window-b"),
      JSON.stringify({ entries: ["/epics/epic-b/tab-b"], index: 0 }),
    );

    const history = createPersistentMemoryHistory(null, "window-b");

    expect(history.location.pathname).toBe("/epics/epic-b/tab-b");
  });

  it("does not read global remembered history when the window id is unavailable", () => {
    window.localStorage.setItem(
      "traycer-gui-app:last-route",
      JSON.stringify({ entries: ["/epics/epic-a/tab-a"], index: 0 }),
    );

    const history = createPersistentMemoryHistory(null, null);

    expect(history.location.pathname).toBe("/");
  });

  it("uses explicit shell routes only once so reload keeps the current draft route", () => {
    const firstBoot = createPersistentMemoryHistory(
      "/epics/epic-a/tab-a",
      "window-a",
    );
    firstBoot.push("/draft/draft-a", {
      __TSR_index: 1,
      key: "draft-a",
      __TSR_key: "draft-a",
    });

    const reload = createPersistentMemoryHistory(
      "/epics/epic-a/tab-a",
      "window-a",
    );

    expect(reload.location.pathname).toBe("/draft/draft-a");
  });

  it("uses explicit draft restore routes only once so reload keeps later navigation", () => {
    const firstBoot = createPersistentMemoryHistory(
      "/draft/draft-a",
      "window-a",
    );
    firstBoot.push("/epics/epic-a/tab-a", {
      __TSR_index: 1,
      key: "epic-a",
      __TSR_key: "epic-a",
    });

    const reload = createPersistentMemoryHistory("/draft/draft-a", "window-a");

    expect(reload.location.pathname).toBe("/epics/epic-a/tab-a");
  });

  it("uses explicit landing routes only once so reload keeps later navigation", () => {
    const firstBoot = createPersistentMemoryHistory("/", "window-a");
    firstBoot.push("/draft/draft-a", {
      __TSR_index: 1,
      key: "draft-a",
      __TSR_key: "draft-a",
    });

    const reload = createPersistentMemoryHistory("/", "window-a");

    expect(reload.location.pathname).toBe("/draft/draft-a");
  });

  it("keeps shell overrides when no window id can back remembered history", () => {
    const firstBoot = createPersistentMemoryHistory("/draft/draft-a", null);
    const reload = createPersistentMemoryHistory("/draft/draft-a", null);

    expect(firstBoot.location.pathname).toBe("/draft/draft-a");
    expect(reload.location.pathname).toBe("/draft/draft-a");
  });

  it("keeps shell overrides when session storage cannot record consumption", () => {
    const setItem = vi
      .spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });

    try {
      const firstBoot = createPersistentMemoryHistory(
        "/draft/draft-a",
        "window-a",
      );
      const reload = createPersistentMemoryHistory(
        "/draft/draft-a",
        "window-a",
      );

      expect(firstBoot.location.pathname).toBe("/draft/draft-a");
      expect(reload.location.pathname).toBe("/draft/draft-a");
    } finally {
      setItem.mockRestore();
    }
  });

  it("scopes consumed shell routes by window id", () => {
    createPersistentMemoryHistory("/draft/shared", "window-a");

    const secondWindow = createPersistentMemoryHistory(
      "/draft/shared",
      "window-b",
    );

    expect(secondWindow.location.pathname).toBe("/draft/shared");
  });

  it("preserves the full remembered stack and cursor on a cold restore whose shell override matches the current entry", () => {
    // Simulates the Bug 2 cold restore: a full quit wiped sessionStorage (so the
    // consumed-marker is absent and the override applies), and main derives the
    // initial route from the SAME snapshot the stack was persisted under - so the
    // override equals the persisted current entry. The deep back/forward history
    // must survive rather than collapse to a single entry.
    const entries = [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
      "/draft/draft-a",
      "/epics/epic-c/tab-c",
      "/draft/draft-b",
      "/epics/epic-d/tab-d",
      "/draft/552a2b55",
    ];
    window.localStorage.setItem(
      storageKey("window-a"),
      JSON.stringify({ entries, index: 6 }),
    );

    const history = createPersistentMemoryHistory(
      "/draft/552a2b55",
      "window-a",
    );
    const controller = controllerOf(history);

    expect(controller.getEntries()).toEqual(entries);
    expect(controller.getIndex()).toBe(6);
    expect(history.location.pathname).toBe("/draft/552a2b55");
    flushHistory("window-a");
    expect(readPersisted("window-a")).toEqual({ entries, index: 6 });
  });

  it("appends the shell override and truncates forward history when it differs from the current entry", () => {
    // Cursor sits back-deep in the stack; the override is a route not equal to
    // the current entry. It is treated like a fresh navigation: forward entries
    // are dropped, the override is appended, and back history up to the previous
    // current entry survives.
    window.localStorage.setItem(
      storageKey("window-a"),
      JSON.stringify({
        entries: [
          "/epics/epic-a/tab-a",
          "/epics/epic-b/tab-b",
          "/epics/epic-c/tab-c",
          "/epics/epic-d/tab-d",
        ],
        index: 1,
      }),
    );

    const history = createPersistentMemoryHistory("/draft/draft-z", "window-a");
    const controller = controllerOf(history);

    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
      "/draft/draft-z",
    ]);
    expect(controller.getIndex()).toBe(2);
    expect(history.location.pathname).toBe("/draft/draft-z");
  });

  it("caps an oversized remembered stack around the cursor when the override matches the current entry", () => {
    // A legacy/oversized persisted stack (200 entries) whose cursor is the tail.
    // The matching override keeps the full stack, then `capStackInPlace` bounds
    // it to MAX_ENTRIES around the cursor without dropping the current entry.
    const oversized = Array.from(
      { length: 200 },
      (_unused, i) => `/epics/epic-${i}/tab-${i}`,
    );
    const current = oversized[oversized.length - 1];
    window.localStorage.setItem(
      storageKey("window-a"),
      JSON.stringify({ entries: oversized, index: oversized.length - 1 }),
    );

    const history = createPersistentMemoryHistory(current, "window-a");
    const controller = controllerOf(history);

    expect(controller.getEntries().length).toBe(100);
    expect(controller.getEntries()[controller.getIndex()]).toBe(current);
    expect(history.location.pathname).toBe(current);
  });

  it("seeds the override alone on a fresh window with nothing remembered", () => {
    const history = createPersistentMemoryHistory(
      "/epics/epic-a/tab-a",
      "window-a",
    );
    const controller = controllerOf(history);

    expect(controller.getEntries()).toEqual(["/epics/epic-a/tab-a"]);
    expect(controller.getIndex()).toBe(0);
  });

  // The mobile app's whole persistence contract, stated as behavior rather than
  // as trust in the two null-window early returns that implement it. A refusal
  // is easy to relax by accident - a default window id, a "harmless" per-install
  // key - and nothing else in this file would notice.
  describe("a null window is the session-scoped mobile stack", () => {
    it("writes nothing while the session navigates", () => {
      const history = createPersistentMemoryHistory(null, null);
      history.push("/epics/epic-a/tab-a");
      history.push("/settings/general");
      history.push("/history");

      const controller = controllerOf(history);
      // The stack is REAL - this is not passing because nothing happened.
      expect(controller.getIndex()).toBe(3);
      expect(controller.getEntries()).toEqual([
        "/",
        "/epics/epic-a/tab-a",
        "/settings/general",
        "/history",
      ]);
      // Not "no last-route key" - NO key. A write under any name is a write
      // that a later cold start could learn to read.
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    });

    it("starts the next launch with nothing behind it", () => {
      const first = createPersistentMemoryHistory(null, null);
      first.push("/epics/epic-a/tab-a");
      first.push("/settings/general");
      expect(controllerOf(first).getIndex()).toBe(2);

      // A cold launch: the shell builds a second history from the same
      // arguments. It must not inherit the first one's stack - a restored one
      // would hand the launch's first back swipe a surface from the last
      // sitting.
      const next = createPersistentMemoryHistory(null, null);
      const controller = controllerOf(next);

      expect(next.location.pathname).toBe("/");
      expect(controller.getEntries()).toEqual(["/"]);
      expect(controller.getIndex()).toBe(0);
      expect(next.canGoBack()).toBe(false);
    });

    // The contrast that makes the two cases above mean something: the SAME
    // constructor, one argument different, does remember.
    it("still restores a window that has an id", () => {
      const first = createPersistentMemoryHistory(null, "window-a");
      first.push("/epics/epic-a/tab-a");

      const next = createPersistentMemoryHistory(null, "window-a");

      expect(next.location.pathname).toBe("/epics/epic-a/tab-a");
    });
  });
});

describe("getHistoryController", () => {
  it("brands persistent histories and exposes a controller", () => {
    const history = createPersistentMemoryHistory(
      "/epics/epic-a/tab-a",
      "window-a",
    );

    expect(getHistoryController(history)).not.toBeNull();
  });

  it("leaves memory/browser histories unbranded (feature inert)", () => {
    const memory = createMemoryHistory({ initialEntries: ["/"] });

    expect(getHistoryController(memory)).toBeNull();
  });
});

describe("PersistentHistoryController", () => {
  it("reports the live stack and cursor", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/draft/draft-a",
      "/epics/epic-b/tab-b",
    ]);
    const controller = controllerOf(history);

    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/draft/draft-a",
      "/epics/epic-b/tab-b",
    ]);
    expect(controller.getIndex()).toBe(2);
  });

  it("derives canGoBack/canGoForward from the cursor over the stack", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
      "/epics/epic-c/tab-c",
    ]);
    const controller = controllerOf(history);

    expect(controller.canGoBack()).toBe(true);
    expect(controller.canGoForward()).toBe(false);

    history.back();
    expect(controller.canGoBack()).toBe(true);
    expect(controller.canGoForward()).toBe(true);

    history.back();
    expect(controller.canGoBack()).toBe(false);
    expect(controller.canGoForward()).toBe(true);
  });

  it("keeps the current entry's identity when a prune collapses it into an earlier duplicate", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/draft/dead-draft",
      "/epics/epic-a/tab-a",
    ]);
    const controller = controllerOf(history);
    const currentKey = readEntryKeyOf(history.location.state);

    const changed = controller.prune((href) => href === "/draft/dead-draft");

    expect(changed).toBe(true);
    expect(controller.getEntries()).toEqual(["/epics/epic-a/tab-a"]);
    expect(controller.getIndex()).toBe(0);
    // The prune is load-free, so the router's cached location keeps carrying
    // the CURRENT entry's key. The collapsed survivor must carry the same one
    // - a survivor wearing the earlier duplicate's key would strand everything
    // filed against the cached identity.
    expect(controller.getEntryKeys()).toEqual([currentKey]);
  });

  it("prunes dead non-current entries and remaps the cursor", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/draft/dead-draft",
      "/epics/epic-b/tab-b",
    ]);
    const controller = controllerOf(history);

    const changed = controller.prune((href) => href === "/draft/dead-draft");

    expect(changed).toBe(true);
    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
    ]);
    expect(controller.getIndex()).toBe(1);
    expect(history.location.pathname).toBe("/epics/epic-b/tab-b");
  });

  it("never prunes the current entry, even when it is dead", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
    ]);
    const controller = controllerOf(history);

    // Current is `/epics/epic-b/tab-b`; predicate marks every entry dead.
    const changed = controller.prune(() => true);

    expect(changed).toBe(true);
    expect(controller.getEntries()).toEqual(["/epics/epic-b/tab-b"]);
    expect(controller.getIndex()).toBe(0);
    expect(controller.canGoBack()).toBe(false);
    expect(controller.canGoForward()).toBe(false);
  });

  it("returns false and changes nothing when no entry is dead", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
    ]);
    const controller = controllerOf(history);

    const changed = controller.prune(() => false);

    expect(changed).toBe(false);
    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
    ]);
    expect(controller.getIndex()).toBe(1);
  });

  it("re-stamps __TSR_index contiguously so later go(n) lands correctly", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/draft/dead-1",
      "/epics/epic-b/tab-b",
      "/draft/dead-2",
      "/epics/epic-c/tab-c",
    ]);
    const controller = controllerOf(history);

    controller.prune((href) => href.startsWith("/draft/dead"));

    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
      "/epics/epic-c/tab-c",
    ]);
    expect(controller.getIndex()).toBe(2);

    // `prune` is load-free, so it does not refresh the history's cached
    // `location` (only a real `notify` does). The re-stamped, contiguous
    // `__TSR_index` lives in the internal states array and surfaces through
    // `getLocation()` on the next real navigation - exactly what a later
    // `go(n)` relies on. Walking the stack proves each position is re-stamped
    // to its array index.
    history.back();
    expect(controller.getIndex()).toBe(1);
    expect(history.location.pathname).toBe("/epics/epic-b/tab-b");
    expect(history.location.state.__TSR_index).toBe(1);

    history.back();
    expect(controller.getIndex()).toBe(0);
    expect(history.location.pathname).toBe("/epics/epic-a/tab-a");
    expect(history.location.state.__TSR_index).toBe(0);

    history.go(2);
    expect(controller.getIndex()).toBe(2);
    expect(history.location.pathname).toBe("/epics/epic-c/tab-c");
    expect(history.location.state.__TSR_index).toBe(2);
  });

  it("keeps __TSR_index contiguous when a push follows a load-free prune", () => {
    // Current is `/epics/epic-a/tab-a` at index 1.
    const history = seedStack("window-a", [
      "/draft/dead-back",
      "/epics/epic-a/tab-a",
    ]);
    const controller = controllerOf(history);

    // Drop the dead BACK entry: the cursor shifts 1 → 0. `prune` is load-free,
    // so TanStack's cached `location` still reports `__TSR_index` 1.
    controller.prune((href) => href === "/draft/dead-back");
    expect(controller.getEntries()).toEqual(["/epics/epic-a/tab-a"]);
    expect(controller.getIndex()).toBe(0);

    // Push WITHOUT an intervening real navigation. TanStack derives the pushed
    // `__TSR_index` from the stale cached location (1) → would stamp 2; the
    // restamp-on-push corrects it to the true tail index (1).
    history.push("/epics/epic-b/tab-b");
    expect(controller.getIndex()).toBe(1);
    expect(history.location.pathname).toBe("/epics/epic-b/tab-b");
    expect(history.location.state.__TSR_index).toBe(1);

    history.back();
    expect(history.location.pathname).toBe("/epics/epic-a/tab-a");
    expect(history.location.state.__TSR_index).toBe(0);
  });

  it("persists the pruned stack (and respects the cap)", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/draft/dead-draft",
      "/epics/epic-b/tab-b",
    ]);
    const controller = controllerOf(history);

    controller.prune((href) => href === "/draft/dead-draft");

    flushHistory("window-a");
    expect(readPersisted("window-a")).toEqual({
      entries: ["/epics/epic-a/tab-a", "/epics/epic-b/tab-b"],
      index: 1,
    });
  });

  it("notifies controller subscribers on prune and on navigation", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/draft/dead-draft",
      "/epics/epic-b/tab-b",
    ]);
    const controller = controllerOf(history);

    const onChange = vi.fn();
    const unsubscribe = controller.subscribe(onChange);

    history.back();
    expect(onChange).toHaveBeenCalledTimes(1);

    history.push("/epics/epic-c/tab-c");
    expect(onChange).toHaveBeenCalledTimes(2);

    controller.prune((href) => href === "/draft/dead-draft");
    expect(onChange).toHaveBeenCalledTimes(3);

    // A no-op prune does not fire.
    controller.prune(() => false);
    expect(onChange).toHaveBeenCalledTimes(3);

    unsubscribe();
    history.back();
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("prune is load-free: it never touches history.notify or history subscribers", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/draft/dead-draft",
      "/epics/epic-b/tab-b",
    ]);
    const controller = controllerOf(history);

    // The router's Transitioner subscribes `history.subscribe(router.load)`, so
    // any `history.notify()` would invoke this. Prune must never reach it.
    const routerLoad = vi.fn();
    history.subscribe(routerLoad);

    controller.prune((href) => href === "/draft/dead-draft");

    expect(routerLoad).not.toHaveBeenCalled();

    // Contrast: a real navigation DOES drive the router load path.
    history.back();
    expect(routerLoad).toHaveBeenCalled();
  });

  it("preserves the bare-`/` non-persistence rule across navigation", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
    ]);

    flushHistory("window-a");
    expect(readPersisted("window-a")).toEqual({
      entries: ["/epics/epic-a/tab-a", "/epics/epic-b/tab-b"],
      index: 1,
    });

    // Navigating onto the bare landing must not clobber the remembered route -
    // and must not even queue a write, so the earlier pending snapshot (had
    // it not already flushed above) would survive untouched too.
    history.push("/");

    flushHistory("window-a");
    expect(readPersisted("window-a")).toEqual({
      entries: ["/epics/epic-a/tab-a", "/epics/epic-b/tab-b"],
      index: 1,
    });
  });

  // `/when-you-quit` is a transient signed-out surface reached only by
  // the desktop's "Settings…" command while signed out. Persisting it would
  // reopen the app on that card at the next launch, exactly the failure the
  // bare-`/` rule above already prevents for the landing route.
  it("does not persist /when-you-quit, mirroring the bare-`/` rule", () => {
    const history = seedStack("window-a", ["/settings/general"]);

    flushHistory("window-a");
    expect(readPersisted("window-a")).toEqual({
      entries: ["/settings/general"],
      index: 0,
    });

    history.push("/when-you-quit");

    flushHistory("window-a");
    expect(readPersisted("window-a")).toEqual({
      entries: ["/settings/general"],
      index: 0,
    });
  });

  it("persists an ordinary neighbouring route", () => {
    const history = seedStack("window-a", ["/settings/general"]);

    history.push("/settings/host");

    flushHistory("window-a");
    expect(readPersisted("window-a")).toEqual({
      entries: ["/settings/general", "/settings/host"],
      index: 1,
    });
  });

  it("collapses an adjacent duplicate created by an in-place replace (no dead back step)", () => {
    // Mirrors the overlay bug: an overlay entry is PUSHED onto the same path it
    // sits over, then its search flag is cleared via `replace`, leaving an entry
    // byte-identical to the one behind it. Cursor sits on that entry, with a
    // forward entry ahead.
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
      "/epics/epic-b/tab-b?settingsOverlay=true",
      "/settings/general",
    ]);
    const controller = controllerOf(history);

    // Back onto the overlay entry, then strip the flag in place.
    history.back();
    expect(controller.getIndex()).toBe(2);

    history.replace("/epics/epic-b/tab-b");

    // The redundant duplicate is dropped; the forward entry shifts down.
    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
      "/settings/general",
    ]);
    expect(controller.getIndex()).toBe(1);
    expect(history.location.pathname).toBe("/epics/epic-b/tab-b");

    // Proof the dead step is gone: one `go(-1)` lands on a DIFFERENT href.
    history.back();
    expect(controller.getIndex()).toBe(0);
    expect(history.location.pathname).toBe("/epics/epic-a/tab-a");
    expect(history.location.state.__TSR_index).toBe(0);

    // And the shifted forward entry kept a contiguous `__TSR_index`.
    history.go(2);
    expect(controller.getIndex()).toBe(2);
    expect(history.location.pathname).toBe("/settings/general");
    expect(history.location.state.__TSR_index).toBe(2);
  });

  it("collapses an adjacent duplicate AHEAD created by an in-place replace (no dead forward step)", () => {
    // Mirrors a cold-load redirect: the current entry is replaced with a path
    // that already sits ONE STEP AHEAD in the stack (e.g. the guard
    // replacing a restored overlay entry with the tab route it redirects to,
    // when that tab route was already the next persisted entry).
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b?settingsOverlay=true",
      "/settings/general",
    ]);
    const controller = controllerOf(history);

    history.back();
    expect(controller.getIndex()).toBe(1);

    history.replace("/settings/general");

    // The forward duplicate is dropped; the cursor stays on the (now sole)
    // settings entry instead of leaving a dead forward step ahead of it.
    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/settings/general",
    ]);
    expect(controller.getIndex()).toBe(1);
    expect(controller.canGoForward()).toBe(false);
    expect(history.location.pathname).toBe("/settings/general");

    // Proof the dead step is gone: canGoForward is false, so a `go(1)` at the
    // boundary is a guarded no-op in the app's `goForward` helper - but the
    // controller-level state itself must already reflect no forward entry.
    expect(controller.getEntries().length).toBe(2);
  });

  it("keeps the replacement state (not the collapsed neighbour's) on a behind-collapse", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
      "/epics/epic-b/tab-b?settingsOverlay=true",
    ]);
    const controller = controllerOf(history);

    // Record the OLD state key of the entry the collapse will merge into.
    history.back();
    const oldNeighbourKey = history.location.state.key;
    history.forward();
    expect(controller.getIndex()).toBe(2);

    history.replace("/epics/epic-b/tab-b");

    // The neighbour was dropped and the just-replaced entry survived: the
    // surviving location carries the state THIS replace minted, not the old
    // neighbour's - matching the location TanStack caches after a replace.
    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
    ]);
    expect(controller.getIndex()).toBe(1);
    expect(history.location.state.key).not.toBe(oldNeighbourKey);
    expect(history.location.state.__TSR_index).toBe(1);
  });

  it("restamps __TSR_index contiguously after an ahead-collapse", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b?settingsOverlay=true",
      "/settings/general",
      "/epics/epic-c/tab-c",
    ]);
    const controller = controllerOf(history);

    history.go(-2);
    expect(controller.getIndex()).toBe(1);

    history.replace("/settings/general");

    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/settings/general",
      "/epics/epic-c/tab-c",
    ]);
    expect(controller.getIndex()).toBe(1);

    // Walk forward and back across the shifted tail entry; a stale
    // `__TSR_index` would land `go(n)` on the wrong array position.
    history.go(1);
    expect(controller.getIndex()).toBe(2);
    expect(history.location.pathname).toBe("/epics/epic-c/tab-c");
    expect(history.location.state.__TSR_index).toBe(2);

    history.back();
    expect(controller.getIndex()).toBe(1);
    expect(history.location.pathname).toBe("/settings/general");
    expect(history.location.state.__TSR_index).toBe(1);
  });

  it("collapses duplicates on BOTH sides of a single replace", () => {
    // Current entry sits between two neighbours that both become identical to
    // it once replaced - the whole run must collapse to a single entry.
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
      "/epics/epic-a/tab-a",
    ]);
    const controller = controllerOf(history);

    history.back();
    expect(controller.getIndex()).toBe(1);

    history.replace("/epics/epic-a/tab-a");

    expect(controller.getEntries()).toEqual(["/epics/epic-a/tab-a"]);
    expect(controller.getIndex()).toBe(0);
    expect(controller.canGoBack()).toBe(false);
    expect(controller.canGoForward()).toBe(false);
    expect(history.location.state.__TSR_index).toBe(0);
  });

  it("persists the collapsed stack after an ahead-deduping replace", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b?historyOverlay=true",
      "/epics/epic-b/tab-b",
    ]);
    const controller = controllerOf(history);

    history.back();
    expect(controller.getIndex()).toBe(1);

    history.replace("/epics/epic-b/tab-b");

    flushHistory("window-a");
    expect(readPersisted("window-a")).toEqual({
      entries: ["/epics/epic-a/tab-a", "/epics/epic-b/tab-b"],
      index: 1,
    });
  });

  it("persists the collapsed stack after a deduping replace", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
      "/epics/epic-b/tab-b?historyOverlay=true",
    ]);

    history.replace("/epics/epic-b/tab-b");

    flushHistory("window-a");
    expect(readPersisted("window-a")).toEqual({
      entries: ["/epics/epic-a/tab-a", "/epics/epic-b/tab-b"],
      index: 1,
    });
  });

  it("leaves a non-duplicating replace in place", () => {
    const history = seedStack("window-a", [
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
    ]);
    const controller = controllerOf(history);

    // Replacing with a path different from the neighbour must NOT collapse.
    history.replace("/epics/epic-c/tab-c");

    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/epics/epic-c/tab-c",
    ]);
    expect(controller.getIndex()).toBe(1);
    expect(history.location.pathname).toBe("/epics/epic-c/tab-c");
  });

  it("does not collapse the first entry on replace (nothing behind it)", () => {
    const history = seedStack("window-a", ["/epics/epic-a/tab-a"]);
    const controller = controllerOf(history);

    // Index 0 has no entry behind it; a replace to the same path is a plain
    // in-place rewrite, never a collapse.
    history.replace("/epics/epic-a/tab-a");

    expect(controller.getEntries()).toEqual(["/epics/epic-a/tab-a"]);
    expect(controller.getIndex()).toBe(0);
  });

  it("caps the persisted stack at MAX_ENTRIES", () => {
    const history = createPersistentMemoryHistory(
      "/epics/epic-0/tab-0",
      "window-a",
    );
    for (let i = 1; i <= 120; i++) {
      history.push(`/epics/epic-${i}/tab-${i}`);
    }

    flushHistory("window-a");
    const persisted = readPersisted("window-a");
    if (persisted === null) throw new Error("expected persisted stack");
    expect(persisted.entries.length).toBe(100);
    // The most-recent entry is retained at the capped cursor.
    expect(persisted.entries[persisted.index]).toBe("/epics/epic-120/tab-120");
  });

  it("persists the ACTUAL current entry when the stack overflows and the cursor is back-deep", () => {
    // Regression for the persist-cap mismatch: the in-memory stack is now
    // bounded at push time, so the cursor can never sit outside the retained
    // window. Walking to the oldest retained entry must persist THAT entry, not
    // a tail-anchored slice that silently dropped the user's location.
    const history = createPersistentMemoryHistory(
      "/epics/epic-0/tab-0",
      "window-a",
    );
    for (let i = 1; i <= 120; i++) {
      history.push(`/epics/epic-${i}/tab-${i}`);
    }
    const controller = controllerOf(history);
    expect(controller.getEntries().length).toBe(100);

    // Back all the way to the oldest retained entry.
    history.go(-(controller.getEntries().length - 1));
    expect(controller.getIndex()).toBe(0);
    const current = controller.getEntries()[0];
    expect(history.location.pathname).toBe(current);

    flushHistory("window-a");
    const persisted = readPersisted("window-a");
    if (persisted === null) throw new Error("expected persisted stack");
    expect(persisted.entries.length).toBe(100);
    expect(persisted.entries[persisted.index]).toBe(current);
  });

  describe("adjacent-duplicate collapse on prune", () => {
    it("collapses entries that become adjacent duplicates after a dead-entry prune (split -> close -> prune)", () => {
      const focusedTab =
        "/epics/epic-a/tab-a?focusPaneId=3f92d763&focusTileInstanceId=54fbf184";
      const splitPane = "/epics/epic-a/tab-a?focusPaneId=c2bd4f75";

      // Splitting an empty pane pushes a pane-only entry.
      const history = seedStack("window-a", [focusedTab, splitPane]);
      const controller = controllerOf(history);

      // Closing that pane re-derives the same fallback focus as the original
      // tab, so its push lands on an href byte-identical to `focusedTab` -
      // but it is not yet ADJACENT to it (the pane-only entry sits between).
      history.push(focusedTab);
      expect(controller.getEntries()).toEqual([
        focusedTab,
        splitPane,
        focusedTab,
      ]);
      expect(controller.getIndex()).toBe(2);

      // The eager liveness pruner kills the now-dead pane-only entry, which
      // makes the two `focusedTab` entries adjacent.
      const changed = controller.prune((href) => href === splitPane);

      expect(changed).toBe(true);
      expect(controller.getEntries()).toEqual([focusedTab]);
      expect(controller.getIndex()).toBe(0);
      expect(controller.canGoBack()).toBe(false);
      expect(controller.canGoForward()).toBe(false);
    });

    it("keeps back/forward free of dead clicks across a collapsed pair (current is the LATER duplicate)", () => {
      const history = seedStack("window-a", [
        "/epics/epic-z/tab-z",
        "/epics/epic-a/tab-a",
        "/draft/dead-pane",
      ]);
      const controller = controllerOf(history);

      // Land back on a duplicate of an earlier entry, with a dead entry
      // between them.
      history.push("/epics/epic-a/tab-a");
      expect(controller.getEntries()).toEqual([
        "/epics/epic-z/tab-z",
        "/epics/epic-a/tab-a",
        "/draft/dead-pane",
        "/epics/epic-a/tab-a",
      ]);
      expect(controller.getIndex()).toBe(3);

      const changed = controller.prune((href) => href === "/draft/dead-pane");

      expect(changed).toBe(true);
      expect(controller.getEntries()).toEqual([
        "/epics/epic-z/tab-z",
        "/epics/epic-a/tab-a",
      ]);
      expect(controller.getIndex()).toBe(1);
      expect(controller.canGoBack()).toBe(true);
      expect(controller.canGoForward()).toBe(false);

      // A real back step must land on a genuinely different location, not a
      // dead click that only moves the cursor.
      history.back();
      expect(controller.getIndex()).toBe(0);
      expect(history.location.pathname).toBe("/epics/epic-z/tab-z");
      expect(history.location.state.__TSR_index).toBe(0);

      history.go(1);
      expect(controller.getIndex()).toBe(1);
      expect(history.location.pathname).toBe("/epics/epic-a/tab-a");
      expect(history.location.state.__TSR_index).toBe(1);
    });

    it("collapses when the current entry is the EARLIER of two adjacent duplicates", () => {
      const history = seedStack("window-a", [
        "/epics/epic-a/tab-a",
        "/draft/dead-forward",
        "/epics/epic-a/tab-a",
      ]);
      const controller = controllerOf(history);

      // Step back onto the first occurrence; the duplicate and the dead
      // entry are now forward history.
      history.go(-2);
      expect(controller.getIndex()).toBe(0);

      const changed = controller.prune(
        (href) => href === "/draft/dead-forward",
      );

      expect(changed).toBe(true);
      expect(controller.getEntries()).toEqual(["/epics/epic-a/tab-a"]);
      expect(controller.getIndex()).toBe(0);
      expect(controller.canGoBack()).toBe(false);
      expect(controller.canGoForward()).toBe(false);
    });

    it("persists the collapsed stack", () => {
      const history = seedStack("window-a", [
        "/epics/epic-a/tab-a",
        "/draft/dead-pane",
      ]);
      history.push("/epics/epic-a/tab-a");

      const controller = controllerOf(history);
      controller.prune((href) => href === "/draft/dead-pane");

      flushHistory("window-a");
      expect(readPersisted("window-a")).toEqual({
        entries: ["/epics/epic-a/tab-a"],
        index: 0,
      });
    });

    it("returns true for a collapse-only prune when no entry is dead but the stack already has adjacent duplicates", () => {
      // Simulates a legacy persisted stack seeded directly (bypassing the
      // push/replace collapse guards), already carrying an adjacent
      // duplicate pair unrelated to any dead entry.
      window.localStorage.setItem(
        storageKey("window-a"),
        JSON.stringify({
          entries: [
            "/epics/epic-a/tab-a",
            "/epics/epic-x/tab-x",
            "/epics/epic-x/tab-x",
            "/epics/epic-b/tab-b",
          ],
          index: 3,
        }),
      );

      const history = createPersistentMemoryHistory(null, "window-a");
      const controller = controllerOf(history);
      expect(controller.getEntries()).toEqual([
        "/epics/epic-a/tab-a",
        "/epics/epic-x/tab-x",
        "/epics/epic-x/tab-x",
        "/epics/epic-b/tab-b",
      ]);
      expect(controller.getIndex()).toBe(3);

      // Nothing is dead - the collapse alone must still report a change.
      const changed = controller.prune(() => false);

      expect(changed).toBe(true);
      expect(controller.getEntries()).toEqual([
        "/epics/epic-a/tab-a",
        "/epics/epic-x/tab-x",
        "/epics/epic-b/tab-b",
      ]);
      expect(controller.getIndex()).toBe(2);
    });

    it("collapses a run of more than two adjacent duplicates into a single entry, current marker included", () => {
      window.localStorage.setItem(
        storageKey("window-a"),
        JSON.stringify({
          entries: [
            "/epics/epic-a/tab-a",
            "/epics/epic-a/tab-a",
            "/epics/epic-a/tab-a",
          ],
          index: 1,
        }),
      );

      const history = createPersistentMemoryHistory(null, "window-a");
      const controller = controllerOf(history);
      expect(controller.getIndex()).toBe(1);

      const changed = controller.prune(() => false);

      expect(changed).toBe(true);
      expect(controller.getEntries()).toEqual(["/epics/epic-a/tab-a"]);
      expect(controller.getIndex()).toBe(0);
      expect(controller.canGoBack()).toBe(false);
      expect(controller.canGoForward()).toBe(false);
    });

    it("is a no-op when no entry is dead and no adjacent duplicates exist", () => {
      const history = seedStack("window-a", [
        "/epics/epic-a/tab-a",
        "/epics/epic-b/tab-b",
      ]);
      const controller = controllerOf(history);

      const changed = controller.prune(() => false);

      expect(changed).toBe(false);
      expect(controller.getEntries()).toEqual([
        "/epics/epic-a/tab-a",
        "/epics/epic-b/tab-b",
      ]);
      expect(controller.getIndex()).toBe(1);
    });
  });

  describe("adjacent-duplicate collapse on pushState", () => {
    it("does not create a duplicate entry when the pushed href matches the cursor's entry", () => {
      const history = seedStack("window-a", [
        "/epics/epic-a/tab-a",
        "/epics/epic-b/tab-b",
      ]);
      const controller = controllerOf(history);

      history.push("/epics/epic-b/tab-b");

      expect(controller.getEntries()).toEqual([
        "/epics/epic-a/tab-a",
        "/epics/epic-b/tab-b",
      ]);
      expect(controller.getIndex()).toBe(1);
      expect(history.location.pathname).toBe("/epics/epic-b/tab-b");
      expect(history.location.state.__TSR_index).toBe(1);

      flushHistory("window-a");
      expect(readPersisted("window-a")).toEqual({
        entries: ["/epics/epic-a/tab-a", "/epics/epic-b/tab-b"],
        index: 1,
      });
    });

    it("does not create a duplicate entry when pushing the same href as the very first entry", () => {
      const history = seedStack("window-a", ["/epics/epic-a/tab-a"]);
      const controller = controllerOf(history);

      history.push("/epics/epic-a/tab-a");

      expect(controller.getEntries()).toEqual(["/epics/epic-a/tab-a"]);
      expect(controller.getIndex()).toBe(0);
      expect(history.location.state.__TSR_index).toBe(0);
    });

    it("does not create a duplicate when pushing onto a truncated tail at a mid-stack index", () => {
      const history = seedStack("window-a", [
        "/epics/epic-a/tab-a",
        "/epics/epic-b/tab-b",
        "/epics/epic-c/tab-c",
      ]);
      const controller = controllerOf(history);

      // Walk back to the middle entry, then push its own href again - the
      // forward entry gets truncated as usual, and the push must land on the
      // (now-tail) existing entry rather than duplicating it.
      history.back();
      expect(controller.getIndex()).toBe(1);

      history.push("/epics/epic-b/tab-b");

      expect(controller.getEntries()).toEqual([
        "/epics/epic-a/tab-a",
        "/epics/epic-b/tab-b",
      ]);
      expect(controller.getIndex()).toBe(1);
      expect(controller.canGoForward()).toBe(false);
      expect(history.location.pathname).toBe("/epics/epic-b/tab-b");
      expect(history.location.state.__TSR_index).toBe(1);
    });

    it("still pushes a new entry when the href differs from the cursor's entry", () => {
      const history = seedStack("window-a", ["/epics/epic-a/tab-a"]);
      const controller = controllerOf(history);

      history.push("/epics/epic-b/tab-b");

      expect(controller.getEntries()).toEqual([
        "/epics/epic-a/tab-a",
        "/epics/epic-b/tab-b",
      ]);
      expect(controller.getIndex()).toBe(1);
    });
  });
});

describe("debounced persistence", () => {
  it("keeps in-memory navigation and back/forward immediate while the disk write stays pending", () => {
    const history = createPersistentMemoryHistory(
      "/epics/epic-a/tab-a",
      "window-a",
    );
    const controller = controllerOf(history);
    flushHistory("window-a");

    history.push("/epics/epic-b/tab-b");

    // Every in-memory read reflects the new location immediately - no flush
    // required.
    expect(controller.getEntries()).toEqual([
      "/epics/epic-a/tab-a",
      "/epics/epic-b/tab-b",
    ]);
    expect(controller.getIndex()).toBe(1);
    expect(controller.canGoBack()).toBe(true);
    expect(history.location.pathname).toBe("/epics/epic-b/tab-b");

    // The disk write is still the PRE-push snapshot - nothing has flushed yet.
    expect(readPersisted("window-a")).toEqual({
      entries: ["/epics/epic-a/tab-a"],
      index: 0,
    });

    history.back();

    expect(controller.getIndex()).toBe(0);
    expect(controller.canGoBack()).toBe(false);
    expect(history.location.pathname).toBe("/epics/epic-a/tab-a");
    // Still the same stale disk snapshot from before either navigation.
    expect(readPersisted("window-a")).toEqual({
      entries: ["/epics/epic-a/tab-a"],
      index: 0,
    });
  });

  function fireLifecycleFlushTrigger(
    trigger: "pagehide" | "beforeunload" | "hidden",
  ): void {
    if (trigger === "hidden") {
      const visibilityStateSpy = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("hidden");
      try {
        document.dispatchEvent(new Event("visibilitychange"));
      } finally {
        visibilityStateSpy.mockRestore();
      }
      return;
    }
    window.dispatchEvent(new Event(trigger));
  }

  it.each(["pagehide", "beforeunload", "hidden"] as const)(
    "flushes the latest pending write on %s, not an intermediate one",
    (trigger) => {
      const history = createPersistentMemoryHistory(
        "/epics/epic-a/tab-a",
        "window-a",
      );
      flushHistory("window-a");

      history.push("/epics/epic-b/tab-b");
      history.push("/epics/epic-c/tab-c");
      expect(readPersisted("window-a")).toEqual({
        entries: ["/epics/epic-a/tab-a"],
        index: 0,
      });

      fireLifecycleFlushTrigger(trigger);

      expect(readPersisted("window-a")).toEqual({
        entries: [
          "/epics/epic-a/tab-a",
          "/epics/epic-b/tab-b",
          "/epics/epic-c/tab-c",
        ],
        index: 2,
      });
    },
  );

  it("flushes on its own after the real debounce timer elapses, with no explicit flush or lifecycle event", () => {
    vi.useFakeTimers();
    try {
      const history = createPersistentMemoryHistory(
        "/epics/epic-a/tab-a",
        "window-a",
      );
      flushHistory("window-a");

      history.push("/epics/epic-b/tab-b");
      expect(readPersisted("window-a")).toEqual({
        entries: ["/epics/epic-a/tab-a"],
        index: 0,
      });

      vi.advanceTimersByTime(99);
      expect(readPersisted("window-a")).toEqual({
        entries: ["/epics/epic-a/tab-a"],
        index: 0,
      });

      vi.advanceTimersByTime(1);
      expect(readPersisted("window-a")).toEqual({
        entries: ["/epics/epic-a/tab-a", "/epics/epic-b/tab-b"],
        index: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes only this window's key on history.destroy()", () => {
    const historyA = createPersistentMemoryHistory(
      "/epics/epic-a/tab-a",
      "window-a",
    );
    const historyB = createPersistentMemoryHistory(
      "/epics/epic-b/tab-b",
      "window-b",
    );
    flushHistory("window-a");
    flushHistory("window-b");

    historyA.push("/draft/draft-a");
    historyB.push("/draft/draft-b");

    historyA.destroy();

    expect(readPersisted("window-a")).toEqual({
      entries: ["/epics/epic-a/tab-a", "/draft/draft-a"],
      index: 1,
    });
    // The other window's write is untouched by A's destroy.
    expect(readPersisted("window-b")).toEqual({
      entries: ["/epics/epic-b/tab-b"],
      index: 0,
    });

    flushHistory("window-b");
  });

  it("reads pending state on a cold reload even before the debounce timer or a lifecycle flush fires", () => {
    // `loadPersistedState` (called at construction) flushes this window's
    // key itself, so a second history built for the same window sees the
    // first one's still-pending write without any explicit flush.
    const firstBoot = createPersistentMemoryHistory(
      "/epics/epic-a/tab-a",
      "window-a",
    );
    flushHistory("window-a");
    firstBoot.push("/draft/draft-a");

    const reload = createPersistentMemoryHistory(
      "/epics/epic-a/tab-a",
      "window-a",
    );

    expect(reload.location.pathname).toBe("/draft/draft-a");
  });

  // A same-document localStorage write never fires `storage`; only a peer
  // window does, so the event is built by hand.
  it.each([
    {
      label: "a peer's replacement of this window's key",
      peer: () => {
        const snapshot = { entries: ["/epics/epic-a/tab-peer"], index: 0 };
        window.localStorage.setItem(
          storageKey("window-a"),
          JSON.stringify(snapshot),
        );
        return { key: storageKey("window-a"), expected: snapshot };
      },
    },
    {
      label: "a peer's clear-all",
      peer: () => {
        window.localStorage.clear();
        return { key: null, expected: null };
      },
    },
  ])(
    "a queued write does not survive $label, on debounce flush or destroy()",
    ({ peer }) => {
      const history = createPersistentMemoryHistory(
        "/epics/epic-a/tab-a",
        "window-a",
      );
      flushHistory("window-a");
      history.push("/draft/draft-a");

      const { key, expected } = peer();
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          storageArea: window.localStorage,
        }),
      );

      flushHistory("window-a");
      expect(readPersisted("window-a")).toEqual(expected);
      history.destroy();
      expect(readPersisted("window-a")).toEqual(expected);
    },
  );

  it("keeps a queued write when the event names another key or another storage area", () => {
    const history = createPersistentMemoryHistory(
      "/epics/epic-a/tab-a",
      "window-a",
    );
    flushHistory("window-a");
    history.push("/draft/draft-a");

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey("window-b"),
        storageArea: window.localStorage,
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey("window-a"),
        storageArea: window.sessionStorage,
      }),
    );

    history.destroy();
    expect(readPersisted("window-a")).toEqual({
      entries: ["/epics/epic-a/tab-a", "/draft/draft-a"],
      index: 1,
    });
  });
});
