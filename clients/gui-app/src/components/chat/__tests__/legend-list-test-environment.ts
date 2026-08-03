import { act } from "@testing-library/react";
import { onTestFinished, vi } from "vitest";

const VIEWPORT_HEIGHT_PX = 700;
const VIEWPORT_WIDTH_PX = 800;
const ITEM_HEIGHT_PX = 90;
const SPACER_HEIGHT_PX = 40;
const LARGE_CONTENT_ROW_COUNT = 400;

/**
 * Optional override for the scroll container's `scrollHeight` (not list-item
 * shells). Default is a large constant so virtualization has work to do.
 * Ticket 18 pin B needs a realistic max-scroll so following-end does not park
 * at the inflated 36_000px ceiling (which makes every near send look "far"
 * under the 1.5-viewport animated split). Call with `null` to restore default.
 */
let scrollContainerScrollHeightOverridePx: number | null = null;
let messageRowHeightOverrides = new Map<string, number>();

export function setLegendListScrollContainerScrollHeightOverride(
  heightPx: number | null,
): void {
  scrollContainerScrollHeightOverridePx = heightPx;
  if (heightPx !== null) {
    onTestFinished(() => {
      scrollContainerScrollHeightOverridePx = null;
    });
  }
}

export function setLegendListMessageRowHeightOverrides(
  heights: ReadonlyMap<string, number>,
): void {
  messageRowHeightOverrides = new Map(heights);
  onTestFinished(() => {
    messageRowHeightOverrides = new Map();
  });
}

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
    const ownMessageId = element.getAttribute("data-message-id");
    const nestedMessageId = element
      .querySelector<HTMLElement>("[data-message-id]")
      ?.getAttribute("data-message-id");
    const messageId = ownMessageId ?? nestedMessageId;
    if (typeof messageId === "string") {
      const override = messageRowHeightOverrides.get(messageId);
      if (override !== undefined) return override;
    }
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

  const getBoundingClientRectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return rectOf(0, 0, VIEWPORT_WIDTH_PX, heightFor(this));
    });

  const clientHeightSpy = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return heightFor(this);
    });
  const clientWidthSpy = vi
    .spyOn(HTMLElement.prototype, "clientWidth", "get")
    .mockImplementation(function () {
      return VIEWPORT_WIDTH_PX;
    });
  const offsetHeightSpy = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return heightFor(this);
    });
  const offsetWidthSpy = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockImplementation(function () {
      return VIEWPORT_WIDTH_PX;
    });
  const scrollHeightSpy = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      if (isListItemShell(this) || isSpacerShell(this)) {
        return heightFor(this);
      }
      if (scrollContainerScrollHeightOverridePx !== null) {
        return scrollContainerScrollHeightOverridePx;
      }
      // Large enough that virtualization has work to do.
      return LARGE_CONTENT_ROW_COUNT * ITEM_HEIGHT_PX;
    });
  const scrollWidthSpy = vi
    .spyOn(HTMLElement.prototype, "scrollWidth", "get")
    .mockImplementation(function () {
      return VIEWPORT_WIDTH_PX;
    });

  // jsdom's scrollTop setter is a no-op; LegendList's initialScrollAtEnd
  // bootstrap only converges when native scroll offsets stick.
  const scrollTopGetSpy = vi
    .spyOn(HTMLElement.prototype, "scrollTop", "get")
    .mockImplementation(function (this: HTMLElement) {
      return scrollTopByElement.get(this) ?? 0;
    });
  const scrollTopSetSpy = vi
    .spyOn(HTMLElement.prototype, "scrollTop", "set")
    .mockImplementation(function (this: HTMLElement, value: number) {
      scrollTopByElement.set(this, value);
    });
  const scrollLeftGetSpy = vi
    .spyOn(HTMLElement.prototype, "scrollLeft", "get")
    .mockImplementation(function (this: HTMLElement) {
      return scrollLeftByElement.get(this) ?? 0;
    });
  const scrollLeftSetSpy = vi
    .spyOn(HTMLElement.prototype, "scrollLeft", "set")
    .mockImplementation(function (this: HTMLElement, value: number) {
      scrollLeftByElement.set(this, value);
    });

  // jsdom does not define HTMLElement.scrollTo. Seed a configurable no-op so
  // Vitest can spy on it, then remove that seed after restoreAllMocks puts it
  // back; the prototype leaves each test exactly as it entered.
  const seededScrollTo = !Object.hasOwn(HTMLElement.prototype, "scrollTo");
  if (seededScrollTo) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
    onTestFinished(() => {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    });
  }
  const scrollToSpy = vi
    .spyOn(HTMLElement.prototype, "scrollTo")
    .mockImplementation(function scrollToShim(
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
    });

  onTestFinished(() => {
    scrollToSpy.mockRestore();
    scrollLeftSetSpy.mockRestore();
    scrollLeftGetSpy.mockRestore();
    scrollTopSetSpy.mockRestore();
    scrollTopGetSpy.mockRestore();
    scrollWidthSpy.mockRestore();
    scrollHeightSpy.mockRestore();
    offsetWidthSpy.mockRestore();
    offsetHeightSpy.mockRestore();
    clientWidthSpy.mockRestore();
    clientHeightSpy.mockRestore();
    getBoundingClientRectSpy.mockRestore();
    if (seededScrollTo) {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
  });
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
