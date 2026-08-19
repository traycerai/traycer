import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MinimapListCard,
  type MinimapListEntry,
} from "@/components/minimap/minimap-list-card";

/**
 * jsdom has no layout, so the card's geometry is faked here: rows are a fixed
 * height in DOM order, and the scroller reports a viewport shorter than its
 * content. The fake is installed on the LAYOUT properties only (`offsetTop` /
 * `offsetHeight` / `clientHeight` / `scrollHeight`) and leaves
 * `getBoundingClientRect()` at jsdom's all-zero default — measuring through
 * rects is the defect this suite pins, because the card mounts inside its own
 * `zoom-in-95` entry animation, where a scaled rect reads every distance short.
 */
const ROW_HEIGHT = 28;
const VIEW_HEIGHT = 160;
const ITEM_COUNT = 20;
const CONTENT_HEIGHT = ROW_HEIGHT * ITEM_COUNT;
const MAX_SCROLL = CONTENT_HEIGHT - VIEW_HEIGHT;

const ITEMS: ReadonlyArray<MinimapListEntry> = Array.from(
  { length: ITEM_COUNT },
  (_unused, index) => ({
    key: `item-${index}`,
    label: `Message ${index}`,
    level: 1,
  }),
);

const scrollTops = new WeakMap<HTMLElement, number>();
const patched: Array<{
  readonly target: object;
  readonly name: string;
  readonly original: PropertyDescriptor | undefined;
}> = [];

function isRow(element: HTMLElement): boolean {
  return element.hasAttribute("data-minimap-list-row");
}

function isScroller(element: HTMLElement): boolean {
  return (
    element.parentElement !== null &&
    element.parentElement.hasAttribute("data-minimap-list-card") &&
    element.querySelector("[data-minimap-list-row]") !== null
  );
}

function rowIndex(element: HTMLElement): number {
  const siblings = element.parentElement?.children;
  if (siblings === undefined) return 0;
  return Array.prototype.indexOf.call(siblings, element);
}

function patch(name: string, descriptor: PropertyDescriptor): void {
  const target = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    ? HTMLElement.prototype
    : Element.prototype;
  patched.push({
    target,
    name,
    original: Object.getOwnPropertyDescriptor(target, name),
  });
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
}

function installLayoutFake(): void {
  patch("scrollTop", {
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollTops.set(this, value);
    },
  });
  patch("offsetTop", {
    get(this: HTMLElement) {
      return isRow(this) ? rowIndex(this) * ROW_HEIGHT : 0;
    },
  });
  patch("offsetHeight", {
    get(this: HTMLElement) {
      return isRow(this) ? ROW_HEIGHT : 0;
    },
  });
  patch("clientHeight", {
    get(this: HTMLElement) {
      return isScroller(this) ? VIEW_HEIGHT : 0;
    },
  });
  patch("scrollHeight", {
    get(this: HTMLElement) {
      return isScroller(this) ? CONTENT_HEIGHT : 0;
    },
  });
}

function restoreLayoutFake(): void {
  for (const entry of patched.reverse()) {
    if (entry.original === undefined) {
      Reflect.deleteProperty(entry.target, entry.name);
    } else {
      Object.defineProperty(entry.target, entry.name, entry.original);
    }
  }
  patched.length = 0;
}

function renderCard(currentIndex: number): HTMLElement {
  const view = render(
    <MinimapListCard
      currentIndex={currentIndex}
      cursorIndex={currentIndex}
      items={ITEMS}
      onCursorIndexChange={() => undefined}
      onSelect={() => undefined}
      side="right"
      title="Messages"
    />,
  );
  const row = view.container.querySelector<HTMLElement>(
    "[data-minimap-list-row]",
  );
  const scroller = row?.parentElement?.parentElement ?? null;
  if (scroller === null || !isScroller(scroller)) {
    throw new Error("minimap list scroller not found");
  }
  return scroller;
}

describe("MinimapListCard reveal on open", () => {
  beforeEach(installLayoutFake);

  afterEach(() => {
    cleanup();
    restoreLayoutFake();
  });

  it("opens at the very end when the last row is current", () => {
    expect(renderCard(ITEM_COUNT - 1).scrollTop).toBe(MAX_SCROLL);
  });

  it("opens at the top when the first row is current", () => {
    expect(renderCard(0).scrollTop).toBe(0);
  });

  it("opens with a mid-list row revealed at the bottom edge", () => {
    expect(renderCard(9).scrollTop).toBe(10 * ROW_HEIGHT - VIEW_HEIGHT);
  });

  it("leaves an already-visible row alone", () => {
    expect(renderCard(2).scrollTop).toBe(0);
  });
});
