import { YKeyValue } from "y-utility/y-keyvalue";
import * as Y from "yjs";

/**
 * Typed facade over `y-utility`'s `YKeyValue` - an id-keyed store backed by a `Y.Array<{ key, val }>` that compacts overwritten keys instead of growing tombstones the way a frequently-rewritten `Y.Map`/`Y.Array<value>`.
 * Values MUST be plain JSON - YKeyValue's compaction deletes/re-inserts backing entries, which would corrupt a nested Y-type's identity.
 */
export type YKeyValueEntry<T> = { key: string; val: T };

// Keyed by `object` (not `Y.Array<unknown>`) because Y.Array is invariant in its
// element type - a `Y.Array<Entry<T>>` is not assignable to `Y.Array<unknown>`.
const instanceCache = new WeakMap<object, TypedYKeyValue<unknown>>();

export class TypedYKeyValue<T> {
  private readonly store: YKeyValue<T>;

  /**
   * Wraps an existing backing `Y.Array<{ key, val }>`.
   * The array must already be attached to a `Y.Doc` (YKeyValue runs a one-time dedup transaction + installs an observer on construction).
   */
  constructor(public readonly yarray: Y.Array<YKeyValueEntry<T>>) {
    this.store = new YKeyValue<T>(yarray);
  }

  // Append `{ key, val }` and remove any prior entry for `key` (compacted).
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
