import { YKeyValue } from "y-utility/y-keyvalue";
import * as Y from "yjs";

/**
 * Typed facade over `y-utility`'s `YKeyValue` - an id-keyed store backed by a
 * `Y.Array<{ key, val }>` that compacts overwritten keys instead of growing
 * tombstones the way a frequently-rewritten `Y.Map`/`Y.Array<value>` does.
 *
 * Why this exists: a streaming chat turn re-persists its message ~100x. With the
 * old `Y.Array<Message>` storage every checkpoint did `delete(i)+insert(i)`,
 * re-encoding the whole message (all blocks) each time; the un-GC'd local pending
 * update then retained every superseded copy (~100x bloat). Keying messages and
 * blocks by id lets a checkpoint rewrite only the one block that changed.
 *
 * Values MUST be plain JSON - YKeyValue's compaction deletes/re-inserts backing
 * entries, which would corrupt a nested Y-type's identity. This is the invariant
 * that drives the flat-normalized chat storage (message scalars + blocks, both
 * keyed, both plain JSON).
 *
 * The underlying `YKeyValue` installs a `Y.Array` observer to maintain its
 * identity map, so it must be long-lived per backing array (constructing one per
 * write would leak observers). We cache instances in a `WeakMap` keyed by the
 * backing array, so an instance is created once and released for GC when the
 * array (its chat/doc) is dropped.
 */
export type YKeyValueEntry<T> = { key: string; val: T };

// Keyed by `object` (not `Y.Array<unknown>`) because Y.Array is invariant in its
// element type - a `Y.Array<Entry<T>>` is not assignable to `Y.Array<unknown>`.
const instanceCache = new WeakMap<object, TypedYKeyValue<unknown>>();

export class TypedYKeyValue<T> {
  private readonly store: YKeyValue<T>;

  /**
   * Wraps an existing backing `Y.Array<{ key, val }>`. The array must already be
   * attached to a `Y.Doc` (YKeyValue runs a one-time dedup transaction + installs
   * an observer on construction). Prefer {@link typedYKeyValue} so the instance
   * (and its observer) is reused per array rather than re-created per call.
   */
  constructor(public readonly yarray: Y.Array<YKeyValueEntry<T>>) {
    this.store = new YKeyValue<T>(yarray);
  }

  // Append `{ key, val }` and remove any prior entry for `key` (compacted). When
  // wrapped in an outer `doc.transact(..., ORIGIN)` the write inherits that
  // origin, so storage writes stay tagged for pending-update capture.
  set(key: string, value: T): void {
    this.store.set(key, value);
  }

  get(key: string): T | undefined {
    return this.store.get(key);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): string[] {
    return [...this.store.map.keys()];
  }

  values(): T[] {
    return Array.from(this.store.map.values(), (entry) => entry.val);
  }

  entries(): Array<[string, T]> {
    return Array.from(this.store.map.entries(), ([key, entry]) => [
      key,
      entry.val,
    ]);
  }

  get size(): number {
    return this.store.map.size;
  }
}

/**
 * Returns the cached {@link TypedYKeyValue} for a backing array, creating it on
 * first use. The array must be attached to a doc.
 */
export function typedYKeyValue<T>(
  yarray: Y.Array<YKeyValueEntry<T>>,
): TypedYKeyValue<T> {
  const cached = instanceCache.get(yarray);
  if (cached !== undefined) return cached as TypedYKeyValue<T>;
  const created = new TypedYKeyValue<T>(yarray);
  instanceCache.set(yarray, created as TypedYKeyValue<unknown>);
  return created;
}
