import { afterEach, describe, expect, it, vi } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  applyIndexChange,
  applySkeletonChunk,
  applyWindowedSnapshot,
  emptyTranscriptWindow,
  skeletonOrdinalByRowId,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";

/**
 * # Transcript caches that survive skeleton copies
 *
 * Every chunk and index change copies the skeleton. The row-id index and the
 * placeholder rows used to be keyed on the array, so each copy rebuilt both
 * for the whole transcript. They are now carried across the copies - and the
 * one thing that must not change is any ANSWER.
 *
 * The index is checked against the definition it replaced: a map built from
 * the array, where a row id named twice answers with its last ordinal. Every
 * version is checked, not only the newest, because older windows stay alive
 * (a render in flight, a closure) after a newer copy exists.
 */

function entry(rowId: string, ordinal: number): RowSkeletonEntry {
  return {
    rowId,
    createdAt: ordinal,
    role: "user",
    byteLength: 10,
    bodyDigest: `d-${rowId}-${String(ordinal)}`,
  };
}

function seeded(rowCount: number): TranscriptWindow {
  return applyWindowedSnapshot(
    emptyTranscriptWindow(),
    {
      epoch: 1,
      rowCount,
      indexRevision: null,
      tail: { fromOrdinal: rowCount, messages: [], events: [] },
    },
    null,
    null,
  );
}

function chunk(
  window: TranscriptWindow,
  fromOrdinal: number,
  rowIds: readonly string[],
): TranscriptWindow {
  return applySkeletonChunk(window, {
    epoch: 1,
    fromOrdinal,
    entries: rowIds.map((rowId, index) => entry(rowId, fromOrdinal + index)),
    isFinal: false,
  });
}

/** The definition the carried index replaced. */
function referenceOrdinals(
  skeleton: readonly (RowSkeletonEntry | undefined)[],
): Map<string, number> {
  const ordinals = new Map<string, number>();
  skeleton.forEach((held, ordinal) => {
    if (held !== undefined) ordinals.set(held.rowId, ordinal);
  });
  return ordinals;
}

function expectExact(
  skeleton: readonly (RowSkeletonEntry | undefined)[],
  universe: Iterable<string>,
): void {
  const reference = referenceOrdinals(skeleton);
  const lookup = skeletonOrdinalByRowId(skeleton);
  for (const rowId of universe) {
    expect({ rowId, at: lookup.get(rowId) }).toEqual({
      rowId,
      at: reference.get(rowId),
    });
    expect(lookup.has(rowId)).toBe(reference.has(rowId));
  }
}

function idsOf(
  skeletons: ReadonlyArray<readonly (RowSkeletonEntry | undefined)[]>,
): Set<string> {
  const ids = new Set<string>(["never-named"]);
  for (const skeleton of skeletons) {
    for (const held of skeleton) if (held !== undefined) ids.add(held.rowId);
  }
  return ids;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the row-id index across skeleton copies", () => {
  it("answers exactly for every version of a streaming skeleton", () => {
    const versions: TranscriptWindow[] = [seeded(12)];
    // The index is first asked about the seeded window, as the list asks
    // about every published one.
    skeletonOrdinalByRowId(versions[0].skeleton);
    for (const from of [0, 4, 8]) {
      const previous = versions[versions.length - 1];
      skeletonOrdinalByRowId(previous.skeleton);
      versions.push(
        chunk(
          previous,
          from,
          [0, 1, 2, 3].map((i) => `r-${String(from + i)}`),
        ),
      );
    }
    const universe = idsOf(versions.map((window) => window.skeleton));
    for (const window of versions) expectExact(window.skeleton, universe);
  });

  it("carries the index to a hole-filling copy instead of rebuilding it", () => {
    const first = chunk(seeded(8), 0, ["r-0", "r-1", "r-2", "r-3"]);
    skeletonOrdinalByRowId(first.skeleton);
    const second = chunk(first, 4, ["r-4", "r-5", "r-6", "r-7"]);

    // A rebuilt index sets one Map entry per row; a carried one sets none.
    const mapSet = vi.spyOn(Map.prototype, "set");
    const lookup = skeletonOrdinalByRowId(second.skeleton);
    const entriesBuilt = mapSet.mock.calls.length;
    mapSet.mockRestore();

    expect(entriesBuilt).toBe(0);
    expect(lookup.get("r-6")).toBe(6);
  });

  it("answers exactly across appended and same-id updated index changes", () => {
    const streamed = chunk(seeded(4), 0, ["r-0", "r-1", "r-2", "r-3"]);
    skeletonOrdinalByRowId(streamed.skeleton);
    const appended = applyIndexChange(streamed, {
      epoch: 1,
      rowCount: 5,
      indexRevision: 1,
      changes: [{ type: "appended", entries: [entry("r-4", 4)] }],
      activeTurnId: null,
    });
    skeletonOrdinalByRowId(appended.skeleton);
    const updated = applyIndexChange(appended, {
      epoch: 1,
      rowCount: 5,
      indexRevision: 2,
      changes: [
        {
          type: "updated",
          entries: [
            { ordinal: 2, entry: { ...entry("r-2", 2), byteLength: 99 } },
          ],
        },
      ],
      activeTurnId: null,
    });

    expect(updated.skeleton).not.toBe(appended.skeleton);
    const versions = [streamed, appended, updated].map((w) => w.skeleton);
    const universe = idsOf(versions);
    for (const skeleton of versions) expectExact(skeleton, universe);
  });

  it("answers exactly when a copy displaces a row, names one twice, or branches", () => {
    const base = chunk(seeded(6), 0, ["a", "b", "c", "d", "e", "f"]);
    skeletonOrdinalByRowId(base.skeleton);
    // A rebuild after a reindex: ordinal 1 now holds a different row.
    const displaced = chunk(base, 1, ["x"]);
    // A row id written at a second ordinal while its first still holds it.
    const duplicated = chunk(base, 5, ["a"]);
    // Two copies grown from the same array.
    const branchOne = chunk(seeded(8), 0, ["p", "q"]);
    skeletonOrdinalByRowId(branchOne.skeleton);
    const branchLeft = chunk(branchOne, 2, ["l"]);
    const branchRight = chunk(branchOne, 2, ["m"]);
    skeletonOrdinalByRowId(branchLeft.skeleton);

    const versions = [
      base,
      displaced,
      duplicated,
      branchOne,
      branchLeft,
      branchRight,
    ].map((window) => window.skeleton);
    const universe = idsOf(versions);
    for (const skeleton of versions) expectExact(skeleton, universe);
  });

  it("answers with the last ordinal when one change names a row twice", () => {
    // An `updated` change listing the same row at two unfilled ordinals,
    // highest first: the rebuilt index keeps the LAST ordinal in array order.
    const streamed = chunk(seeded(8), 0, ["r-0", "r-1"]);
    skeletonOrdinalByRowId(streamed.skeleton);
    const twice = applyIndexChange(streamed, {
      epoch: 1,
      rowCount: 8,
      indexRevision: 1,
      changes: [
        {
          type: "updated",
          entries: [
            { ordinal: 6, entry: entry("dup", 6) },
            { ordinal: 3, entry: entry("dup", 3) },
          ],
        },
      ],
      activeTurnId: null,
    });

    expect(twice.skeleton[6]?.rowId).toBe("dup");
    expectExact(twice.skeleton, idsOf([twice.skeleton]));
  });

  it("matches the rebuilt index over a random run of copies", () => {
    // A small id pool so writes displace, duplicate and refill each other.
    let seed = 20_250_925;
    const random = (limit: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    const rowCount = 24;
    const history: TranscriptWindow[] = [seeded(rowCount)];
    for (let step = 0; step < 250; step += 1) {
      const parent =
        random(5) === 0
          ? history[random(history.length)]
          : history[history.length - 1];
      skeletonOrdinalByRowId(parent.skeleton);
      const from = random(rowCount);
      const length = 1 + random(4);
      const rowIds = Array.from(
        { length },
        () => `id-${String(random(rowCount + 6))}`,
      );
      history.push(chunk(parent, from, rowIds));
    }
    const universe = idsOf(history.map((window) => window.skeleton));
    for (const window of history) expectExact(window.skeleton, universe);
  });
});

