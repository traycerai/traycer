import * as Y from "yjs";
import type { TypedYMap, TypedYRecordMap } from "./types";

export function toTypedArray<T>(arr: Y.Array<TypedYMap<T>>): TypedYMap<T>[] {
  return arr.toArray();
}

export function toTypedMapValues<T extends object>(
  map: TypedYRecordMap<T>,
): TypedYMap<T>[] {
  const values: TypedYMap<T>[] = [];
  for (const value of map.values()) {
    values.push(value);
  }
  return values;
}

export function getTypedMap<S>(doc: Y.Doc, key: string): TypedYMap<S> {
  return doc.getMap(key) as TypedYMap<S>;
}

export function clearXmlFragment(fragment: Y.XmlFragment): void {
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }
}

/** Recursively extract a plain typed JS object from a TypedYMap.
 *  Inverse of createTypedMap: Y.Map → plain object, Y.Array → plain array.
 *  Y.XmlFragment / Y.Text pass through as live instances (matches schema types). */
export function toObject<S>(map: Readonly<TypedYMap<S>>): S {
  return fromYjsValue(map) as S;
}

function fromYjsValue(value: unknown): unknown {
  if (value == null) return value;

  if (value instanceof Y.XmlFragment || value instanceof Y.Text) {
    return value;
  }

  if (value instanceof Y.Map) {
    const obj: Record<string, unknown> = {};
    value.forEach((v, k) => {
      obj[k] = fromYjsValue(v);
    });
    return obj;
  }

  if (value instanceof Y.Array) {
    return value.toArray().map(fromYjsValue);
  }

  return value;
}
