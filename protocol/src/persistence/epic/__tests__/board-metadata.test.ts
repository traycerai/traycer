/**
 * Contract of `setBoardMetadata`: it patches the presentation fields of a
 * board that already exists. It must never turn a stale UI write into a board
 * (the file owns which boards exist), and an absent field in the patch means
 * "leave it alone", not "clear it".
 *
 * Self-contained per the protocol-test convention (no cross-workspace
 * fixture imports).
 */
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  applyCanvasJson,
  canvasJsonV1Schema,
  openCanvasLayout,
  readCanvasLayout,
  setBoardFrame,
  setBoardMetadata,
  type CanvasLayoutHandle,
} from "@traycer/protocol/persistence/epic/canvas-layout";

const BOARD_A = "boards/a.html";
const BOARD_B = "boards/b.html";
const MISSING_BOARD = "boards/missing.html";

interface Replica {
  doc: Y.Doc;
  layout: CanvasLayoutHandle;
}

function replicaWithTwoBoards(): Replica {
  const doc = new Y.Doc();
  const layout = openCanvasLayout(doc, "artifact-1");
  const file = canvasJsonV1Schema.parse({
    v: 1,
    title: "Study",
    pages: [],
    boards: {
      [BOARD_A]: {
        x: 10,
        y: 20,
        w: 1280,
        h: 800,
        title: "Home",
        is_interactive: false,
        radius: 4,
      },
      [BOARD_B]: { x: 1400, y: 20, w: 640, h: 480 },
    },
    notes: {},
    order: [BOARD_A, BOARD_B],
  });
  doc.transact(() => {
    applyCanvasJson(layout, file, { protectedBoardPaths: [], baseline: null });
  });
  return { doc, layout };
}

describe("setBoardMetadata", () => {
  it("writes the supplied fields onto the board", () => {
    const { doc, layout } = replicaWithTwoBoards();
    doc.transact(() => {
      setBoardMetadata(layout, BOARD_A, {
        title: "Landing",
        is_interactive: true,
        radius: 12,
      });
    });
    expect(readCanvasLayout(layout).boards[BOARD_A]).toMatchObject({
      title: "Landing",
      is_interactive: true,
      radius: 12,
    });
  });

  it("ignores undefined keys instead of clearing the stored value", () => {
    const { doc, layout } = replicaWithTwoBoards();
    doc.transact(() => {
      setBoardMetadata(layout, BOARD_A, {
        title: undefined,
        is_interactive: true,
        radius: undefined,
      });
    });
    expect(readCanvasLayout(layout).boards[BOARD_A]).toMatchObject({
      title: "Home",
      is_interactive: true,
      radius: 4,
    });
  });

  it("is a no-op when every key is undefined", () => {
    const { doc, layout } = replicaWithTwoBoards();
    const before = readCanvasLayout(layout);
    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    doc.transact(() => {
      setBoardMetadata(layout, BOARD_A, {
        title: undefined,
        is_interactive: undefined,
        radius: undefined,
      });
    });
    expect(updates).toBe(0);
    expect(readCanvasLayout(layout)).toEqual(before);
  });

  it("does not write when the value already matches", () => {
    const { doc, layout } = replicaWithTwoBoards();
    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    doc.transact(() => {
      setBoardMetadata(layout, BOARD_A, {
        title: "Home",
        is_interactive: false,
        radius: 4,
      });
    });
    expect(updates).toBe(0);
  });

  it("preserves the frame and the board order", () => {
    const { doc, layout } = replicaWithTwoBoards();
    doc.transact(() => {
      setBoardMetadata(layout, BOARD_A, {
        title: "Landing",
        is_interactive: undefined,
        radius: 0,
      });
    });
    const snapshot = readCanvasLayout(layout);
    expect(snapshot.boards[BOARD_A]).toMatchObject({
      x: 10,
      y: 20,
      w: 1280,
      h: 800,
    });
    expect(snapshot.order).toEqual([BOARD_A, BOARD_B]);
  });

  it("does not disturb the frame written by setBoardFrame afterwards", () => {
    const { doc, layout } = replicaWithTwoBoards();
    doc.transact(() => {
      setBoardMetadata(layout, BOARD_B, {
        title: "Details",
        is_interactive: undefined,
        radius: undefined,
      });
      setBoardFrame(layout, BOARD_B, { x: 1, y: 2, w: 3, h: 4 });
    });
    expect(readCanvasLayout(layout).boards[BOARD_B]).toMatchObject({
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      title: "Details",
    });
  });

  it("leaves other boards untouched", () => {
    const { doc, layout } = replicaWithTwoBoards();
    const untouched = readCanvasLayout(layout).boards[BOARD_B];
    doc.transact(() => {
      setBoardMetadata(layout, BOARD_A, {
        title: "Landing",
        is_interactive: true,
        radius: 9,
      });
    });
    expect(readCanvasLayout(layout).boards[BOARD_B]).toEqual(untouched);
  });

  it("does not resurrect a board that is not in the layout", () => {
    const { doc, layout } = replicaWithTwoBoards();
    doc.transact(() => {
      setBoardMetadata(layout, MISSING_BOARD, {
        title: "Ghost",
        is_interactive: true,
        radius: 8,
      });
    });
    const snapshot = readCanvasLayout(layout);
    expect(Object.keys(snapshot.boards)).toEqual([BOARD_A, BOARD_B]);
    expect(snapshot.order).toEqual([BOARD_A, BOARD_B]);
    expect(layout.boards.has(MISSING_BOARD)).toBe(false);
  });
});
