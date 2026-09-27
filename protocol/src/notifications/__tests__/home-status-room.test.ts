import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  HOME_STATUS_MAP_KEY,
  HOME_STATUS_MAX_ROWS,
  HOME_STATUS_ROW_TTL_MS,
  HOME_STATUS_STALE_MS,
  type HomeStatusRow,
  getHomeStatusMap,
  isHomeStatusRowExpired,
  isHomeStatusRowStale,
  listPrunableHomeStatusKeys,
  pruneHomeStatusRows,
  readHomeStatusRows,
  readVisibleHomeStatusRows,
  removeHomeStatusRow,
  sortHomeStatusRows,
  writeHomeStatusRow,
} from "../home-status-room";

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function row(overrides: Partial<HomeStatusRow>): HomeStatusRow {
  return {
    key: "row",
    status: "in-progress",
    item: "Item",
    note: "",
    agentId: "agent-1",
    agentName: "Agent",
    epicId: "epic-1",
    hostId: "host-1",
    harnessId: "claude",
    updatedAt: NOW,
    ...overrides,
  };
}

function valueOf(r: HomeStatusRow): Omit<HomeStatusRow, "key"> {
  const { key: _key, ...value } = r;
  return value;
}

function exchange(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left);
  const rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
}

describe("home status room", () => {
  it("stores each row as a plain object under the map key", () => {
    const doc = new Y.Doc();
    const written = row({ key: "a", note: "see [#1](https://x/1)" });
    writeHomeStatusRow(doc, written, NOW);

    expect(doc.getMap(HOME_STATUS_MAP_KEY).get("a")).toEqual(valueOf(written));
    expect(readHomeStatusRows(doc)).toEqual([written]);
  });

  it("replaces the whole value on rewrite", () => {
    const doc = new Y.Doc();
    writeHomeStatusRow(doc, row({ key: "a", note: "old" }), NOW);
    writeHomeStatusRow(
      doc,
      row({ key: "a", status: "done", item: "New" }),
      NOW,
    );

    expect(readHomeStatusRows(doc)).toEqual([
      row({ key: "a", status: "done", item: "New" }),
    ]);
  });

  it("drops invalid rows instead of throwing, ignoring unknown fields", () => {
    const doc = new Y.Doc();
    writeHomeStatusRow(doc, row({ key: "good" }), NOW);
    const map = getHomeStatusMap(doc);
    map.set("scalar", "not a row");
    map.set("nested", new Y.Map<unknown>());
    map.set("bad-status", { ...valueOf(row({})), status: "blocked" });
    map.set("bad-time", { ...valueOf(row({})), updatedAt: -1 });
    map.set("long-item", { ...valueOf(row({})), item: "x".repeat(201) });
    map.set("extra", { ...valueOf(row({})), futureField: 1 });

    const rows = readHomeStatusRows(doc);
    expect(rows.map((r) => r.key).sort()).toEqual(["extra", "good"]);
    expect(rows.find((r) => r.key === "extra")).toEqual(row({ key: "extra" }));
  });

  it("reads a row written before harnessId existed, as a null harness", () => {
    const doc = new Y.Doc();
    const { harnessId: _harnessId, ...older } = valueOf(row({}));
    getHomeStatusMap(doc).set("older", older);

    expect(readHomeStatusRows(doc)).toEqual([
      row({ key: "older", harnessId: null }),
    ]);
  });

  it("reads an out-of-bound harnessId as null rather than dropping the row", () => {
    const doc = new Y.Doc();
    const map = getHomeStatusMap(doc);
    map.set("empty", { ...valueOf(row({})), harnessId: "" });
    map.set("number", { ...valueOf(row({})), harnessId: 7 });
    map.set("long", { ...valueOf(row({})), harnessId: "x".repeat(257) });

    const rows = readHomeStatusRows(doc);
    expect(rows.map((r) => [r.key, r.harnessId])).toEqual([
      ["empty", null],
      ["number", null],
      ["long", null],
    ]);
  });

  it("sorts needs-you, in-progress, done, then newest first", () => {
    const sorted = sortHomeStatusRows([
      row({ key: "d1", status: "done", updatedAt: NOW }),
      row({ key: "p-old", status: "in-progress", updatedAt: NOW - 10 }),
      row({ key: "n", status: "needs-you", updatedAt: NOW - 100 }),
      row({ key: "p-new", status: "in-progress", updatedAt: NOW }),
    ]);
    expect(sorted.map((r) => r.key)).toEqual(["n", "p-new", "p-old", "d1"]);
  });

  it("marks only in-progress rows stale past the threshold", () => {
    const old = NOW - HOME_STATUS_STALE_MS - 1;
    expect(isHomeStatusRowStale(row({ updatedAt: old }), NOW)).toBe(true);
    expect(
      isHomeStatusRowStale(row({ updatedAt: NOW - HOME_STATUS_STALE_MS }), NOW),
    ).toBe(false);
    expect(
      isHomeStatusRowStale(row({ status: "needs-you", updatedAt: old }), NOW),
    ).toBe(false);
    expect(
      isHomeStatusRowStale(row({ status: "done", updatedAt: old }), NOW),
    ).toBe(false);
  });

  it("expires any row after a week, done rows included, and none sooner", () => {
    const pastDay = NOW - DAY_MS - 1;
    const atWeek = NOW - HOME_STATUS_ROW_TTL_MS;
    const pastWeek = NOW - HOME_STATUS_ROW_TTL_MS - 1;
    for (const status of ["done", "needs-you", "in-progress"] as const) {
      expect(
        isHomeStatusRowExpired(row({ status, updatedAt: pastDay }), NOW),
      ).toBe(false);
      expect(
        isHomeStatusRowExpired(row({ status, updatedAt: atWeek }), NOW),
      ).toBe(false);
      expect(
        isHomeStatusRowExpired(row({ status, updatedAt: pastWeek }), NOW),
      ).toBe(true);
    }
  });

  it("prunes expired rows and provably old malformed rows, keeps unknown shapes", () => {
    const doc = new Y.Doc();
    const map = getHomeStatusMap(doc);
    map.set("fresh", valueOf(row({})));
    map.set(
      "day-old-done",
      valueOf(row({ status: "done", updatedAt: NOW - DAY_MS - 1 })),
    );
    map.set(
      "old-done",
      valueOf(
        row({ status: "done", updatedAt: NOW - HOME_STATUS_ROW_TTL_MS - 1 }),
      ),
    );
    map.set("old-malformed", {
      updatedAt: NOW - HOME_STATUS_ROW_TTL_MS - 1,
    });
    map.set("future-shape", { status: "blocked", updatedAt: NOW });

    expect(listPrunableHomeStatusKeys(doc, NOW, null).sort()).toEqual([
      "old-done",
      "old-malformed",
    ]);
    expect(pruneHomeStatusRows(doc, NOW)).toBe(2);
    expect([...map.keys()].sort()).toEqual([
      "day-old-done",
      "fresh",
      "future-shape",
    ]);
    expect(pruneHomeStatusRows(doc, NOW)).toBe(0);
  });

  it("prunes on write but never the row being written", () => {
    const doc = new Y.Doc();
    const expired = row({
      key: "k",
      status: "done",
      updatedAt: NOW - HOME_STATUS_ROW_TTL_MS - 1,
    });
    getHomeStatusMap(doc).set("stale-done", valueOf(expired));
    expect(writeHomeStatusRow(doc, expired, NOW)).toBe(1);
    expect([...getHomeStatusMap(doc).keys()]).toEqual(["k"]);
  });

  it("caps the board, evicting the oldest done rows before anything else", () => {
    const doc = new Y.Doc();
    const map = getHomeStatusMap(doc);
    for (let i = 0; i < HOME_STATUS_MAX_ROWS; i += 1) {
      map.set(`p${i}`, valueOf(row({ updatedAt: NOW - 1000 - i })));
    }
    map.set("d-old", valueOf(row({ status: "done", updatedAt: NOW - 10 })));
    map.set("d-new", valueOf(row({ status: "done", updatedAt: NOW - 5 })));

    // 202 existing + 1 new = 203 → evict 3: both done rows, then the oldest
    // in-progress row.
    expect(writeHomeStatusRow(doc, row({ key: "new" }), NOW)).toBe(3);
    expect(map.size).toBe(HOME_STATUS_MAX_ROWS);
    expect(map.has("new")).toBe(true);
    expect(map.has("d-old")).toBe(false);
    expect(map.has("d-new")).toBe(false);
    expect(map.has(`p${HOME_STATUS_MAX_ROWS - 1}`)).toBe(false);
    expect(map.has("p0")).toBe(true);
  });

  it("reads visible rows sorted and without expired ones", () => {
    const doc = new Y.Doc();
    const map = getHomeStatusMap(doc);
    map.set("p", valueOf(row({ status: "in-progress" })));
    map.set("n", valueOf(row({ status: "needs-you" })));
    map.set(
      "day-old-done",
      valueOf(row({ status: "done", updatedAt: NOW - DAY_MS - 1 })),
    );
    map.set(
      "gone",
      valueOf(
        row({ status: "done", updatedAt: NOW - HOME_STATUS_ROW_TTL_MS - 1 }),
      ),
    );
    expect(readVisibleHomeStatusRows(doc, NOW).map((r) => r.key)).toEqual([
      "n",
      "p",
      "day-old-done",
    ]);
  });

  it("removes a row and reports whether it existed", () => {
    const doc = new Y.Doc();
    writeHomeStatusRow(doc, row({ key: "a" }), NOW);
    expect(removeHomeStatusRow(doc, "a")).toBe(true);
    expect(removeHomeStatusRow(doc, "a")).toBe(false);
    expect(readHomeStatusRows(doc)).toEqual([]);
  });

  it("keeps a concurrent write when another replica removes the same key", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    writeHomeStatusRow(a, row({ key: "k", note: "first" }), NOW);
    exchange(a, b);

    removeHomeStatusRow(a, "k");
    const fresh = row({ key: "k", note: "fresh", updatedAt: NOW + 1 });
    writeHomeStatusRow(b, fresh, NOW + 1);
    exchange(a, b);

    expect(readHomeStatusRows(a)).toEqual([fresh]);
    expect(readHomeStatusRows(b)).toEqual([fresh]);
  });

  it("keeps a concurrent write when another replica prunes the same key", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    writeHomeStatusRow(
      a,
      row({
        key: "k",
        status: "done",
        updatedAt: NOW - HOME_STATUS_ROW_TTL_MS,
      }),
      NOW - HOME_STATUS_ROW_TTL_MS,
    );
    exchange(a, b);

    expect(pruneHomeStatusRows(a, NOW + 1)).toBe(1);
    const fresh = row({ key: "k", status: "in-progress", updatedAt: NOW + 1 });
    writeHomeStatusRow(b, fresh, NOW + 1);
    exchange(a, b);

    expect(readHomeStatusRows(a)).toEqual([fresh]);
    expect(readHomeStatusRows(b)).toEqual([fresh]);
  });

  it("converges two concurrent writes of the same key to one value", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    writeHomeStatusRow(a, row({ key: "k", note: "from a" }), NOW);
    writeHomeStatusRow(b, row({ key: "k", note: "from b" }), NOW);
    exchange(a, b);

    const fromA = readHomeStatusRows(a);
    expect(fromA).toHaveLength(1);
    expect(readHomeStatusRows(b)).toEqual(fromA);
    expect(["from a", "from b"]).toContain(fromA[0]?.note);
  });

  it("merges concurrent writers of different rows", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    writeHomeStatusRow(a, row({ key: "l" }), NOW);
    writeHomeStatusRow(b, row({ key: "r" }), NOW);
    exchange(a, b);
    expect(
      readHomeStatusRows(a)
        .map((r) => r.key)
        .sort(),
    ).toEqual(["l", "r"]);
    expect(
      readHomeStatusRows(b)
        .map((r) => r.key)
        .sort(),
    ).toEqual(["l", "r"]);
  });
});
