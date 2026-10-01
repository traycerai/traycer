import { describe, expect, it } from "vitest";
import { mergeOrder } from "@/lib/order-merge";

const CANONICAL = ["a", "b", "c", "d"] as const;

describe("mergeOrder", () => {
  it("returns the canonical order for an empty stored list", () => {
    expect(mergeOrder([], CANONICAL)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the stored order for ids both lists know", () => {
    expect(mergeOrder(["d", "b", "a", "c"], CANONICAL)).toEqual([
      "d",
      "b",
      "a",
      "c",
    ]);
  });

  it("collapses a duplicate to its first appearance", () => {
    expect(mergeOrder(["c", "a", "c", "b", "d"], CANONICAL)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("inserts a missing id after the nearest preceding id that is present", () => {
    // `b` is absent; `a` is the canonical id just before it and is present, so
    // `b` lands right after it - not at the end, where a reader would meet a
    // new element as a stray.
    expect(mergeOrder(["d", "a", "c"], CANONICAL)).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });

  it("inserts at the front when no preceding canonical id is present", () => {
    // `a` has nothing before it at all; `d` follows `c`, which is where its
    // nearest present predecessor sits - NOT the end of the list, which is the
    // whole point of anchoring on a neighbour.
    expect(mergeOrder(["c", "b"], CANONICAL)).toEqual(["a", "c", "d", "b"]);
  });

  it("keeps several missing ids in canonical order behind one anchor", () => {
    // `b`, `c` and `d` are all absent. Each inserted id becomes the anchor for
    // the next, so they arrive in canonical order rather than reversed.
    expect(mergeOrder(["a"], CANONICAL)).toEqual(["a", "b", "c", "d"]);
  });

  it("drops an id the canonical list does not name", () => {
    expect(mergeOrder(["b", "gone", "a"], CANONICAL)).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
  });

  it("ignores non-string entries in a hand-edited list", () => {
    expect(mergeOrder([null, "b", 7, "a"], CANONICAL)).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
  });
});
