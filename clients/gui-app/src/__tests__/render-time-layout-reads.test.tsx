/**
 * Three `useSyncExternalStore` snapshots used to read layout (a rect,
 * `clientHeight`, `visualViewport`) on every render, which forces a
 * synchronous layout whenever styles are dirty. Each now returns a value that
 * its observer or listener wrote. Every case here drives the source, checks
 * the answer, then re-renders the consumer repeatedly and counts the layout
 * accessors it used to hit: any read during a render is a regression. The
 * worktrees panel's `useObservedHeight` is not exported, so it is covered
 * through the panel in `worktrees-settings-panel.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useComposerNarrowObserver } from "@/components/home/composer/composer-narrow-hooks";
import { useVirtualKeyboardInset } from "@/hooks/ui/use-virtual-keyboard-inset";
import { installFakeResizeObserver } from "@/__tests__/fake-resize-observer";

const EXTRA_RENDERS = 5;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function NarrowProbe(props: { readonly tick: number }): ReactNode {
  const { ref, isNarrow } = useComposerNarrowObserver();
  return (
    <div ref={ref} data-tick={props.tick} data-narrow={String(isNarrow)} />
  );
}

describe("useComposerNarrowObserver", () => {
  function mountObserved() {
    const resizeObservers = installFakeResizeObserver();
    const view = render(<NarrowProbe tick={0} />);
    const observer = resizeObservers.live().at(0);
    if (observer === undefined) throw new Error("composer is not observed");
    return {
      view,
      observer,
      restore: resizeObservers.restore,
      isNarrow: (): string | undefined =>
        view.container.querySelector("div")?.dataset.narrow,
    };
  }

  it("follows the observed border-box width across 512 and keeps the last answer on a zero-width entry", () => {
    const mounted = mountObserved();
    try {
      act(() => mounted.observer.emit({ inline: 600, block: 40 }));
      expect(mounted.isNarrow()).toBe("false");
      act(() => mounted.observer.emit({ inline: 511, block: 40 }));
      expect(mounted.isNarrow()).toBe("true");
      act(() => mounted.observer.emit({ inline: 512, block: 40 }));
      expect(mounted.isNarrow()).toBe("false");
      act(() => mounted.observer.emit({ inline: 300, block: 40 }));
      expect(mounted.isNarrow()).toBe("true");
      // A hidden, retained composer reports zero and keeps the last answer.
      act(() => mounted.observer.emit({ inline: 0, block: 0 }));
      expect(mounted.isNarrow()).toBe("true");
    } finally {
      mounted.restore();
    }
  });

  it("reads contentRect when the entry has no borderBoxSize, without reading layout", () => {
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const mounted = mountObserved();
    try {
      act(() =>
        mounted.observer.emitWithoutBorderBox({ inline: 300, block: 40 }),
      );
      expect(mounted.isNarrow()).toBe("true");
      act(() =>
        mounted.observer.emitWithoutBorderBox({ inline: 700, block: 40 }),
      );
      expect(mounted.isNarrow()).toBe("false");
      expect(rect).not.toHaveBeenCalled();
    } finally {
      mounted.restore();
    }
  });

  it("never reads layout while the consumer re-renders", () => {
    const rect = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 900, 40));
    const mounted = mountObserved();
    try {
      act(() => mounted.observer.emit({ inline: 300, block: 40 }));
      rect.mockClear();
      for (let tick = 1; tick <= EXTRA_RENDERS; tick += 1) {
        mounted.view.rerender(<NarrowProbe tick={tick} />);
      }
      expect(rect).not.toHaveBeenCalled();
    } finally {
      mounted.restore();
    }
  });
});

interface CountedViewport extends EventTarget {
  height: number;
  offsetTop: number;
  scale: number;
}

/** A `visualViewport` whose every property read is counted. */
function installCountingViewport(initial: {
  readonly height: number;
  readonly layoutHeight: number;
}): {
  readonly viewport: CountedViewport;
  readonly reads: () => number;
  /** Times `clientHeight` was read: once per measurement. */
  readonly measurements: () => number;
  readonly resetReads: () => void;
  readonly setLayoutHeight: (height: number) => void;
} {
  let reads = 0;
  let measurements = 0;
  let layoutHeight = initial.layoutHeight;
  let height = initial.height;
  let offsetTop = 0;
  let scale = 1;
  const viewport = Object.assign(new EventTarget(), {});
  Object.defineProperties(viewport, {
    height: {
      get: () => {
        reads += 1;
        return height;
      },
      set: (value: number) => {
        height = value;
      },
    },
    offsetTop: {
      get: () => {
        reads += 1;
        return offsetTop;
      },
      set: (value: number) => {
        offsetTop = value;
      },
    },
    scale: {
      get: () => {
        reads += 1;
        return scale;
      },
      set: (value: number) => {
        scale = value;
      },
    },
  });
  Object.defineProperty(window, "visualViewport", {
    value: viewport,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    get: () => {
      reads += 1;
      measurements += 1;
      return layoutHeight;
    },
    configurable: true,
  });
  return {
    viewport: viewport as CountedViewport,
    reads: () => reads,
    measurements: () => measurements,
    resetReads: () => {
      reads = 0;
      measurements = 0;
    },
    setLayoutHeight: (next) => {
      layoutHeight = next;
    },
  };
}

