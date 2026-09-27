import {
  retainedValueSize,
  type RetainedValueSize,
} from "./retained-value-size";

interface TrackedValue {
  readonly value: unknown;
  readonly size: RetainedValueSize;
}

/** V8 calibration floor for one populated main projection's maps and cache. */
export const MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES = 512;

/**
 * The main-thread projection is a structured-cloned graph separate from the
 * worker's row tables. The wire publishes changed top-level keys only; keep
 * their last measurements instead of re-encoding the whole projection.
 */
export function createMainProjectionAccount(): {
  recordPatch(patch: object): RetainedValueSize | null;
} {
  const values = new Map<string, TrackedValue>();
  // `replaceEqualDeep` in the publication path preserves unchanged nested
  // identities even though the wire structured-cloned the enclosing slice.
  // A new byId map may contain thousands of unchanged rows, so measure those
  // objects once, then sum their cached sizes when the parent changes.
  const subtreeSizes = new WeakMap<object, RetainedValueSize>();
  const measure = (value: unknown): RetainedValueSize => {
    if (typeof value !== "object" || value === null) {
      return retainedValueSize(value);
    }
    const cached = subtreeSizes.get(value);
    if (cached !== undefined) return cached;
    const prototype = Reflect.getPrototypeOf(value);
    if (
      !(
        Array.isArray(value) ||
        prototype === Object.prototype ||
        prototype === null
      )
    ) {
      const size = retainedValueSize(value);
      subtreeSizes.set(value, size);
      return size;
    }
    let rawBytes = 2;
    let estimatedHeapBytes: number;
    if (Array.isArray(value)) {
      rawBytes += Math.max(0, value.length - 1);
      estimatedHeapBytes = 32 + value.length * 8;
      for (const entry of value) {
        const size = measure(entry === undefined ? null : entry);
        rawBytes += size.rawBytes;
        estimatedHeapBytes += size.estimatedHeapBytes;
      }
    } else {
      const entries = Object.entries(value);
      estimatedHeapBytes = 40 + entries.length * 16;
      let included = 0;
      for (const [key, entry] of entries) {
        if (entry === undefined) continue;
        if (included > 0) rawBytes += 1;
        included += 1;
        rawBytes += retainedValueSize(key).rawBytes + 1;
        const size = measure(entry);
        rawBytes += size.rawBytes;
        estimatedHeapBytes += size.estimatedHeapBytes;
      }
    }
    const size = { rawBytes, estimatedHeapBytes };
    subtreeSizes.set(value, size);
    return size;
  };
  return {
    recordPatch(patch): RetainedValueSize | null {
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || values.get(key)?.value === value) continue;
        values.set(key, { value, size: measure(value) });
        changed = true;
      }
      if (!changed) return null;
      const countedObjects = new Set<object>();
      let rawBytes = 0;
      let estimatedHeapBytes = MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES;
      for (const { value, size } of values.values()) {
        if (typeof value === "object" && value !== null) {
          if (countedObjects.has(value)) continue;
          countedObjects.add(value);
        }
        rawBytes += size.rawBytes;
        estimatedHeapBytes += size.estimatedHeapBytes;
      }
      return { rawBytes, estimatedHeapBytes };
    },
  };
}
