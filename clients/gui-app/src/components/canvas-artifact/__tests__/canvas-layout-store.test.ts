import { describe, expect, it, vi } from "vitest";
import {
  addPage,
  setBoardFrame,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import { storeFromFixture, type CanvasFixtureFile } from "./canvas-fixtures";
import type { CanvasLayoutStore } from "../canvas-layout-store";

const BOARD = "boards/a.html";
const OTHER_BOARD = "boards/b.html";

const file: CanvasFixtureFile = {
  pages: [{ id: "page-1", name: "Flow" }],
  boards: {
    [BOARD]: { x: 0, y: 0, w: 400, h: 300 },
    [OTHER_BOARD]: { x: 500, y: 0, w: 400, h: 300 },
  },
  notes: {},
  order: [BOARD, OTHER_BOARD],
};

function frameOf(store: CanvasLayoutStore, path: string): number {
  return store.getSnapshot().layout.boards[path].x ?? Number.NaN;
}

function writeRemotely(store: CanvasLayoutStore, write: () => void): void {
  store.doc.transact(write, "remote");
}

describe("CanvasLayoutStore undo", () => {
  it("undoes a local write and redoes it", () => {
    const store = storeFromFixture(file);
    store.subscribe(() => undefined);

    store.transact((layout) => {
      setBoardFrame(layout, BOARD, { x: 100, y: 0, w: 400, h: 300 });
    });
    expect(frameOf(store, BOARD)).toBe(100);
    expect(store.getSnapshot().canUndo).toBe(true);

    store.undo();
    expect(frameOf(store, BOARD)).toBe(0);
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().canRedo).toBe(true);

    store.redo();
    expect(frameOf(store, BOARD)).toBe(100);
  });

  it("does not track a remote write, so undo cannot revert a peer", () => {
    const store = storeFromFixture(file);
    store.subscribe(() => undefined);

    writeRemotely(store, () => {
      setBoardFrame(store.handle, BOARD, { x: 250, y: 0, w: 400, h: 300 });
    });
    expect(frameOf(store, BOARD)).toBe(250);
    expect(store.getSnapshot().canUndo).toBe(false);

    store.undo();
    expect(frameOf(store, BOARD)).toBe(250);
  });

  it("does not track a write that carries no origin", () => {
    const store = storeFromFixture(file);
    store.subscribe(() => undefined);

    store.doc.transact(() => {
      setBoardFrame(store.handle, BOARD, { x: 60, y: 0, w: 400, h: 300 });
    });
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it("undoes only the local write when a remote write landed in between", () => {
    const store = storeFromFixture(file);
    store.subscribe(() => undefined);

    store.transact((layout) => {
      setBoardFrame(layout, BOARD, { x: 100, y: 0, w: 400, h: 300 });
    });
    writeRemotely(store, () => {
      setBoardFrame(store.handle, OTHER_BOARD, {
        x: 900,
        y: 0,
        w: 400,
        h: 300,
      });
    });

    store.undo();
    expect(frameOf(store, BOARD)).toBe(0);
    expect(frameOf(store, OTHER_BOARD)).toBe(900);
  });

  it("undoes separate local transactions one at a time", () => {
    const store = storeFromFixture(file);
    store.subscribe(() => undefined);

    store.transact((layout) => {
      setBoardFrame(layout, BOARD, { x: 10, y: 0, w: 400, h: 300 });
    });
    store.transact((layout) => {
      setBoardFrame(layout, BOARD, { x: 20, y: 0, w: 400, h: 300 });
    });

    store.undo();
    expect(frameOf(store, BOARD)).toBe(10);
    store.undo();
    expect(frameOf(store, BOARD)).toBe(0);
  });

  it("undoes edits to the page root as well as to boards", () => {
    const store = storeFromFixture(file);
    store.subscribe(() => undefined);

    store.transact((layout) => {
      addPage(layout, "page-2", "Details", null);
    });
    expect(store.getSnapshot().layout.pages.map((page) => page.id)).toEqual([
      "page-1",
      "page-2",
    ]);

    store.undo();
    expect(store.getSnapshot().layout.pages.map((page) => page.id)).toEqual([
      "page-1",
    ]);
  });
});

describe("CanvasLayoutStore subscription", () => {
  it("notifies subscribers of local and remote changes", () => {
    const store = storeFromFixture(file);
    const notify = vi.fn();
    store.subscribe(notify);
    notify.mockClear();

    store.transact((layout) => {
      setBoardFrame(layout, BOARD, { x: 1, y: 0, w: 400, h: 300 });
    });
    expect(notify).toHaveBeenCalled();

    notify.mockClear();
    writeRemotely(store, () => {
      setBoardFrame(store.handle, OTHER_BOARD, { x: 2, y: 0, w: 400, h: 300 });
    });
    expect(notify).toHaveBeenCalled();
    expect(frameOf(store, OTHER_BOARD)).toBe(2);
  });

  it("stops notifying after unsubscribe", () => {
    const store = storeFromFixture(file);
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    unsubscribe();
    notify.mockClear();

    writeRemotely(store, () => {
      setBoardFrame(store.handle, BOARD, { x: 5, y: 0, w: 400, h: 300 });
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("starts with an empty history after the last view leaves and a new one mounts", () => {
    const store = storeFromFixture(file);
    const unsubscribe = store.subscribe(() => undefined);
    store.transact((layout) => {
      setBoardFrame(layout, BOARD, { x: 100, y: 0, w: 400, h: 300 });
    });
    unsubscribe();

    store.subscribe(() => undefined);
    expect(store.getSnapshot().canUndo).toBe(false);
    store.undo();
    expect(frameOf(store, BOARD)).toBe(100);
  });

  it("still applies a write made while nobody is subscribed", () => {
    const store = storeFromFixture(file);
    store.transact((layout) => {
      setBoardFrame(layout, BOARD, { x: 33, y: 0, w: 400, h: 300 });
    });
    expect(store.handle.boards.get(BOARD)).toBeDefined();
    store.subscribe(() => undefined);
    expect(frameOf(store, BOARD)).toBe(33);
    expect(store.getSnapshot().canUndo).toBe(false);
  });
});
