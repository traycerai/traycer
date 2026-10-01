import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RangeHighlighter } from "../range-highlighter";

class FakeHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: readonly Range[]) {
    this.ranges = ranges;
  }
}

const registry = new Map<string, FakeHighlight>();

beforeEach(() => {
  registry.clear();
  vi.stubGlobal("CSS", {
    highlights: {
      set: (name: string, highlight: FakeHighlight): void => {
        registry.set(name, highlight);
      },
      delete: (name: string): void => {
        registry.delete(name);
      },
    },
  });
  vi.stubGlobal("Highlight", FakeHighlight);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function rangeIn(root: HTMLElement, text: string): Range {
  const node = root.ownerDocument.createTextNode(text);
  root.append(node);
  const range = new Range();
  range.setStart(node, 0);
  range.setEnd(node, text.length);
  return range;
}

describe("RangeHighlighter", () => {
  it("keeps two instances isolated and gives each root its own style", () => {
    const hostA = document.createElement("div");
    const hostB = document.createElement("div");
    const shadowA = hostA.attachShadow({ mode: "open" });
    const shadowB = hostB.attachShadow({ mode: "open" });
    const rootA = document.createElement("div");
    const rootB = document.createElement("div");
    shadowA.append(rootA);
    shadowB.append(rootB);
    document.body.append(hostA, hostB);
    const rangeA = rangeIn(rootA, "alpha");
    const rangeB = rangeIn(rootB, "bravo");
    const first = new RangeHighlighter();
    const second = new RangeHighlighter();

    first.paint(rootA, [rangeA], 0);
    second.paint(rootB, [rangeB], 0);

    expect(registry.size).toBe(2);
    expect(new Set(registry.keys()).size).toBe(2);
    expect(shadowA.querySelectorAll("style")).toHaveLength(1);
    expect(shadowB.querySelectorAll("style")).toHaveLength(1);
    expect(
      [...registry.values()]
        .map((highlight) => highlight.ranges[0].toString())
        .sort(),
    ).toEqual(["alpha", "bravo"]);

    first.dispose();

    expect(registry.size).toBe(1);
    expect([...registry.values()][0].ranges[0].toString()).toBe("bravo");
    expect(shadowA.querySelectorAll("style")).toHaveLength(0);
    expect(shadowB.querySelectorAll("style")).toHaveLength(1);
    second.dispose();
  });

  it("clears its ranges without removing the root style until dispose", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const highlighter = new RangeHighlighter();
    highlighter.paint(root, [rangeIn(root, "match")], 0);
    expect(registry.size).toBe(1);
    expect(document.head.querySelectorAll("style")).toHaveLength(1);

    highlighter.clear();

    expect(registry.size).toBe(0);
    expect(document.head.querySelectorAll("style")).toHaveLength(1);
    highlighter.dispose();
    expect(document.head.querySelectorAll("style")).toHaveLength(0);
  });
});

describe("paintRanges", () => {
  it("paints the given active range as active and the rest as match", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const rangeA = rangeIn(root, "alpha");
    const rangeB = rangeIn(root, "bravo");
    const rangeC = rangeIn(root, "charlie");
    const highlighter = new RangeHighlighter();

    highlighter.paintRanges(root, [rangeA, rangeB, rangeC], rangeB);

    const active = [...registry.entries()].find(([name]) =>
      name.startsWith("traycer-find-active-"),
    );
    const match = [...registry.entries()].find(([name]) =>
      name.startsWith("traycer-find-match-"),
    );
    expect(active?.[1].ranges).toEqual([rangeB]);
    expect(match?.[1].ranges).toEqual([rangeA, rangeC]);
    highlighter.dispose();
  });

  it("deletes the active highlight when active is null", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const rangeA = rangeIn(root, "alpha");
    const rangeB = rangeIn(root, "bravo");
    const highlighter = new RangeHighlighter();
    highlighter.paintRanges(root, [rangeA, rangeB], rangeA);
    expect(
      [...registry.keys()].some((name) =>
        name.startsWith("traycer-find-active-"),
      ),
    ).toBe(true);

    highlighter.paintRanges(root, [rangeA, rangeB], null);

    expect(
      [...registry.keys()].some((name) =>
        name.startsWith("traycer-find-active-"),
      ),
    ).toBe(false);
    const match = [...registry.entries()].find(([name]) =>
      name.startsWith("traycer-find-match-"),
    );
    expect(match?.[1].ranges).toEqual([rangeA, rangeB]);
    highlighter.dispose();
  });

  it("clears both highlights when there are no ranges and active is null", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const rangeA = rangeIn(root, "alpha");
    const highlighter = new RangeHighlighter();
    highlighter.paintRanges(root, [rangeA], rangeA);
    expect(registry.size).toBeGreaterThan(0);

    highlighter.paintRanges(root, [], null);

    expect(registry.size).toBe(0);
    highlighter.dispose();
  });
});
