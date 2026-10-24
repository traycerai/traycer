/**
 * Contract of the canvas layout document: the Y.Map behind a canvas, its
 * projection to and from `canvas.json`, and the mutators the app and the host
 * use. The file is the agent's view, so the properties that matter are the
 * ones an agent or a second window can observe: a file edit lands only where
 * the file changed, unknown keys survive, and peers converge.
 *
 * Self-contained per the protocol-test convention (no cross-workspace
 * fixture imports).
 */
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import {
  addPage,
  applyCanvasJson,
  between,
  canvasJsonV1Schema,
  canvasLayoutBoardsKey,
  canvasLayoutNotesKey,
  canvasLayoutPagesKey,
  canvasLayoutRootKey,
  formatCanvasJson,
  moveBoardOrder,
  openCanvasLayout,
  projectCanvasJson,
  readCanvasLayout,
  removeNote,
  removePage,
  renamePage,
  setBoardFrame,
  setPageName,
  upsertNote,
  type CanvasJsonV1,
  type CanvasLayoutHandle,
} from "@traycer/protocol/persistence/epic/canvas-layout";

const BOARD_A = "boards/a.html";
const BOARD_B = "boards/b.html";
const BOARD_C = "boards/c.html";

interface Replica {
  doc: Y.Doc;
  map: CanvasLayoutHandle;
}

function newReplica(): Replica {
  const doc = new Y.Doc();
  return { doc, map: openCanvasLayout(doc, "artifact-1") };
}

function parseFile(raw: unknown): CanvasJsonV1 {
  return canvasJsonV1Schema.parse(raw);
}

function baseFile(): Record<string, unknown> {
  return {
    v: 1,
    title: "Study",
    pages: [
      { id: "page-1", name: "Flow" },
      { id: "page-2", name: "Details" },
    ],
    boards: {
      [BOARD_A]: { x: 0, y: 0, w: 1280, h: 800, title: "Home" },
      [BOARD_B]: { x: 1360, y: 0, w: 1280, h: 800, page: "page-2" },
      [BOARD_C]: { x: 0, y: 880, w: 640, h: 480 },
    },
    notes: {
      "note-1": { x: 10, y: 20, text: "start here" },
    },
    order: [BOARD_A, BOARD_B, BOARD_C],
  };
}

