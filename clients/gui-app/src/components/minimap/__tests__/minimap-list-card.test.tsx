import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MinimapListCard } from "@/components/minimap/minimap-list-card";

/**
 * jsdom does not lay out, and it does not apply `zoom-in-95`. Stub the opening
 * scale onto `getBoundingClientRect` so converting that visual delta into
 * `scrollTop` under-scrolls the current row, matching the live popover.
 */
const OPENING_ZOOM = 0.95;
const VIEWPORT_HEIGHT = 200;
const ROW_HEIGHT = 40;
const ITEM_COUNT = 16;
const CURRENT_INDEX = 15;

function isMinimapList(node: HTMLElement): boolean {
  return (
    node.parentElement?.hasAttribute("data-minimap-list-card") === true &&
    node.className.includes("overflow-y-auto")
  );
}

function minimapListFor(node: HTMLElement): HTMLElement | null {
  const card = node.closest("[data-minimap-list-card]");
  if (card === null) return null;
  const list = card.querySelector(".overflow-y-auto");
  return list instanceof HTMLElement ? list : null;
}

function rowLayoutTop(row: HTMLElement): number {
  const card = row.closest("[data-minimap-list-card]");
  if (card === null) return 0;
  const rows = card.querySelectorAll("[data-minimap-list-row]");
  return [...rows].indexOf(row) * ROW_HEIGHT;
}

function scaledRect(layoutTop: number, layoutHeight: number): DOMRect {
  return new DOMRect(
    0,
    layoutTop * OPENING_ZOOM,
    1,
    layoutHeight * OPENING_ZOOM,
  );
}

function installOpeningZoomGeometry() {
  let listScrollTop = 0;
  const scrollTop = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTop",
  );
  const clientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  const scrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );

  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      if (isMinimapList(this)) return listScrollTop;
      return 0;
    },
    set(this: HTMLElement, value: number) {
      if (isMinimapList(this)) {
        listScrollTop = value;
        return;
      }
      scrollTop?.set?.call(this, value);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (isMinimapList(this)) return VIEWPORT_HEIGHT;
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (isMinimapList(this)) return ITEM_COUNT * ROW_HEIGHT;
      return 0;
    },
  });

  const boundingRect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function measure(this: HTMLElement): DOMRect {
      if (isMinimapList(this)) {
        return scaledRect(0, VIEWPORT_HEIGHT);
      }
      if (this.hasAttribute("data-minimap-list-row")) {
        return scaledRect(rowLayoutTop(this) - listScrollTop, ROW_HEIGHT);
      }
      return new DOMRect();
    });

  const scrollIntoView = vi
    .spyOn(HTMLElement.prototype, "scrollIntoView")
    .mockImplementation(function align(this: HTMLElement): void {
      if (!this.hasAttribute("data-minimap-list-row")) return;
      const list = minimapListFor(this);
      if (list === null) return;
      const top = rowLayoutTop(this);
      const bottom = top + ROW_HEIGHT;
      if (top < listScrollTop) {
        listScrollTop = top;
        return;
      }
      if (bottom > listScrollTop + VIEWPORT_HEIGHT) {
        listScrollTop = bottom - VIEWPORT_HEIGHT;
      }
    });

  return {
    restore: () => {
      boundingRect.mockRestore();
      scrollIntoView.mockRestore();
      restorePrototype("scrollTop", scrollTop);
      restorePrototype("clientHeight", clientHeight);
      restorePrototype("scrollHeight", scrollHeight);
    },
    scrollIntoView,
  };
}

function restorePrototype(
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, property);
    return;
  }
  Object.defineProperty(HTMLElement.prototype, property, descriptor);
}

describe("MinimapListCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps a far-down current row inside the popover viewport while the opening zoom is applied", () => {
    const { restore, scrollIntoView } = installOpeningZoomGeometry();
    try {
      const items = Array.from({ length: ITEM_COUNT }, (_unused, index) => ({
        key: `item-${String(index)}`,
        label: `Item ${String(index)}`,
        level: 1 as const,
      }));
      render(
        <MinimapListCard
          currentIndex={CURRENT_INDEX}
          cursorIndex={CURRENT_INDEX}
          items={items}
          onCursorIndexChange={vi.fn()}
          onSelect={vi.fn()}
          side="right"
          title="Turns"
        />,
      );

      const current = screen.getByRole("button", {
        name: `Item ${String(CURRENT_INDEX)}`,
      });
      expect(current.getAttribute("aria-current")).toBe("location");
      const list = minimapListFor(current);
      if (list === null) {
        throw new Error("missing minimap list scroller");
      }

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      const top = rowLayoutTop(current);
      const bottom = top + ROW_HEIGHT;
      expect(top).toBeGreaterThanOrEqual(list.scrollTop);
      expect(bottom).toBeLessThanOrEqual(list.scrollTop + list.clientHeight);
    } finally {
      restore();
    }
  });
});
