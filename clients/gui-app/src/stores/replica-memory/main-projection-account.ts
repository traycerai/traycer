import {
  retainedValueSize,
  type RetainedValueSize,
} from "./retained-value-size";

interface TrackedValue {
  readonly value: unknown;
  readonly primitiveSize: RetainedValueSize | null;
}

interface ObjectNode {
  // A cached node measures only its own container, keys, and primitive fields.
  // Child objects are charged separately so aliases anywhere in the graph
  // contribute once, even when distinct top-level slices share rows.
  readonly ownSize: RetainedValueSize;
  readonly children: readonly object[];
  // JSON emits every reference, even when the heap shares its target.
  serializedRawBytes: number;
  references: number;
}

/** V8 calibration floor for one populated projection's maps and node cache. */
export const MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES = 1280;

/**
 * The main-thread projection is a structured-cloned graph separate from the
 * worker's row tables. The wire publishes changed top-level keys only. Keep
 * reference counts for their shared nested objects and cache each object's
 * own measurement, so a changed slice does not re-encode unchanged row text.
 */
export function createMainProjectionAccount(): {
  recordPatch(patch: object): RetainedValueSize | null;
} {
  const values = new Map<string, TrackedValue>();
  const nodes = new WeakMap<object, ObjectNode>();
  let rawBytes = 0;
  let estimatedHeapBytes = 0;

  const nodeFor = (value: object): ObjectNode => {
    const cached = nodes.get(value);
    if (cached !== undefined) return cached;

    const prototype = Reflect.getPrototypeOf(value);
    if (
      !(
        Array.isArray(value) ||
        prototype === Object.prototype ||
        prototype === null
      )
    ) {
      // Projections are JSON-shaped. Preserve the existing estimator for an
      // unexpected opaque object rather than treating it as an empty shell.
      const size = retainedValueSize(value);
      const node = {
        ownSize: size,
        children: [],
        serializedRawBytes: size.rawBytes,
        references: 0,
      };
      nodes.set(value, node);
      return node;
    }

    let ownRawBytes = 2;
    let ownEstimatedHeapBytes: number;
    const children: object[] = [];
    if (Array.isArray(value)) {
      ownRawBytes += Math.max(0, value.length - 1);
      ownEstimatedHeapBytes = 32 + value.length * 8;
      for (const entry of value as readonly unknown[]) {
        const child = entry === undefined ? null : entry;
        if (typeof child === "object" && child !== null) {
          children.push(child);
        } else {
          const size = retainedValueSize(child);
          ownRawBytes += size.rawBytes;
          ownEstimatedHeapBytes += size.estimatedHeapBytes;
        }
      }
    } else {
      const entries = Object.entries(value as Record<string, unknown>);
      ownEstimatedHeapBytes = 40 + entries.length * 16;
      let included = 0;
      for (const [key, entry] of entries) {
        if (entry === undefined) continue;
        if (included > 0) ownRawBytes += 1;
        included += 1;
        ownRawBytes += retainedValueSize(key).rawBytes + 1;
        if (typeof entry === "object" && entry !== null) {
          children.push(entry);
        } else {
          const size = retainedValueSize(entry);
          ownRawBytes += size.rawBytes;
          ownEstimatedHeapBytes += size.estimatedHeapBytes;
        }
      }
    }
    const node = {
      ownSize: {
        rawBytes: ownRawBytes,
        estimatedHeapBytes: ownEstimatedHeapBytes,
      },
      children,
      serializedRawBytes: ownRawBytes,
      references: 0,
    };
    nodes.set(value, node);
    // Cache the raw size of this JSON subtree. A changed root can then count
    // every serialized alias without re-encoding unchanged row text.
    for (const child of children) {
      node.serializedRawBytes += nodeFor(child).serializedRawBytes;
    }
    return node;
  };

  const attachObject = (value: object): void => {
    const node = nodeFor(value);
    node.references += 1;
    if (node.references !== 1) return;
    estimatedHeapBytes += node.ownSize.estimatedHeapBytes;
    for (const child of node.children) attachObject(child);
  };

  const detachObject = (value: object): void => {
    const node = nodeFor(value);
    node.references -= 1;
    if (node.references !== 0) return;
    estimatedHeapBytes -= node.ownSize.estimatedHeapBytes;
    for (const child of node.children) detachObject(child);
  };

  const attach = (tracked: TrackedValue): void => {
    if (typeof tracked.value === "object" && tracked.value !== null) {
      rawBytes += nodeFor(tracked.value).serializedRawBytes;
      attachObject(tracked.value);
      return;
    }
    if (tracked.primitiveSize === null) return;
    rawBytes += tracked.primitiveSize.rawBytes;
    estimatedHeapBytes += tracked.primitiveSize.estimatedHeapBytes;
  };

  const detach = (tracked: TrackedValue): void => {
    if (typeof tracked.value === "object" && tracked.value !== null) {
      rawBytes -= nodeFor(tracked.value).serializedRawBytes;
      detachObject(tracked.value);
      return;
    }
    if (tracked.primitiveSize === null) return;
    rawBytes -= tracked.primitiveSize.rawBytes;
    estimatedHeapBytes -= tracked.primitiveSize.estimatedHeapBytes;
  };

  return {
    recordPatch(patch): RetainedValueSize | null {
      const replaced: TrackedValue[] = [];
      const added: TrackedValue[] = [];
      for (const [key, value] of Object.entries(
        patch as Record<string, unknown>,
      )) {
        if (value === undefined || values.get(key)?.value === value) continue;
        const previous = values.get(key);
        if (previous !== undefined) replaced.push(previous);
        const next = {
          value,
          primitiveSize:
            typeof value === "object" && value !== null
              ? null
              : retainedValueSize(value),
        };
        values.set(key, next);
        added.push(next);
      }
      if (added.length === 0) return null;
      // Attach new roots first. Unchanged rows still referenced by old roots
      // never drop to zero and their cached children need no revisit.
      for (const value of added) attach(value);
      for (const value of replaced) detach(value);
      return {
        rawBytes,
        estimatedHeapBytes:
          estimatedHeapBytes + MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES,
      };
    },
  };
}