function withBoard(
  file: unknown,
  path: string,
  patch: Record<string, unknown>,
): unknown {
  const original = parseFile(file);
  const existing: unknown = original.boards?.[path];
  const merged = { ...(isRecord(existing) ? existing : {}), ...patch };
  return { ...original, boards: { ...original.boards, [path]: merged } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boardEntry(replica: Replica, path: string): Y.Map<unknown> {
  const entry: unknown = replica.map.boards.get(path);
  if (!(entry instanceof Y.Map)) {
    throw new Error(`no board entry for ${path}`);
  }
  return entry;
}

function applyFile(
  replica: Replica,
  file: unknown,
  baseline: unknown,
  protectedBoardPaths: readonly string[],
): void {
  replica.doc.transact(() => {
    applyCanvasJson(replica.map, parseFile(file), {
      protectedBoardPaths,
      baseline: baseline === null ? null : parseFile(baseline),
    });
  });
}

function applyWhole(replica: Replica, file: unknown): void {
  applyFile(replica, file, null, []);
}

function projected(replica: Replica): unknown {
  return JSON.parse(
    formatCanvasJson(projectCanvasJson(readCanvasLayout(replica.map))),
  );
}

function syncOneWay(from: Replica, to: Replica): void {
  Y.applyUpdate(
    to.doc,
    Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
    "remote",
  );
}

function sync(a: Replica, b: Replica): void {
  syncOneWay(a, b);
  syncOneWay(b, a);
}

function syncedPair(file: unknown): { a: Replica; b: Replica } {
  const a = newReplica();
  const b = newReplica();
  applyWhole(a, file);
  sync(a, b);
  return { a, b };
}

describe("canvasLayoutRootKey", () => {
  it("names the map after the artifact, so two canvases never share one", () => {
    expect(canvasLayoutRootKey("artifact-1")).toBe("canvas-layout:artifact-1");
    expect(canvasLayoutRootKey("artifact-2")).not.toBe(
      canvasLayoutRootKey("artifact-1"),
    );
  });

  it("gives each collection its own root map beside the scalar root", () => {
    const root = canvasLayoutRootKey("artifact-1");
    expect(canvasLayoutPagesKey("artifact-1")).toBe(`${root}:pages`);
    expect(canvasLayoutBoardsKey("artifact-1")).toBe(`${root}:boards`);
    expect(canvasLayoutNotesKey("artifact-1")).toBe(`${root}:notes`);
  });
});

describe("openCanvasLayout", () => {
  it("opens the same four maps of the document every time", () => {
    const doc = new Y.Doc();
    const first = openCanvasLayout(doc, "artifact-1");
    const second = openCanvasLayout(doc, "artifact-1");
    expect(second.root).toBe(first.root);
    expect(second.pages).toBe(first.pages);
    expect(second.boards).toBe(first.boards);
    expect(second.notes).toBe(first.notes);
    expect(doc.getMap(canvasLayoutBoardsKey("artifact-1"))).toBe(first.boards);
  });

  it("keeps two canvases in one document apart", () => {
    const doc = new Y.Doc();
    const one = openCanvasLayout(doc, "artifact-1");
    const two = openCanvasLayout(doc, "artifact-2");
    expect(two.boards).not.toBe(one.boards);
    expect(two.root).not.toBe(one.root);
  });
});

describe("canvasJsonV1Schema", () => {
  it("accepts an empty object, since every known key is optional", () => {
    expect(canvasJsonV1Schema.safeParse({}).success).toBe(true);
  });

  it("accepts a full file", () => {
    expect(canvasJsonV1Schema.safeParse(baseFile()).success).toBe(true);
  });

  it.each([
    ["a board x that is NaN", { boards: { [BOARD_A]: { x: Number.NaN } } }],
    [
      "a board width that is Infinity",
      { boards: { [BOARD_A]: { w: Number.POSITIVE_INFINITY } } },
    ],
    ["a board y that is a string", { boards: { [BOARD_A]: { y: "10" } } }],
    ["pages that is not a list", { pages: "nope" }],
    ["a title that is not a string", { title: 5 }],
  ])("rejects %s", (_label, raw) => {
    expect(canvasJsonV1Schema.safeParse(raw).success).toBe(false);
  });

  it("keeps unknown keys at the top level, on boards and on notes", () => {
    const result = canvasJsonV1Schema.parse({
      launch: "main",
      boards: { [BOARD_A]: { x: 1, y: 2, w: 3, h: 4, futureFlag: true } },
      notes: { n: { x: 0, y: 0, shapeKind: "oval" } },
    });
    expect(result).toMatchObject({
      launch: "main",
      boards: { [BOARD_A]: { futureFlag: true } },
      notes: { n: { shapeKind: "oval" } },
    });
  });
});

describe("formatCanvasJson", () => {
  it("writes the six known keys first in file order, then extra keys, with two-space indent and a trailing newline", () => {
    const text = formatCanvasJson(
      parseFile({
        zeta: 1,
        order: [BOARD_A],
        notes: {},
        boards: { [BOARD_A]: { x: 1, y: 2, w: 3, h: 4 } },
        pages: [{ id: "page-1", name: "One" }],
        title: "T",
        v: 1,
        alpha: 2,
      }),
    );
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text.startsWith('{\n  "v": 1,\n  "title": "T",\n  "pages": [')).toBe(
      true,
    );
    const topLevelKeys = Object.keys(JSON.parse(text));
    expect(topLevelKeys.slice(0, 6)).toEqual([
      "v",
      "title",
      "pages",
      "boards",
      "notes",
      "order",
    ]);
    expect(topLevelKeys.slice(6).sort()).toEqual(["alpha", "zeta"]);
  });

  it("is idempotent: formatting what it produced yields the same bytes", () => {
    const once = formatCanvasJson(parseFile(baseFile()));
    expect(formatCanvasJson(parseFile(JSON.parse(once)))).toBe(once);
  });
});

describe("readCanvasLayout of an empty map", () => {
  it("is an empty snapshot", () => {
    expect(readCanvasLayout(newReplica().map)).toMatchObject({
      pages: [],
      boards: {},
      notes: {},
      order: [],
    });
  });
});

describe("applying a whole file", () => {
  it("round-trips through the map to the same canonical file", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    expect(projected(replica)).toEqual(
      JSON.parse(formatCanvasJson(parseFile(baseFile()))),
    );
  });

  it("reads pages and order in the file's order", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    const snapshot = readCanvasLayout(replica.map);
    expect(snapshot.pages.map((page) => page.id)).toEqual(["page-1", "page-2"]);
    expect(snapshot.order).toEqual([BOARD_A, BOARD_B, BOARD_C]);
    expect(Object.keys(snapshot.boards).sort()).toEqual([
      BOARD_A,
      BOARD_B,
      BOARD_C,
    ]);
  });

  it("gives every board a position the projection then drops", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    const snapshot = readCanvasLayout(replica.map);
    expect(typeof snapshot.boards[BOARD_A]?.pos).toBe("string");
    expect(JSON.stringify(projected(replica))).not.toContain('"pos"');
  });

  it("removes a known field the file leaves out, and a board or page it drops", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    applyWhole(replica, {
      v: 1,
      title: "Study",
      pages: [{ id: "page-1", name: "Flow" }],
      boards: { [BOARD_A]: { x: 0, y: 0, w: 1280, h: 800 } },
      notes: {},
      order: [BOARD_A],
    });
    expect(projected(replica)).toMatchObject({
      pages: [{ id: "page-1", name: "Flow" }],
      boards: { [BOARD_A]: { x: 0, y: 0, w: 1280, h: 800 } },
      notes: {},
      order: [BOARD_A],
    });
    expect(JSON.stringify(projected(replica))).not.toContain("Home");
    expect(Object.keys(readCanvasLayout(replica.map).boards)).toEqual([
      BOARD_A,
    ]);
  });

  it("keeps a protected board the file no longer lists", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    applyFile(
      replica,
      { v: 1, boards: { [BOARD_A]: { x: 0, y: 0, w: 1280, h: 800 } } },
      null,
      [BOARD_B],
    );
    const paths = Object.keys(readCanvasLayout(replica.map).boards);
    expect(paths).toContain(BOARD_A);
    expect(paths).toContain(BOARD_B);
    expect(paths).not.toContain(BOARD_C);
  });

  it("retains unknown keys the file omits, while still removing omitted known ones", () => {
    const replica = newReplica();
    applyWhole(replica, {
      ...baseFile(),
      launch: "main",
      boards: {
        [BOARD_A]: { x: 0, y: 0, w: 1, h: 2, title: "Home", futureFlag: true },
      },
    });
    applyWhole(replica, {
      v: 1,
      boards: { [BOARD_A]: { x: 0, y: 0, w: 1, h: 2 } },
    });
    expect(projected(replica)).toMatchObject({
      launch: "main",
      boards: { [BOARD_A]: { futureFlag: true } },
    });
    expect(JSON.stringify(projected(replica))).not.toContain("Home");
  });

  it("is a no-op when the same file is applied again", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    const onUpdate = vi.fn();
    replica.doc.on("update", onUpdate);
    applyWhole(replica, baseFile());
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("applying a file against a baseline", () => {
  it("is a no-op when the file equals the baseline", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    const onUpdate = vi.fn();
    replica.doc.on("update", onUpdate);
    applyFile(replica, baseFile(), baseFile(), []);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("applies only what the file changed, keeping a peer's edit to another board", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    replica.doc.transact(() => {
      setBoardFrame(replica.map, BOARD_B, { x: 999, y: 1, w: 2, h: 3 });
    }, "peer");

    const edited = withBoard(baseFile(), BOARD_A, { x: 50 });
    applyFile(replica, edited, baseFile(), []);

    expect(projected(replica)).toMatchObject({
      boards: {
        [BOARD_A]: { x: 50 },
        [BOARD_B]: { x: 999, y: 1, w: 2, h: 3 },
      },
    });
  });

  it("without a baseline the same file overwrites the peer's edit", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    replica.doc.transact(() => {
      setBoardFrame(replica.map, BOARD_B, { x: 999, y: 1, w: 2, h: 3 });
    }, "peer");

    applyWhole(replica, withBoard(baseFile(), BOARD_A, { x: 50 }));

    expect(projected(replica)).toMatchObject({
      boards: { [BOARD_B]: { x: 1360, y: 0, w: 1280, h: 800 } },
    });
  });

  it("keeps a peer's edit to another field of the board the file changed", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    replica.doc.transact(() => {
      setBoardFrame(replica.map, BOARD_A, { x: 0, y: 700, w: 1280, h: 800 });
    }, "peer");

    applyFile(
      replica,
      withBoard(baseFile(), BOARD_A, { title: "Landing" }),
      baseFile(),
      [],
    );

    expect(projected(replica)).toMatchObject({
      boards: { [BOARD_A]: { y: 700, title: "Landing" } },
    });
  });

  it("lets the file win on the field both sides changed", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    replica.doc.transact(() => {
      setBoardFrame(replica.map, BOARD_A, { x: 10, y: 0, w: 1280, h: 800 });
    }, "peer");

    applyFile(
      replica,
      withBoard(baseFile(), BOARD_A, { x: 20 }),
      baseFile(),
      [],
    );

    expect(projected(replica)).toMatchObject({
      boards: { [BOARD_A]: { x: 20 } },
    });
  });

  it("adds a board the file added and removes one the file dropped", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    const withoutC = parseFile(baseFile());
    const { [BOARD_C]: _dropped, ...remaining } = withoutC.boards ?? {};
    const edited = {
      ...withoutC,
      boards: {
        ...remaining,
        "boards/d.html": { x: 5, y: 5, w: 10, h: 10 },
      },
      order: [BOARD_A, BOARD_B, "boards/d.html"],
    };

    applyFile(replica, edited, baseFile(), []);

    const paths = Object.keys(readCanvasLayout(replica.map).boards).sort();
    expect(paths).toEqual([BOARD_A, BOARD_B, "boards/d.html"]);
  });

  it("does not remove a dropped board that is protected", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    const withoutC = parseFile(baseFile());
    const { [BOARD_C]: _dropped, ...remaining } = withoutC.boards ?? {};

    applyFile(
      replica,
      { ...withoutC, boards: remaining, order: [BOARD_A, BOARD_B] },
      baseFile(),
      [BOARD_C],
    );

    expect(Object.keys(readCanvasLayout(replica.map).boards)).toContain(
      BOARD_C,
    );
  });

  it("removes a known field the file dropped relative to the baseline, and keeps an unknown field only a peer set", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    boardEntry(replica, BOARD_A).set("peerOnlyField", true);

    const edited = parseFile(baseFile());
    const original: unknown = edited.boards?.[BOARD_A];
    const { title: _title, ...stripped } = isRecord(original) ? original : {};
    applyFile(
      replica,
      { ...edited, boards: { ...edited.boards, [BOARD_A]: stripped } },
      baseFile(),
      [],
    );

    const board = (projected(replica) as { boards: Record<string, unknown> })
      .boards[BOARD_A];
    expect(board).not.toHaveProperty("title");
    expect(board).toHaveProperty("peerOnlyField", true);
  });

  it("removes an unknown field the baseline had and the file dropped", () => {
    const replica = newReplica();
    const baseline = withBoard(baseFile(), BOARD_A, { futureFlag: true });
    applyWhole(replica, baseline);

    applyFile(replica, baseFile(), baseline, []);

    const board = (projected(replica) as { boards: Record<string, unknown> })
      .boards[BOARD_A];
    expect(board).not.toHaveProperty("futureFlag");
  });

  it("resurrects an entry a peer deleted with all its fields, not only the one the file changed", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    const boards = replica.map.boards;
    replica.doc.transact(() => {
      boards.delete(BOARD_A);
    }, "peer");
    expect(Object.keys(readCanvasLayout(replica.map).boards)).not.toContain(
      BOARD_A,
    );

    applyFile(
      replica,
      withBoard(baseFile(), BOARD_A, { x: 50 }),
      baseFile(),
      [],
    );

    expect(projected(replica)).toMatchObject({
      boards: { [BOARD_A]: { x: 50, y: 0, w: 1280, h: 800, title: "Home" } },
    });
  });

  it("recreates a protected board a peer deleted, complete, even when the file equals the baseline", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    replica.doc.transact(() => {
      replica.map.boards.delete(BOARD_A);
    }, "peer");

    applyFile(replica, baseFile(), baseFile(), [BOARD_A]);

    expect(projected(replica)).toMatchObject({
      boards: { [BOARD_A]: { x: 0, y: 0, w: 1280, h: 800, title: "Home" } },
    });
  });

  describe.each([
    ["with a baseline", true],
    ["as a full apply", false],
  ])("when the file removes a page %s", (_label, withBaseline) => {
    function pagedFile(): Record<string, unknown> {
      return {
        v: 1,
        title: "Paged",
        pages: [
          { id: "page-1", name: "One" },
          { id: "page-2", name: "Two" },
          { id: "page-3", name: "Three" },
        ],
        boards: {
          [BOARD_A]: { x: 0, y: 0, w: 10, h: 10, page: "page-1" },
          [BOARD_B]: { x: 20, y: 0, w: 10, h: 10, page: "page-2" },
          [BOARD_C]: { x: 40, y: 0, w: 10, h: 10, page: "page-3" },
        },
        notes: {
          "note-on-two": { x: 0, y: 0, text: "two", page: "page-2" },
          "note-on-one": { x: 0, y: 0, text: "one", page: "page-1" },
        },
        order: [BOARD_A, BOARD_B, BOARD_C],
      };
    }

    function withoutPageTwo(
      keepDanglingRefs: boolean,
    ): Record<string, unknown> {
      const file = parseFile(pagedFile());
      const boards = { ...file.boards };
      const notes = { ...file.notes };
      if (!keepDanglingRefs) {
        boards[BOARD_B] = { x: 20, y: 0, w: 10, h: 10 };
        notes["note-on-two"] = { x: 0, y: 0, text: "two" };
      }
      return {
        ...file,
        pages: [
          { id: "page-1", name: "One" },
          { id: "page-3", name: "Three" },
        ],
        boards,
        notes,
      };
    }

    it.each([
      ["leaves the references to it dangling", true],
      ["also drops the references to it", false],
    ])(
      "and %s, no board or note keeps a reference to it",
      (_name, dangling) => {
        const replica = newReplica();
        applyWhole(replica, pagedFile());

        applyFile(
          replica,
          withoutPageTwo(dangling),
          withBaseline ? pagedFile() : null,
          [],
        );

        const snapshot = readCanvasLayout(replica.map);
        expect(snapshot.pages.map((page) => page.id)).toEqual([
          "page-1",
          "page-3",
        ]);
        expect(snapshot.boards[BOARD_B]?.page).toBeUndefined();
        expect(snapshot.notes["note-on-two"]?.page).toBeUndefined();
      },
    );

    it("keeps the references to pages that still exist", () => {
      const replica = newReplica();
      applyWhole(replica, pagedFile());

      applyFile(
        replica,
        withoutPageTwo(true),
        withBaseline ? pagedFile() : null,
        [],
      );

      const snapshot = readCanvasLayout(replica.map);
      expect(snapshot.boards[BOARD_A]?.page).toBe("page-1");
      expect(snapshot.boards[BOARD_C]?.page).toBe("page-3");
      expect(snapshot.notes["note-on-one"]?.page).toBe("page-1");
    });
  });

  it("renames a page and adds a page without touching a peer's other page", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    replica.doc.transact(() => {
      setPageName(replica.map, "page-2", "Peer name");
    }, "peer");

    const parsed = parseFile(baseFile());
    applyFile(
      replica,
      {
        ...parsed,
        pages: [
          { id: "page-1", name: "Renamed" },
          { id: "page-2", name: "Details" },
          { id: "page-3", name: "New" },
        ],
      },
      baseFile(),
      [],
    );

    const pages = readCanvasLayout(replica.map).pages;
    expect(pages.map((page) => [page.id, page.name])).toEqual([
      ["page-1", "Renamed"],
      ["page-2", "Peer name"],
      ["page-3", "New"],
    ]);
  });
});

