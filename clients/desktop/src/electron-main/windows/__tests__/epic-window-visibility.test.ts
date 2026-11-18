import { describe, expect, it } from "vitest";
import { EpicWindowVisibility } from "../epic-window-visibility";

describe("EpicWindowVisibility", () => {
  it("emits only on a real change to a window's reported set", () => {
    const visibility = new EpicWindowVisibility();
    const changes: unknown[] = [];
    visibility.on("change", (entries) => changes.push(entries));

    visibility.report("window-a", ["epic-1", "epic-2"]);
    expect(changes.length).toBe(1);
    expect(visibility.snapshot()).toEqual([
      { windowId: "window-a", epicIds: ["epic-1", "epic-2"] },
    ]);

    // Same set, different order - still the same set, so no emission.
    visibility.report("window-a", ["epic-2", "epic-1"]);
    expect(changes.length).toBe(1);

    // Exact same set again - no emission.
    visibility.report("window-a", ["epic-1", "epic-2"]);
    expect(changes.length).toBe(1);

    // A genuinely different set replaces the row and emits.
    visibility.report("window-a", ["epic-3"]);
    expect(changes.length).toBe(2);
    expect(visibility.snapshot()).toEqual([
      { windowId: "window-a", epicIds: ["epic-3"] },
    ]);
  });

  it("removes a window's row entirely on an empty report", () => {
    const visibility = new EpicWindowVisibility();
    const changes: unknown[] = [];
    visibility.on("change", (entries) => changes.push(entries));

    visibility.report("window-a", ["epic-1"]);
    expect(changes.length).toBe(1);

    visibility.report("window-a", []);
    expect(changes.length).toBe(2);
    // The row is gone from the snapshot, not present with an empty array.
    expect(visibility.snapshot()).toEqual([]);

    // An empty report for a window with no existing row is a no-op - it was
    // already absent, so nothing changed.
    visibility.report("window-b", []);
    expect(changes.length).toBe(2);
    expect(visibility.snapshot()).toEqual([]);
  });

  it("retainWindows drops rows for windows outside the retained set and emits only when something is actually dropped", () => {
    const visibility = new EpicWindowVisibility();
    const changes: unknown[] = [];
    visibility.on("change", (entries) => changes.push(entries));

    visibility.report("window-a", ["epic-1"]);
    visibility.report("window-b", ["epic-2"]);
    expect(changes.length).toBe(2);

    // Retaining exactly the current windows changes nothing - no emission.
    visibility.retainWindows(new Set(["window-a", "window-b"]));
    expect(changes.length).toBe(2);

    // Dropping window-b's row.
    visibility.retainWindows(new Set(["window-a"]));
    expect(changes.length).toBe(3);
    expect(visibility.snapshot()).toEqual([
      { windowId: "window-a", epicIds: ["epic-1"] },
    ]);

    // Retaining a set with no matching rows left to drop - no-op, no emission.
    visibility.retainWindows(new Set(["window-a"]));
    expect(changes.length).toBe(3);
  });

  it("snapshot returns {windowId, epicIds}[] rows reflecting the current reports", () => {
    const visibility = new EpicWindowVisibility();

    expect(visibility.snapshot()).toEqual([]);

    visibility.report("window-a", ["epic-1", "epic-2"]);
    visibility.report("window-b", ["epic-3"]);

    const snapshot = visibility.snapshot();
    expect(snapshot).toEqual([
      { windowId: "window-a", epicIds: ["epic-1", "epic-2"] },
      { windowId: "window-b", epicIds: ["epic-3"] },
    ]);

    // The listener also receives exactly the snapshot shape on change.
    const received: unknown[] = [];
    visibility.on("change", (entries) => received.push(entries));
    visibility.report("window-a", ["epic-9"]);
    expect(received).toEqual([
      [
        { windowId: "window-a", epicIds: ["epic-9"] },
        { windowId: "window-b", epicIds: ["epic-3"] },
      ],
    ]);
  });

  it("off stops a listener from receiving further change events", () => {
    const visibility = new EpicWindowVisibility();
    const changes: unknown[] = [];
    const listener = (entries: unknown): void => {
      changes.push(entries);
    };

    visibility.on("change", listener);
    visibility.report("window-a", ["epic-1"]);
    expect(changes.length).toBe(1);

    visibility.off("change", listener);
    visibility.report("window-a", ["epic-2"]);
    expect(changes.length).toBe(1);
  });
});
