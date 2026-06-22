import * as Y from "yjs";
import type {
  StringKeyOfUnion,
  TypedYMap,
  ValueForKey,
  YCreateInput,
  YjsResolved,
} from "./types";

export type TypedMapPatch<T extends object> = {
  [K in StringKeyOfUnion<T>]?: YCreateInput<ValueForKey<T, K>>;
};

export function createTypedMap<S extends object>(
  data: YCreateInput<S>,
): TypedYMap<S> {
  return buildYMap(data) as TypedYMap<S>;
}

export function patchTypedMap<T extends object>(
  map: TypedYMap<T>,
  updates: TypedMapPatch<T>,
): void {
  for (const key of Object.keys(updates) as StringKeyOfUnion<T>[]) {
    applyPatchUpdate(map, updates, key);
  }
}

function applyPatchUpdate<T extends object, K extends StringKeyOfUnion<T>>(
  map: TypedYMap<T>,
  updates: TypedMapPatch<T>,
  key: K,
): void {
  const value = updates[key];
  if (value !== undefined) {
    map.set(key, toYjsValue<ValueForKey<T, K>>(value));
  }
}

function buildYMap(data: object): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  const detachedEntries = new Map<string, unknown>();
  for (const [key, value] of Object.entries(data)) {
    const yValue = toYjsValueUnknown(value);
    detachedEntries.set(key, yValue);
    map.set(key, yValue);
  }
  addDetachedReadFallbacks(map, detachedEntries);
  return map;
}

/**
 * Y.Map cannot be read in detached state (before being attached to a Y.Doc),
 * so callers that use createTypedMap(...) and then iterate keys/get values
 * will observe empty reads. We keep a detached mirror and fall back to it
 * until the map is attached.
 */
function addDetachedReadFallbacks(
  map: Y.Map<unknown>,
  detachedEntries: Map<string, unknown>,
): void {
  const originalGet = map.get.bind(map);
  const originalSet = map.set.bind(map);
  const originalHas = map.has.bind(map);
  const originalDelete = map.delete.bind(map);
  const originalClear = map.clear.bind(map);
  const originalKeys = map.keys.bind(map);
  const originalForEach = map.forEach.bind(map);
  const originalToJSON = map.toJSON.bind(map);

  const isAttached = () => map.doc !== null && map.doc !== undefined;

  // Shadow Y.Map's reader/writer methods with own-properties that fall back
  // to `detachedEntries` until the map is attached. `Object.assign` installs
  // the overrides without casting away Y.Map's method types.
  Object.assign(map, {
    get: (key: string) =>
      isAttached() ? originalGet(key) : detachedEntries.get(key),

    set: (key: string, value: unknown) => {
      detachedEntries.set(key, value);
      return originalSet(key, value);
    },

    has: (key: string) =>
      isAttached() ? originalHas(key) : detachedEntries.has(key),

    delete: (key: string) => {
      detachedEntries.delete(key);
      originalDelete(key);
    },

    clear: () => {
      detachedEntries.clear();
      originalClear();
    },

    keys: () => (isAttached() ? originalKeys() : detachedEntries.keys()),

    forEach: (
      callback: (value: unknown, key: string, targetMap: Y.Map<unknown>) => void,
    ) => {
      if (isAttached()) {
        originalForEach((value, key) => callback(value, key, map));
        return;
      }
      detachedEntries.forEach((value, key) => callback(value, key, map));
    },

    toJSON: () => {
      if (isAttached()) {
        return originalToJSON() as Record<string, unknown>;
      }

      const json: Record<string, unknown> = {};
      detachedEntries.forEach((value, key) => {
        json[key] = toDetachedJSONValue(value);
      });
      return json;
    },
  });
}

function toDetachedJSONValue(value: unknown): unknown {
  if (value == null) return value;

  if (value instanceof Y.Text || value instanceof Y.XmlFragment) {
    return value;
  }

  if (value instanceof Y.Map) {
    return value.toJSON();
  }

  if (value instanceof Y.Array) {
    // `_prelimContent` (entries held while detached) is yjs-internal AND
    // declared private on `Y.Array`, so it can't be reached by intersecting
    // the public type. Read it through an explicit `unknown` intermediate (a
    // typed binding, not an `as unknown` assertion) then a single cast.
    const arrayUnknown: unknown = value;
    const maybeDetachedArray = arrayUnknown as {
      doc?: Y.Doc | null;
      _prelimContent?: unknown[];
      toJSON: () => unknown[];
    };
    if (
      (maybeDetachedArray.doc === null ||
        maybeDetachedArray.doc === undefined) &&
      Array.isArray(maybeDetachedArray._prelimContent)
    ) {
      return maybeDetachedArray._prelimContent.map(toDetachedJSONValue);
    }
    return maybeDetachedArray.toJSON().map(toDetachedJSONValue);
  }

  return value;
}

function toYjsValueUnknown(value: unknown): unknown {
  if (value == null) return value;

  if (
    value instanceof Y.Text ||
    value instanceof Y.XmlFragment ||
    value instanceof Y.Map ||
    value instanceof Y.Array
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const arr = new Y.Array<unknown>();
    arr.push(value.map(toYjsValueUnknown));
    return arr;
  }

  if (typeof value === "object") {
    return buildYMap(value);
  }

  return value;
}

function toYjsValue<T>(value: YCreateInput<T>): YjsResolved<T> {
  return toYjsValueUnknown(value) as YjsResolved<T>;
}
