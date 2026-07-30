import { act } from "@testing-library/react";
import { vi } from "vitest";

const VIEWPORT_HEIGHT_PX = 700;
const VIEWPORT_WIDTH_PX = 800;
const ITEM_HEIGHT_PX = 90;
const SPACER_HEIGHT_PX = 40;
const LARGE_CONTENT_ROW_COUNT = 400;

function rectOf(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  };
}

function isListItemShell(element: HTMLElement): boolean {
  return (
    element.hasAttribute("data-message-id") ||
    element.hasAttribute("data-index")
  );
}

function isSpacerShell(element: HTMLElement): boolean {
  if (element.getAttribute("aria-hidden") === "true") {
    return true;
  }
  const child = element.firstElementChild;
  return (
    child instanceof HTMLElement && child.getAttribute("aria-hidden") === "true"
  );
}

function heightFor(element: HTMLElement): number {
  if (isListItemShell(element)) {
    return ITEM_HEIGHT_PX;
  }
  if (isSpacerShell(element)) {
    return SPACER_HEIGHT_PX;
  }
  return VIEWPORT_HEIGHT_PX;
}

/**
 * jsdom reports zero-size boxes and a non-sticky scrollTop, so LegendList's
 * layout + `initialScrollAtEnd` bootstrap never settle. Give the scroller a
 * real viewport, stick scroll offsets, measure virtualized rows at the
 * estimated item height, and measure header/footer spacers realistically (a
 * 700px footer breaks bottom-aligned bootstrap in jsdom). Shared between
 * `chat-timeline.test.tsx` and any other suite that mounts a real (unmocked)
 * `@legendapp/list` instance - the old message-list library's testing
 * context had no LegendList equivalent, so this replaces it.
 */
export function installLegendListViewportMetrics(): void {
  const scrollTopByElement = new WeakMap<HTMLElement, number>();
  const scrollLeftByElement = new WeakMap<HTMLElement, number>();

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return rectOf(0, 0, VIEWPORT_WIDTH_PX, heightFor(this));
    },
  );

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return heightFor(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return VIEWPORT_WIDTH_PX;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return heightFor(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return VIEWPORT_WIDTH_PX;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (isListItemShell(this) || isSpacerShell(this)) {
        return heightFor(this);
      }
      // Large enough that virtualization has work to do.
      return LARGE_CONTENT_ROW_COUNT * ITEM_HEIGHT_PX;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return VIEWPORT_WIDTH_PX;
    },
  });

  // jsdom's scrollTop setter is a no-op; LegendList's initialScrollAtEnd
  // bootstrap only converges when native scroll offsets stick.
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTopByElement.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollTopByElement.set(this, value);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollLeftByElement.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollLeftByElement.set(this, value);
    },
  });

  HTMLElement.prototype.scrollTo = function scrollToShim(
    this: HTMLElement,
    ...args: Array<number | ScrollToOptions | undefined>
  ): void {
    const first = args[0];
    if (typeof first === "number") {
      const second = args[1];
      this.scrollLeft = first;
      this.scrollTop = typeof second === "number" ? second : 0;
      return;
    }
    if (typeof first === "object") {
      if (typeof first.left === "number") {
        this.scrollLeft = first.left;
      }
      if (typeof first.top === "number") {
        this.scrollTop = first.top;
      }
    }
  };
}

/**
 * LegendList's `initialScrollAtEnd` bootstrap and layout measurement need a
 * few frames plus its scroll-finish fallback (hundreds of ms) in jsdom.
 */
export async function settleLegendList(): Promise<void> {
  await act(async () => {
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
  });
}
