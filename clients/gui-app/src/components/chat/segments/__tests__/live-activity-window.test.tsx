import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveActivityWindow } from "@/components/chat/segments/live-activity-window";

/**
 * jsdom does no layout, so `scrollHeight`/`clientHeight` are 0 and the window
 * would never look overflowing. Stub the pair for the duration of one test so
 * the tail-pin and the measured overflow flag are exercised against a geometry
 * that actually overflows.
 */
function withStubbedGeometry(
  geometry: { readonly scrollHeight: number; readonly clientHeight: number },
  run: () => void,
): void {
  const scrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  const clientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => geometry.scrollHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => geometry.clientHeight,
  });
  try {
    run();
  } finally {
    restore("scrollHeight", scrollHeight);
    restore("clientHeight", clientHeight);
  }
}

function restore(
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, property);
    return;
  }
  Object.defineProperty(HTMLElement.prototype, property, descriptor);
}

describe("<LiveActivityWindow />", () => {
  afterEach(() => {
    cleanup();
  });

  it("pins to the newest row as content arrives", () => {
    withStubbedGeometry({ scrollHeight: 400, clientHeight: 100 }, () => {
      const { rerender } = render(
        <LiveActivityWindow shown>
          <div>row one</div>
        </LiveActivityWindow>,
      );

      const scroller = screen.getByTestId("activity-live-window-scroller");
      expect(scroller.scrollTop).toBe(400);

      // A row arrives; the window must still be showing the tail, not the top.
      scroller.scrollTop = 0;
      rerender(
        <LiveActivityWindow shown>
          <div>row one</div>
          <div>row two</div>
        </LiveActivityWindow>,
      );

      expect(scroller.scrollTop).toBe(400);
    });
  });

  it("suspends the pin once the reader scrolls up, and resumes at the bottom", () => {
    withStubbedGeometry({ scrollHeight: 400, clientHeight: 100 }, () => {
      const { rerender } = render(
        <LiveActivityWindow shown>
          <div>row one</div>
        </LiveActivityWindow>,
      );

      const scroller = screen.getByTestId("activity-live-window-scroller");

      // Scroll well clear of the bottom (400 - 40 - 100 = 260px of slack).
      scroller.scrollTop = 40;
      fireEvent.scroll(scroller);

      rerender(
        <LiveActivityWindow shown>
          <div>row one</div>
          <div>row two</div>
        </LiveActivityWindow>,
      );

      // Reading an earlier row must not be yanked back to the tail by the next
      // token that arrives.
      expect(scroller.scrollTop).toBe(40);

      // Returning to the bottom re-arms the pin (400 - 295 - 100 = 5px < the
      // 16px slack).
      scroller.scrollTop = 295;
      fireEvent.scroll(scroller);

      rerender(
        <LiveActivityWindow shown>
          <div>row one</div>
          <div>row two</div>
          <div>row three</div>
        </LiveActivityWindow>,
      );

      expect(scroller.scrollTop).toBe(400);
    });
  });

  it("flags overflow only when the content actually exceeds the bound", () => {
    withStubbedGeometry({ scrollHeight: 400, clientHeight: 100 }, () => {
      render(
        <LiveActivityWindow shown>
          <div>tall</div>
        </LiveActivityWindow>,
      );
      expect(
        screen.getByTestId("activity-live-window-scroller").dataset.overflowing,
      ).toBe("true");
    });

    cleanup();

    withStubbedGeometry({ scrollHeight: 100, clientHeight: 100 }, () => {
      render(
        <LiveActivityWindow shown>
          <div>short</div>
        </LiveActivityWindow>,
      );
      // The top fade is gated on this flag: a just-started run with one row
      // must not have its only line dimmed into near-invisibility.
      expect(
        screen.getByTestId("activity-live-window-scroller").dataset.overflowing,
      ).toBe("false");
    });
  });
});
