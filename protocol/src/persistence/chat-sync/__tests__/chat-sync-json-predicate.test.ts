import { isJsonValue } from "@traycer/protocol/persistence/chat-sync/json";
import { describe, expect, it } from "vitest";

/**
 * `isJsonValue` accepts an array only when `JSON.stringify` would write it
 * back as itself: a plain `Array`, every index present as an enumerable data
 * property holding JSON, and no other own property. Each refused fixture
 * below is otherwise a dense array of strings, so only the named property
 * decides the result.
 */

function arrayWithHole(): unknown[] {
  const entries: unknown[] = ["a"];
  entries[2] = "c";
  return entries;
}

function arrayWithHoleMaskedByExtraProperty(): unknown[] {
  // Own property names are `1`, `extra` and `length`: the count a dense array
  // of two would have, so a count alone does not tell it from one.
  const entries: unknown[] = [];
  entries[1] = "b";
  Object.assign(entries, { extra: "x" });
  return entries;
}

function arrayWithExtraProperty(): unknown[] {
  return Object.assign(["a", "b"], { extra: "x" });
}

function arrayWithGetterIndex(): unknown[] {
  const entries: unknown[] = ["a"];
  Object.defineProperty(entries, "1", {
    get: () => "b",
    enumerable: true,
    configurable: true,
  });
  return entries;
}

function arrayWithNonEnumerableIndex(): unknown[] {
  const entries: unknown[] = ["a"];
  Object.defineProperty(entries, "1", {
    value: "b",
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return entries;
}

function arrayWithSymbolProperty(): unknown[] {
  return Object.assign(["a", "b"], { [Symbol("tag")]: "x" });
}

class SubArray extends Array<unknown> {}

function arraySubclassInstance(): unknown[] {
  return SubArray.from(["a", "b"]);
}

describe("isJsonValue on arrays", () => {
  it.each([
    { name: "a hole", value: arrayWithHole() },
    {
      name: "a hole masked by an extra property",
      value: arrayWithHoleMaskedByExtraProperty(),
    },
    {
      name: "an extra string-named own property",
      value: arrayWithExtraProperty(),
    },
    { name: "an index defined with a getter", value: arrayWithGetterIndex() },
    { name: "a non-enumerable index", value: arrayWithNonEnumerableIndex() },
    { name: "an own symbol property", value: arrayWithSymbolProperty() },
    { name: "an Array subclass instance", value: arraySubclassInstance() },
  ])("refuses an array with $name", ({ value }) => {
    expect(isJsonValue(value)).toBe(false);
  });

  it("accepts a dense plain array, nested arrays and objects included", () => {
    expect(isJsonValue([])).toBe(true);
    expect(isJsonValue([[], [1], { a: [null] }])).toBe(true);
  });
});
