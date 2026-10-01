import { afterEach, describe, expect, it } from "vitest";
import { focusAtPath, focusPathWithin } from "../row-focus-path";

describe("row-focus-path", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("restores focus onto the equal node of a replaced subtree", () => {
    const root = document.createElement("div");
    const outer = document.createElement("div");
    const input = document.createElement("input");
    outer.append(input);
    root.append(outer);
    document.body.append(root);
    input.focus();

    const path = focusPathWithin(root);
    expect(path).toEqual([0, 0]);

    const nextOuter = document.createElement("div");
    const nextInput = document.createElement("input");
    nextOuter.append(nextInput);
    root.replaceChildren(nextOuter);
    focusAtPath(root, path ?? []);

    expect(document.activeElement).toBe(nextInput);
  });

  it("returns null when focus is outside the root", () => {
    const root = document.createElement("div");
    root.append(document.createElement("input"));
    const outsider = document.createElement("input");
    document.body.append(root, outsider);
    outsider.focus();

    expect(focusPathWithin(root)).toBeNull();
  });
});