describe("mutators", () => {
  it("setBoardFrame sets position and size and leaves the other fields", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());
    replica.doc.transact(() => {
      setBoardFrame(replica.map, BOARD_A, { x: 7, y: 8, w: 9, h: 10 });
    });
    expect(projected(replica)).toMatchObject({
      boards: { [BOARD_A]: { x: 7, y: 8, w: 9, h: 10, title: "Home" } },
    });
  });

  it("moveBoardOrder puts a board before another, or last when given null", () => {
    const replica = newReplica();
    applyWhole(replica, baseFile());

    replica.doc.transact(() => {
      moveBoardOrder(replica.map, BOARD_C, BOARD_A);
    });
    expect(readCanvasLayout(replica.map).order).toEqual([
      BOARD_C,
      BOARD_A,
      BOARD_B,
    ]);

    replica.doc.transact(() => {
      moveBoardOrder(replica.map, BOARD_C, null);
    });
    expect(readCanvasLayout(replica.map).order).toEqual([
      BOARD_A,
      BOARD_B,
      BOARD_C,
    ]);
  });

  it("addPage inserts before a page or at the end, and removePage drops it", () => {
    const replica = newReplica();
    replica.doc.transact(() => {
      addPage(replica.map, "p1", "One", null);
      addPage(replica.map, "p2", "Two", null);
      addPage(replica.map, "p0", "Zero", "p1");
    });
    expect(readCanvasLayout(replica.map).pages.map((p) => p.id)).toEqual([
      "p0",
      "p1",
      "p2",
    ]);

    replica.doc.transact(() => {
      removePage(replica.map, "p1");
    });
    expect(readCanvasLayout(replica.map).pages.map((p) => p.id)).toEqual([
      "p0",
      "p2",
    ]);
  });

  it("removePage keeps the final page", () => {
    const replica = newReplica();
    replica.doc.transact(() => {
      addPage(replica.map, "only", "Only", null);
      removePage(replica.map, "only");
    });
    expect(readCanvasLayout(replica.map).pages.map((p) => p.id)).toEqual([
      "only",
    ]);
  });

  it("removePage drops the page reference of boards and notes, which fall back to the first page", () => {
    const replica = newReplica();
    applyWhole(replica, {
      ...baseFile(),
      notes: { "note-1": { x: 1, y: 2, text: "on two", page: "page-2" } },
    });
    expect(readCanvasLayout(replica.map).boards[BOARD_B]?.page).toBe("page-2");

    replica.doc.transact(() => {
      removePage(replica.map, "page-2");
    });

    const snapshot = readCanvasLayout(replica.map);
    expect(snapshot.pages.map((p) => p.id)).toEqual(["page-1"]);
    expect(snapshot.boards[BOARD_B]).toBeDefined();
    expect(snapshot.boards[BOARD_B]?.page).toBeUndefined();
    expect(snapshot.notes["note-1"]?.page).toBeUndefined();
  });

  it("setPageName and renamePage both rename a page", () => {
    const replica = newReplica();
    replica.doc.transact(() => {
      addPage(replica.map, "p1", "One", null);
      setPageName(replica.map, "p1", "Uno");
    });
    expect(readCanvasLayout(replica.map).pages[0]?.name).toBe("Uno");

    replica.doc.transact(() => {
      renamePage(replica.map, "p1", "Eins");
    });
    expect(readCanvasLayout(replica.map).pages[0]?.name).toBe("Eins");
  });

  it("upsertNote creates and then replaces a note, and removeNote drops it", () => {
    const replica = newReplica();
    replica.doc.transact(() => {
      upsertNote(replica.map, "n1", { x: 1, y: 2, text: "first" });
    });
    expect(readCanvasLayout(replica.map).notes["n1"]).toMatchObject({
      x: 1,
      y: 2,
      text: "first",
    });

    replica.doc.transact(() => {
      upsertNote(replica.map, "n1", { x: 3, y: 4, text: "second" });
    });
    expect(readCanvasLayout(replica.map).notes["n1"]).toMatchObject({
      x: 3,
      y: 4,
      text: "second",
    });

    replica.doc.transact(() => {
      removeNote(replica.map, "n1");
    });
    expect(readCanvasLayout(replica.map).notes["n1"]).toBeUndefined();
  });
});

