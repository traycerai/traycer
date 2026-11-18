import { afterEach, describe, expect, it } from "vitest";
import { stripArrowTarget } from "../strip-arrow-keys";

afterEach(() => {
  document.body.replaceChildren();
});

/**
 * The strip as the list draws it: a section header, a task, a pair of two
 * halves under its split icon, an agent row, a group label, a row of a group a
 * fold hides, and a last task.
 */
function list(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <button data-id="header">Working</button>
    <div role="tab" data-id="a"></div>
    <div role="group" data-side-split-pair="expanded">
      <button data-id="icon"></button>
      <div role="tab" data-id="left"></div>
      <div role="tab" data-id="right"></div>
    </div>
    <div role="group"><button data-id="agent"></button></div>
    <span data-id="label">Work</span>
    <div aria-hidden="true"><div role="tab" data-id="ghost"></div></div>
    <div role="tab" data-id="b"></div>
  `;
  document.body.append(root);
  return root;
}

function tab(root: HTMLElement, id: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node === null) throw new Error(`no ${id}`);
  return node;
}

function walk(root: HTMLElement, from: string, keys: ReadonlyArray<string>) {
  let at = tab(root, from);
  return keys.map((key) => {
    at = stripArrowTarget(root, at, key) ?? at;
    return at.dataset.id;
  });
}

describe("stripArrowTarget", () => {
  it("moves Down and Up through the tabs as drawn, a pair's left half before its right", () => {
    const root = list();
    expect(walk(root, "a", ["ArrowDown", "ArrowDown", "ArrowDown"])).toEqual([
      "left",
      "right",
      "b",
    ]);
    expect(walk(root, "b", ["ArrowUp", "ArrowUp", "ArrowUp"])).toEqual([
      "right",
      "left",
      "a",
    ]);
  });

  it("stops at the ends rather than wrapping", () => {
    const root = list();
    expect(stripArrowTarget(root, tab(root, "a"), "ArrowUp")).toBeNull();
    expect(stripArrowTarget(root, tab(root, "b"), "ArrowDown")).toBeNull();
  });

  it("moves Left and Right between a pair's halves only, stopping at either", () => {
    const root = list();
    expect(walk(root, "left", ["ArrowRight", "ArrowRight"])).toEqual([
      "right",
      "right",
    ]);
    expect(walk(root, "right", ["ArrowLeft", "ArrowLeft"])).toEqual([
      "left",
      "left",
    ]);
    expect(stripArrowTarget(root, tab(root, "a"), "ArrowRight")).toBeNull();
  });

  it("moves nothing for another key, or from something that is not a tab", () => {
    const root = list();
    expect(stripArrowTarget(root, tab(root, "a"), "Enter")).toBeNull();
    expect(stripArrowTarget(root, tab(root, "icon"), "ArrowDown")).toBeNull();
  });
});
