import * as Y from "yjs";
import { createTypedMap } from "./factory";
import type { TypedYMap, YCreateInput } from "./types";
import { toObject } from "./utils";

/**
 * Move an element within a Y.Array from one index to another.
 *
 * Yjs deletes are permanent (items enter the CRDT deletion set), so a "move"
 * is really snapshot → delete → re-create → insert.  This generates exactly
 * 2 Yjs operations (1 delete + 1 insert) regardless of array size.
 *
 * After the operation the moved element occupies `toIndex` in the resulting array.
 */
export function move<T extends object>(
  array: Y.Array<TypedYMap<T>>,
  fromIndex: number,
  toIndex: number,
): void {
  if (fromIndex === toIndex) return;
  const data = toObject(array.get(fromIndex));
  array.delete(fromIndex, 1);
  array.insert(toIndex, [createTypedMap<T>(data as YCreateInput<T>)]);
}

/**
 * Sort a Y.Array in-place using the provided comparator, with minimal Yjs ops.
 *
 * Uses selection-sort order: walks left-to-right, only `move`-ing elements
 * that are out of place.  Generates 0 Yjs ops when already sorted, and
 * exactly 2 ops (1 delete + 1 insert) per out-of-place element otherwise.
 *
 * Position tracking is done in-memory via a permutation array so we never
 * need identity or deep-equality checks on the live Y.Maps (which get
 * recreated on every move).
 */
export function sort<T extends object>(
  array: Y.Array<TypedYMap<T>>,
  compareFn: (a: TypedYMap<T>, b: TypedYMap<T>) => number,
): void {
  const n = array.length;
  if (n <= 1) return;

  // Snapshot live references to determine the target order via compareFn.
  // These refs become stale after the first move - we only use them for sorting.
  const snapshot: TypedYMap<T>[] = [];
  for (let i = 0; i < n; i++) snapshot.push(array.get(i));

  // target[pos] = original index of the element that belongs at `pos`
  const target = snapshot.map((_, i) => i);
  target.sort((a, b) => compareFn(snapshot[a], snapshot[b]));

  if (target.every((origIdx, pos) => origIdx === pos)) return;

  // Track where each original-index element currently sits in the Y.Array.
  // pos[origIdx] = current array index
  const pos = Array.from({ length: n }, (_, i) => i);
  // inv[arrayIdx] = which original-index element is at this array index
  const inv = Array.from({ length: n }, (_, i) => i);

  for (let dest = 0; dest < n; dest++) {
    const wantOrig = target[dest];
    const src = pos[wantOrig];
    if (src === dest) continue;

    // src > dest always (positions 0..dest-1 are already finalized)
    move(array, src, dest);

    // Update tracking: elements at [dest, src-1] shifted right by 1
    for (let j = src - 1; j >= dest; j--) {
      const origAtJ = inv[j];
      inv[j + 1] = origAtJ;
      pos[origAtJ] = j + 1;
    }
    inv[dest] = wantOrig;
    pos[wantOrig] = dest;
  }
}

/**
 * Remove every element for which `predicate` returns true.
 *
 * Iterates in reverse so that deletions don't shift the indices of
 * yet-to-be-visited elements.  Each removal is a single Y.Array delete op.
 */
export function removeWhere<T extends object>(
  array: Y.Array<TypedYMap<T>>,
  predicate: (element: TypedYMap<T>, index: number) => boolean,
): void {
  for (let i = array.length - 1; i >= 0; i--) {
    if (predicate(array.get(i), i)) {
      array.delete(i, 1);
    }
  }
}