describe("between", () => {
  it("returns a rank strictly between two ranks", () => {
    const rank = between("a", "b");
    expect(rank > "a").toBe(true);
    expect(rank < "b").toBe(true);
  });

  it("returns a rank before the first and after the last when one side is null", () => {
    const first = between(null, "m");
    const last = between("m", null);
    expect(first < "m").toBe(true);
    expect(last > "m").toBe(true);
  });

  it("returns a usable rank when there are no neighbours", () => {
    expect(between(null, null).length).toBeGreaterThan(0);
  });

  it("stays ordered when inserting repeatedly into the same gap", () => {
    let low = between(null, null);
    const high = between(low, null);
    const inserted: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const next = between(low, high);
      expect(next > low).toBe(true);
      expect(next < high).toBe(true);
      inserted.push(next);
      low = next;
    }
    expect([...inserted].sort()).toEqual(inserted);
  });
});

describe("concurrent edits from two replicas", () => {
  it("gives pages added at the same spot distinct positions and the same order on both sides", () => {
    const { a, b } = syncedPair(baseFile());
    a.doc.transact(() => {
      addPage(a.map, "pa", "From A", null);
    });
    b.doc.transact(() => {
      addPage(b.map, "pb", "From B", null);
    });
    sync(a, b);

    const pagesA = readCanvasLayout(a.map).pages;
    const pagesB = readCanvasLayout(b.map).pages;
    expect(pagesA.map((page) => page.id).sort()).toEqual([
      "pa",
      "page-1",
      "page-2",
      "pb",
    ]);
    expect(pagesA).toEqual(pagesB);
    expect(new Set(pagesA.map((page) => page.pos)).size).toBe(4);
  });

  it("keeps every distinct board, note and page when two empty replicas build a layout at once", () => {
    const a = newReplica();
    const b = newReplica();
    applyWhole(a, {
      v: 1,
      title: "Study",
      pages: [{ id: "page-1", name: "Page 1" }],
      boards: { [BOARD_A]: { x: 0, y: 0, w: 1280, h: 800 } },
      notes: { "note-a": { x: 1, y: 2, text: "from a" } },
      order: [BOARD_A],
    });
    applyWhole(b, {
      v: 1,
      title: "Study",
      pages: [{ id: "page-1", name: "Page 1" }],
      boards: { [BOARD_B]: { x: 1360, y: 0, w: 1280, h: 800 } },
      notes: { "note-b": { x: 3, y: 4, text: "from b" } },
      order: [BOARD_B],
    });
    sync(a, b);

    for (const replica of [a, b]) {
      const snapshot = readCanvasLayout(replica.map);
      expect(Object.keys(snapshot.boards).sort()).toEqual([BOARD_A, BOARD_B]);
      expect(Object.keys(snapshot.notes).sort()).toEqual(["note-a", "note-b"]);
      expect(snapshot.pages.map((page) => page.id)).toEqual(["page-1"]);
      expect([...snapshot.order].sort()).toEqual([BOARD_A, BOARD_B]);
    }
    expect(readCanvasLayout(a.map)).toEqual(readCanvasLayout(b.map));
  });

  it("converges when two replicas reorder different boards", () => {
    const { a, b } = syncedPair(baseFile());
    a.doc.transact(() => {
      moveBoardOrder(a.map, BOARD_A, null);
    });
    b.doc.transact(() => {
      moveBoardOrder(b.map, BOARD_C, BOARD_A);
    });
    sync(a, b);

    const orderA = readCanvasLayout(a.map).order;
    expect(orderA).toEqual(readCanvasLayout(b.map).order);
    expect([...orderA].sort()).toEqual([BOARD_A, BOARD_B, BOARD_C]);
  });

  it("converges when two replicas reorder the same board", () => {
    const { a, b } = syncedPair(baseFile());
    a.doc.transact(() => {
      moveBoardOrder(a.map, BOARD_A, null);
    });
    b.doc.transact(() => {
      moveBoardOrder(b.map, BOARD_A, BOARD_B);
    });
    sync(a, b);

    const orderA = readCanvasLayout(a.map).order;
    expect(orderA).toEqual(readCanvasLayout(b.map).order);
    expect([...orderA].sort()).toEqual([BOARD_A, BOARD_B, BOARD_C]);
  });

  it("keeps both frames when two replicas move different boards", () => {
    const { a, b } = syncedPair(baseFile());
    a.doc.transact(() => {
      setBoardFrame(a.map, BOARD_A, { x: 1, y: 2, w: 3, h: 4 });
    });
    b.doc.transact(() => {
      setBoardFrame(b.map, BOARD_B, { x: 5, y: 6, w: 7, h: 8 });
    });
    sync(a, b);

    for (const replica of [a, b]) {
      expect(projected(replica)).toMatchObject({
        boards: {
          [BOARD_A]: { x: 1, y: 2, w: 3, h: 4 },
          [BOARD_B]: { x: 5, y: 6, w: 7, h: 8 },
        },
      });
    }
  });

  it("converges when two replicas move the same board", () => {
    const { a, b } = syncedPair(baseFile());
    a.doc.transact(() => {
      setBoardFrame(a.map, BOARD_A, { x: 1, y: 2, w: 3, h: 4 });
    });
    b.doc.transact(() => {
      setBoardFrame(b.map, BOARD_A, { x: 5, y: 6, w: 7, h: 8 });
    });
    sync(a, b);

    expect(projected(a)).toEqual(projected(b));
  });

  it("keeps both edits when two replicas change different fields of one board through the file", () => {
    const { a, b } = syncedPair(baseFile());
    applyFile(a, withBoard(baseFile(), BOARD_A, { x: 111 }), baseFile(), []);
    applyFile(b, withBoard(baseFile(), BOARD_A, { y: 222 }), baseFile(), []);
    sync(a, b);

    for (const replica of [a, b]) {
      expect(projected(replica)).toMatchObject({
        boards: { [BOARD_A]: { x: 111, y: 222 } },
      });
    }
  });

  it("converges when two replicas change the same field of one board through the file", () => {
    const { a, b } = syncedPair(baseFile());
    applyFile(a, withBoard(baseFile(), BOARD_A, { x: 111 }), baseFile(), []);
    applyFile(b, withBoard(baseFile(), BOARD_A, { x: 222 }), baseFile(), []);
    sync(a, b);

    expect(projected(a)).toEqual(projected(b));
    const x = (projected(a) as { boards: Record<string, { x: number }> })
      .boards[BOARD_A]?.x;
    expect([111, 222]).toContain(x);
  });
});
