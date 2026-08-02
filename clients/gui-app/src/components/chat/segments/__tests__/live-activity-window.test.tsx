import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_ACTIVITY_WINDOW_EXIT_MS,
  LiveActivityWindow,
} from "@/components/chat/segments/live-activity-window";

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

  // The transcript listens for `wheel` NATIVELY, on the LegendList scroll node,
  // and `chatWheelShouldCancelLiveFollow` returns true for every upward delta -
  // so any wheel that reaches it drops the reader into free-scrolling with a
  // jump-to-latest pill. `overscroll-behavior: contain` does not help: it stops
  // scroll CHAINING, not event propagation. Only stopping the event does.
  //
  // These assert against a listener on an ANCESTOR, which is what the transcript
  // actually is. A className assertion cannot fail for a behavioural reason.
  it("stops a wheel gesture from reaching the transcript while it can scroll", () => {
    withStubbedGeometry({ scrollHeight: 400, clientHeight: 100 }, () => {
      const reachedTranscript: WheelEvent[] = [];
      const listener = (event: Event): void => {
        reachedTranscript.push(event as WheelEvent);
      };
      document.addEventListener("wheel", listener);
      try {
        render(
          <LiveActivityWindow shown>
            <div>row one</div>
          </LiveActivityWindow>,
        );

        screen
          .getByTestId("activity-live-window-scroller")
          .dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: -50 }),
          );

        expect(reachedTranscript).toHaveLength(0);
      } finally {
        document.removeEventListener("wheel", listener);
      }
    });
  });

  it("lets the wheel through when it has nothing to scroll, so it is not a dead zone", () => {
    withStubbedGeometry({ scrollHeight: 100, clientHeight: 100 }, () => {
      const reachedTranscript: WheelEvent[] = [];
      const listener = (event: Event): void => {
        reachedTranscript.push(event as WheelEvent);
      };
      document.addEventListener("wheel", listener);
      try {
        render(
          <LiveActivityWindow shown>
            <div>row one</div>
          </LiveActivityWindow>,
        );

        screen
          .getByTestId("activity-live-window-scroller")
          .dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: -50 }),
          );

        // A window with nothing hidden cannot consume the gesture. Swallowing
        // it would leave the reader unable to scroll the transcript at all
        // while the pointer happens to sit over a one-row window.
        expect(reachedTranscript).toHaveLength(1);
      } finally {
        document.removeEventListener("wheel", listener);
      }
    });
  });

  // The transcript ALSO cancels live-follow from a plain React `onPointerDown`.
  // That one is synthetic, so unlike the wheel it is stopped by React's own
  // propagation - but it still has to be stopped.
  it("stops a pointer press from reaching the transcript's React handler", () => {
    const reachedTranscript: string[] = [];
    render(
      <div
        onPointerDown={() => {
          reachedTranscript.push("transcript");
        }}
      >
        <LiveActivityWindow shown>
          <div>row one</div>
        </LiveActivityWindow>
      </div>,
    );

    fireEvent.pointerDown(
      screen.getByTestId("activity-live-window-scroller"),
      {},
    );

    expect(reachedTranscript).toHaveLength(0);
  });

  // `pinnedRef` lives on the component, which outlives the scroller: the window
  // stays mounted for the whole run and only returns null between folds. So a
  // pin suspended by scrolling up would survive into the NEXT scroller - one
  // that starts at `scrollTop = 0` - and the window would sit frozen on the
  // oldest rows while the run streamed on.
  it("re-pins when a fold replaces the scroller, so reopening resumes at the tail", () => {
    withStubbedGeometry({ scrollHeight: 400, clientHeight: 100 }, () => {
      const { rerender } = render(
        <LiveActivityWindow shown>
          <div>row one</div>
        </LiveActivityWindow>,
      );

      // The reader scrolls up to re-read something, suspending the pin.
      const scroller = screen.getByTestId("activity-live-window-scroller");
      scroller.scrollTop = 40;
      fireEvent.scroll(scroller);

      // The group is opened: the window folds away and unmounts its scroller.
      vi.useFakeTimers();
      try {
        rerender(
          <LiveActivityWindow shown={false}>
            <div>row one</div>
          </LiveActivityWindow>,
        );
        act(() => {
          vi.advanceTimersByTime(LIVE_ACTIVITY_WINDOW_EXIT_MS);
        });
        expect(
          screen.queryByTestId("activity-live-window-scroller"),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }

      // Closed again while the run is still going: a brand new scroller.
      rerender(
        <LiveActivityWindow shown>
          <div>row one</div>
          <div>row two</div>
        </LiveActivityWindow>,
      );

      expect(
        screen.getByTestId("activity-live-window-scroller").scrollTop,
      ).toBe(400);
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
