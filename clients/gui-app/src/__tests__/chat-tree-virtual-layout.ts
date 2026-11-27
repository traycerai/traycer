import { act } from "@testing-library/react";
import type * as ReactVirtual from "@tanstack/react-virtual";

/**
 * Layout for the virtualised chat tree under jsdom, which lays nothing out.
 * The list must pass its own `measureElement` option built on the module's
 * `measureElement` export, which is what this replaces.
 *
 * jsdom reports every element as 0px: the tree's scroller would show no rows
 * and every row would measure 0px tall. This stands in for the browser's half
 * of the virtualizer - the scroller's size, its scroll offset, each row's
 * measured height and the scroll the list asks for - and leaves everything
 * else, the windowing, the pins and the rows, to the real code.
 *
 * Use it from a test file:
 *
 *   vi.mock("@tanstack/react-virtual", async (importOriginal) =>
 *     (await import("@/__tests__/chat-tree-virtual-layout")).mockReactVirtual(
 *       importOriginal,
 *     ),
 *   );
 *   import { chatTreeLayout } from "@/__tests__/chat-tree-virtual-layout";
 *   beforeEach(() => chatTreeLayout.reset());
 *
 * By default the viewport is tall enough for every row and each row measures
 * its estimate, so a test about something other than the windowing sees every
 * row the tree draws.
 *
 * Row heights reach the list through the module's `measureElement` export - the
 * DOM reader - so the list's own handling of what it reads stays under test.
 * `hide()` and `show()` model a retained tab going `display: none` and back as
 * a browser does: while hidden the scroller and every row measure 0px, no
 * scroll event fires, and showing it fires one at the offset it was hidden at.
 */

type RowHeight = (key: string, index: number, estimate: number) => number;

const TALL_VIEWPORT_PX = 10_000;
const VIEWPORT_WIDTH_PX = 320;

interface LayoutState {
  viewportHeight: number;
  rowHeight: RowHeight | null;
  offset: number;
  hidden: boolean;
  /** One per mounted list: re-reads its rendered rows. */
  readonly remeasurers: Set<() => void>;
  readonly rectListeners: Set<
    (rect: { width: number; height: number }) => void
  >;
  readonly offsetListeners: Set<(offset: number, isScrolling: boolean) => void>;
  readonly scrollRequests: number[];
}

const state: LayoutState = {
  viewportHeight: TALL_VIEWPORT_PX,
  rowHeight: null,
  offset: 0,
  hidden: false,
  remeasurers: new Set(),
  rectListeners: new Set(),
  offsetListeners: new Set(),
  scrollRequests: [],
};

function notifyOffset(): void {
  for (const listener of state.offsetListeners) listener(state.offset, false);
}

function notifyRect(): void {
  const height = state.hidden ? 0 : state.viewportHeight;
  for (const listener of state.rectListeners) {
    listener({ width: state.hidden ? 0 : VIEWPORT_WIDTH_PX, height });
  }
}

/** Re-reads every mounted row, as a ResizeObserver would after a size change. */
function remeasureRows(): void {
  for (const remeasure of state.remeasurers) remeasure();
}

function trackList<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  instance: ReactVirtual.Virtualizer<TScrollElement, TItemElement>,
): () => void {
  const remeasure = (): void => {
    const scroller = instance.scrollElement;
    if (scroller === null) return;
    for (const row of scroller.querySelectorAll<TItemElement>("[data-index]")) {
      instance.measureElement(row);
    }
  };
  state.remeasurers.add(remeasure);
  return () => {
    state.remeasurers.delete(remeasure);
  };
}

export const chatTreeLayout = {
  /** Back to the defaults: a viewport every row fits in, scrolled to the top. */
  reset(): void {
    state.viewportHeight = TALL_VIEWPORT_PX;
    state.rowHeight = null;
    state.offset = 0;
    state.hidden = false;
    state.scrollRequests.length = 0;
  },
  /** The scroller's visible height. Applies to lists mounted from now on and to mounted ones. */
  setViewport(height: number): void {
    state.viewportHeight = height;
    notifyRect();
  },
  /** The tab goes `display: none`: everything measures 0px; no scroll event. */
  hide(): void {
    act(() => {
      state.hidden = true;
      notifyRect();
      remeasureRows();
    });
  },
  /** The tab shows again, and the browser restores the offset it was hidden at. */
  show(): void {
    act(() => {
      state.hidden = false;
      notifyRect();
      remeasureRows();
      notifyOffset();
    });
  },
  /** Each row's measured height, by row key and index; the estimate when unset. */
  setRowHeight(rowHeight: RowHeight | null): void {
    state.rowHeight = rowHeight;
  },
  /** Scrolls the list as a person would, and lets it re-render. */
  scrollTo(offset: number): void {
    act(() => {
      state.offset = offset;
      notifyOffset();
    });
  },
  /** The current scroll offset, wherever it came from. */
  scrollOffset(): number {
    return state.offset;
  },
  /** Every offset the list scrolled itself to, oldest first. */
  scrollRequests(): readonly number[] {
    return state.scrollRequests;
  },
};

/** The module mock: the real `@tanstack/react-virtual`, laid out by `chatTreeLayout`. */
export async function mockReactVirtual(
  importOriginal: () => Promise<typeof ReactVirtual>,
): Promise<typeof ReactVirtual> {
  const actual = await importOriginal();
  return {
    ...actual,
    measureElement: (element, _entry, instance) => {
      if (state.hidden) return 0;
      const index = Number(element.getAttribute("data-index"));
      const estimate = instance.options.estimateSize(index);
      const key = element.getAttribute("data-row-key") ?? String(index);
      return state.rowHeight === null
        ? estimate
        : state.rowHeight(key, index, estimate);
    },
    useVirtualizer: (options) =>
      actual.useVirtualizer({
        ...options,
        observeElementRect: (instance, onRect) => {
          const untrack = trackList(instance);
          const scroller = instance.scrollElement;
          // jsdom reports a scrollHeight of 0, which the virtualizer reads as
          // "nothing to scroll" and clamps every scroll to 0.
          if (scroller !== null) {
            Object.defineProperty(scroller, "scrollHeight", {
              configurable: true,
              get: () =>
                Math.max(instance.getTotalSize(), state.viewportHeight),
            });
          }
          state.rectListeners.add(onRect);
          onRect({
            width: state.hidden ? 0 : VIEWPORT_WIDTH_PX,
            height: state.hidden ? 0 : state.viewportHeight,
          });
          return () => {
            untrack();
            state.rectListeners.delete(onRect);
          };
        },
        observeElementOffset: (_instance, onOffset) => {
          state.offsetListeners.add(onOffset);
          onOffset(state.offset, false);
          return () => {
            state.offsetListeners.delete(onOffset);
          };
        },
        scrollToFn: (offset, scrollOptions) => {
          const target = offset + (scrollOptions.adjustments ?? 0);
          state.scrollRequests.push(target);
          state.offset = target;
          notifyOffset();
        },
      }),
  };
}
