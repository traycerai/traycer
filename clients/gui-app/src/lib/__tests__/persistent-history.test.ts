import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistentMemoryHistory } from "../persistent-history";

function storageKey(windowId: string): string {
  return `traycer-gui-app:last-route:${windowId}`;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
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
});