describe("placeholder rows across skeleton copies", () => {
  it("keeps an untouched row's object and rebuilds a replaced entry's", () => {
    const first = chunk(seeded(8), 0, ["r-0", "r-1", "r-2", "r-3"]);
    const second = chunk(first, 4, ["r-4", "r-5", "r-6", "r-7"]);
    const rowsBefore = transcriptListRows({ window: first, rendered: [] });
    const rowsAfter = transcriptListRows({ window: second, rendered: [] });

    // Ordinals 0-3 were described before and untouched by the copy.
    expect(rowsAfter.slice(0, 4)).toEqual(rowsBefore.slice(0, 4));
    rowsAfter.slice(0, 4).forEach((row, index) => {
      expect(row).toBe(rowsBefore[index]);
    });

    const edited = chunk(second, 2, ["r-2"]);
    const rowsEdited = transcriptListRows({ window: edited, rendered: [] });
    expect(rowsEdited[2]).not.toBe(rowsAfter[2]);
    expect(rowsEdited[2]).toEqual({
      kind: "placeholder",
      key: "r-2",
      ordinal: 2,
      entry: edited.skeleton[2],
    });
  });

  it("draws the same rows as a fresh derivation", () => {
    const first = chunk(seeded(6), 0, ["r-0", "r-1"]);
    transcriptListRows({ window: first, rendered: [] });
    const second = chunk(first, 3, ["r-3"]);

    expect(transcriptListRows({ window: second, rendered: [] })).toEqual(
      Array.from({ length: 6 }, (_, ordinal) => {
        const held = second.skeleton[ordinal];
        return held === undefined
          ? {
              kind: "placeholder",
              key: `unplaced-row:${String(ordinal)}`,
              ordinal,
              entry: null,
            }
          : { kind: "placeholder", key: held.rowId, ordinal, entry: held };
      }),
    );
  });

  it("gives a renumbered entry a row at its new ordinal", () => {
    const shared = entry("r-moved", 1);
    const at1 = applySkeletonChunk(seeded(4), {
      epoch: 1,
      fromOrdinal: 1,
      entries: [shared],
      isFinal: false,
    });
    const at3 = applySkeletonChunk(seeded(4), {
      epoch: 1,
      fromOrdinal: 3,
      entries: [shared],
      isFinal: false,
    });
    const rowAt1 = transcriptListRows({ window: at1, rendered: [] })[1];
    const rowAt3 = transcriptListRows({ window: at3, rendered: [] })[3];

    expect(rowAt1.ordinal).toBe(1);
    expect(rowAt3.ordinal).toBe(3);
  });
});
