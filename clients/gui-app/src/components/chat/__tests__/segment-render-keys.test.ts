import { describe, expect, it } from "vitest";
import { distinctRenderKeys } from "@/components/chat/segment-render-keys";

function key(kind: string, id: string): string {
  return JSON.stringify([kind, id]);
}

describe("distinctRenderKeys", () => {
  it("keys every item by its own kind and id", () => {
    expect(
      distinctRenderKeys([
        { id: "a", kind: "tool" },
        { id: "b", kind: "text" },
      ]),
    ).toEqual([key("tool", "a"), key("text", "b")]);
  });

  it("gives items of different kinds sharing an id distinct keys", () => {
    expect(
      distinctRenderKeys([
        { id: "x", kind: "tool" },
        { id: "x", kind: "approval" },
      ]),
    ).toEqual([key("tool", "x"), key("approval", "x")]);
  });

  it("numbers repeats of the same kind and id", () => {
    expect(
      distinctRenderKeys([
        { id: "x", kind: "tool" },
        { id: "x", kind: "tool" },
        { id: "x", kind: "tool" },
      ]),
    ).toEqual([
      key("tool", "x"),
      `${key("tool", "x")}#2`,
      `${key("tool", "x")}#3`,
    ]);
  });

  it("keeps an item's key when an earlier sibling sharing its id is removed", () => {
    const before = distinctRenderKeys([
      { id: "x", kind: "tool" },
      { id: "x", kind: "approval" },
    ]);
    const after = distinctRenderKeys([{ id: "x", kind: "approval" }]);
    expect(after[0]).toBe(before[1]);
  });

  it("cannot collide when ids are spelled like other keys", () => {
    const items = [
      { id: "approval:x", kind: "text" },
      { id: "x", kind: "tool" },
      { id: "x", kind: "approval" },
      { id: 'x"]', kind: "a" },
      { id: "x", kind: 'a"' },
      { id: "x#2", kind: "tool" },
      { id: "x", kind: "tool" },
    ];
    const keys = distinctRenderKeys(items);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[2]).toBe(key("approval", "x"));
  });

  it("keeps input order and length", () => {
    const items = [
      { id: "a", kind: "tool" },
      { id: "b", kind: "tool" },
      { id: "a", kind: "approval" },
      { id: "c", kind: "text" },
    ];
    expect(distinctRenderKeys(items)).toEqual([
      key("tool", "a"),
      key("tool", "b"),
      key("approval", "a"),
      key("text", "c"),
    ]);
  });

  it("returns no keys for no items", () => {
    expect(distinctRenderKeys([])).toEqual([]);
  });
});