describe("useVirtualKeyboardInset", () => {
  afterEach(() => {
    Object.defineProperty(window, "visualViewport", {
      value: null,
      configurable: true,
    });
    Reflect.deleteProperty(document.documentElement, "clientHeight");
  });

  function mountInset() {
    const counting = installCountingViewport({
      height: 800,
      layoutHeight: 800,
    });
    const view = renderHook(
      (props: { readonly tick: number }) => {
        void props.tick;
        return useVirtualKeyboardInset();
      },
      { initialProps: { tick: 0 } },
    );
    const measure = (
      viewport: Partial<
        Pick<CountedViewport, "height" | "offsetTop" | "scale">
      >,
    ): number => {
      act(() => {
        Object.assign(counting.viewport, viewport);
        counting.viewport.dispatchEvent(new Event("resize"));
      });
      return view.result.current;
    };
    return { counting, view, measure };
  }

  it("measures the covered strip on viewport events: 120px floor, zoom gives 0", () => {
    const { view, measure } = mountInset();
    expect(view.result.current).toBe(0);

    expect(measure({ height: 500 })).toBe(300);
    expect(measure({ height: 500, offsetTop: 40 })).toBe(260);
    expect(measure({ height: 680, offsetTop: 0 })).toBe(120);
    expect(measure({ height: 681 })).toBe(0);
    expect(measure({ height: 500, scale: 2 })).toBe(0);
    expect(measure({ height: 500, scale: 1 })).toBe(300);
  });

  it("never reads clientHeight or the visual viewport while the consumer re-renders", () => {
    const { counting, view, measure } = mountInset();
    measure({ height: 500 });

    counting.resetReads();
    for (let tick = 1; tick <= EXTRA_RENDERS; tick += 1) {
      view.rerender({ tick });
    }
    expect(counting.reads()).toBe(0);
  });

  it("keeps the cache warm while nothing subscribes: a remount's first render reads the inset a viewport event left behind", () => {
    const { counting, view, measure } = mountInset();
    expect(measure({ height: 500 })).toBe(300);
    view.unmount();

    act(() => {
      counting.viewport.height = 600;
      counting.viewport.dispatchEvent(new Event("resize"));
    });
    const rendered: Array<number> = [];
    renderHook(() => {
      const inset = useVirtualKeyboardInset();
      rendered.push(inset);
      return inset;
    });

    expect(rendered.at(0)).toBe(200);
  });

  it("measures once per viewport event however many components subscribe", () => {
    const { counting, measure } = mountInset();
    const second = renderHook(() => useVirtualKeyboardInset());
    const third = renderHook(() => useVirtualKeyboardInset());

    counting.resetReads();
    const first = measure({ height: 500 });

    expect({
      measurements: counting.measurements(),
      insets: [first, second.result.current, third.result.current],
    }).toEqual({ measurements: 1, insets: [300, 300, 300] });
  });
});
