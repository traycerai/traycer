import { describe, expect, it } from "vitest";
import { distinctRenderKeys } from "@/components/chat/segment-render-keys";

describe("distinctRenderKeys", () => {
  it("keeps bare ids when they are unique", () => {
    expect(
      distinctRenderKeys([
        { id: "a", kind: "tool" },
        { id: "b", kind: "text" },
      ]),
    ).toEqual(["a", "b"]);
  });

  it("qualifies a later item of another kind sharing an id", () => {
    expect(
      distinctRenderKeys([
        { id: "x", kind: "tool" },
        { id: "x", kind: "approval" },
      ]),
    ).toEqual(["x", "approval:x"]);
  });

  it("numbers repeats of the same kind and id", () => {
    expect(
      distinctRenderKeys([
        { id: "x", kind: "tool" },
        { id: "x", kind: "tool" },
        { id: "x", kind: "tool" },
      ]),
    ).toEqual(["x", "tool:x", "tool:x#2"]);
  });

  it("stays unique when a bare id looks like a qualified key", () => {
    const keys = distinctRenderKeys([
      { id: "approval:x", kind: "text" },
      { id: "x", kind: "tool" },
      { id: "x", kind: "approval" },
    ]);
    expect(keys).toEqual(["approval:x", "x", "approval:x#2"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the first occurrence bare, in input order and length", () => {
    const items = [
      { id: "a", kind: "tool" },
      { id: "b", kind: "tool" },
      { id: "a", kind: "approval" },
      { id: "c", kind: "text" },
    ];
    const keys = distinctRenderKeys(items);
    expect(keys).toHaveLength(items.length);
    expect(keys).toEqual(["a", "b", "approval:a", "c"]);
  });

  it("returns no keys for no items", () => {
    expect(distinctRenderKeys([])).toEqual([]);
  });
});
