import * as Y from "yjs";

export type StringKeyOfUnion<T> = T extends unknown ? keyof T & string : never;

export type ValueForKey<T, K extends string> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : undefined
  : never;

type TypedYMapValue<Schema, K extends StringKeyOfUnion<Schema>> = YjsResolved<
  ValueForKey<Schema, K>
>;

// Branded Y.Map that enforces typed get/set based on the schema.
// Uses Omit to replace Y.Map's generic get/set with schema-aware signatures.
export type TypedYMap<Schema> = Omit<Y.Map<unknown>, "get" | "set" | "has"> & {
  get<K extends StringKeyOfUnion<Schema>>(key: K): TypedYMapValue<Schema, K>;
  set<K extends StringKeyOfUnion<Schema>>(
    key: K,
    value: TypedYMapValue<Schema, K>,
  ): TypedYMapValue<Schema, K>;
  has(key: StringKeyOfUnion<Schema>): boolean;
};

// Specialized Y.Map alias for string-keyed entity collections where each value
// is itself a nested object stored as a TypedYMap.
export type TypedYRecordMap<Value extends object> = Omit<
  TypedYMap<Record<string, Value>>,
  | "entries"
  | "forEach"
  | "get"
  | "has"
  | "set"
  | "values"
  | typeof Symbol.iterator
> & {
  get(key: string): TypedYMap<Value> | undefined;
  set(key: string, value: TypedYMap<Value>): TypedYMap<Value>;
  has(key: string): boolean;
  entries(): IterableIterator<[string, TypedYMap<Value>]>;
  values(): IterableIterator<TypedYMap<Value>>;
  forEach(
    callback: (
      value: TypedYMap<Value>,
      key: string,
      map: TypedYRecordMap<Value>,
    ) => void,
  ): void;
  [Symbol.iterator](): IterableIterator<[string, TypedYMap<Value>]>;
};

type YjsResolvedObject<T extends object> = string extends keyof T
  ? T[string] extends object
    ? TypedYRecordMap<T[string]>
    : TypedYMap<T>
  : TypedYMap<T>;

// Resolves a schema field type to its Yjs representation.
// Uses `T extends object` instead of `T extends Record<string, unknown>`
// because TS interfaces lack implicit index signatures and fail the Record constraint.
// Distributive conditional types handle unions (T | null, T | undefined) correctly.
// Y.Array<U> is already the live persistence representation, so it passes
// through without recursively wrapping its elements.
export type YjsResolved<T> = T extends Y.Text
  ? Y.Text
  : T extends Y.XmlFragment
    ? Y.XmlFragment
    : T extends Y.Array<infer U>
      ? Y.Array<U>
      : T extends null
        ? null
        : T extends undefined
          ? undefined
          : T extends Array<infer U>
            ? Y.Array<YjsResolved<U>>
            : T extends object
              ? YjsResolvedObject<T>
              : T;

// What callers pass to createTypedMap() -- plain JS objects/arrays, with
// Yjs rich-text types passed through as-is (caller constructs Y.Text etc.)
// Y.Array<U> fields accept either a detached/live Y.Array<U> or plain U[] at
// the input boundary.
export type YCreateInput<T> = T extends Y.Text
  ? Y.Text
  : T extends Y.XmlFragment
    ? Y.XmlFragment
    : T extends Y.Array<infer U>
      ? U[] | Y.Array<U>
      : T extends null
        ? null
        : T extends undefined
          ? undefined
          : T extends Array<infer U>
            ? YCreateInput<U>[]
            : T extends object
              ? { [K in keyof T]: YCreateInput<T[K]> }
              : T;

// Extracts the raw schema interface from a TypedYMap.
// Useful when a generic API is parameterized by the raw schema type
// but the caller only has the TypedYMap alias.
export type InferSchema<M> = M extends TypedYMap<infer S> ? S : never;
