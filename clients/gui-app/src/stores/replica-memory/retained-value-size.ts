/**
 * Two deliberately different measurements of a retained, JSON-shaped value.
 * `rawBytes` is its UTF-8 JSON representation; `estimatedHeapBytes` models
 * the objects and strings that remain live after the input frame is gone.
 * Neither is a measurement of the renderer process or of a Y.Doc.
 *
 * Call this for a changed row or store slice, never for a whole replica on
 * every frame. A shared reference within one value is charged once.
 */
export interface RetainedValueSize {
  readonly rawBytes: number;
  readonly estimatedHeapBytes: number;
}

const textEncoder = new TextEncoder();

export function v8StringWidth(value: string): 1 | 2 {
  // V8 uses one-byte strings when every UTF-16 code unit fits in Latin-1.
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) return 2;
  }
  return 1;
}

export function estimatedStringBytesFromWidth(
  length: number,
  width: 1 | 2,
): number {
  return 24 + Math.ceil((length * width + 1) / 8) * 8;
}

function estimatedStringBytes(value: string): number {
  return estimatedStringBytesFromWidth(value.length, v8StringWidth(value));
}

function estimatedValueBytes(value: unknown, seen: WeakSet<object>): number {
  if (typeof value === "string") return estimatedStringBytes(value);
  if (typeof value !== "object" || value === null) return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof Uint8Array) return 32 + value.byteLength;
  if (value instanceof Set) {
    let bytes = 48 + value.size * 24;
    for (const entry of value) bytes += estimatedValueBytes(entry, seen);
    return bytes;
  }
  if (value instanceof Map) {
    let bytes = 48 + value.size * 32;
    for (const [key, entry] of value) {
      bytes += estimatedValueBytes(key, seen);
      bytes += estimatedValueBytes(entry, seen);
    }
    return bytes;
  }
  if (Array.isArray(value)) {
    let bytes = 32 + value.length * 8;
    for (const entry of value) bytes += estimatedValueBytes(entry, seen);
    return bytes;
  }
  const entries = Object.entries(value);
  let bytes = 40 + entries.length * 16;
  for (const [, entry] of entries) {
    // Property names are shared by objects with the same V8 shape. Charging
    // a new heap string for every key on every row overstates many-row heaps.
    bytes += estimatedValueBytes(entry, seen);
  }
  return bytes;
}

export function retainedValueSize(value: unknown): RetainedValueSize {
  const json = JSON.stringify(value, (_key, entry: unknown): unknown => {
    if (entry instanceof Set) return [...entry];
    if (entry instanceof Map) return [...entry.entries()];
    return entry;
  });
  return {
    rawBytes: textEncoder.encode(json).byteLength,
    estimatedHeapBytes: estimatedValueBytes(value, new WeakSet()),
  };
}
