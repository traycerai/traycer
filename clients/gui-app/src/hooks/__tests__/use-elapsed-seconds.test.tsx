import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";

function ElapsedLeaf(props: {
  readonly startMs: number;
  readonly pausedDurationMs: number;
  readonly pausedSinceMs: number | null;
}): ReactNode {
  const seconds = useElapsedSeconds(
    props.startMs,
    props.pausedDurationMs,
    props.pausedSinceMs,
  );
  return <span data-testid="elapsed">{seconds}</span>;
}

function ElapsedProbe(props: {
  readonly startMs: number;
  readonly pausedDurationMs: number;
  readonly pausedSinceMs: number | null;
  readonly visible: boolean;
  readonly tabSelected: boolean;
}): ReactNode {
  return (
    <PaneVisibilityContext.Provider value={props.visible}>
      <TabBodySelectedContext.Provider value={props.tabSelected}>
        <ElapsedLeaf
          startMs={props.startMs}
          pausedDurationMs={props.pausedDurationMs}
          pausedSinceMs={props.pausedSinceMs}
        />
      </TabBodySelectedContext.Provider>
    </PaneVisibilityContext.Provider>
  );
}

function elapsedText(): string {
  return screen.getByTestId("elapsed").textContent;
}

describe("useElapsedSeconds", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ticks once per second while visible and running (baseline, unchanged)", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const startMs = now - 10_000;
    render(
      <ElapsedProbe
        startMs={startMs}
        pausedDurationMs={0}
        pausedSinceMs={null}
        visible
        tabSelected
      />,
    );
    expect(elapsedText()).toBe("10");
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(elapsedText()).toBe("13");
  });

  it("schedules no interval while hidden, and stops an already-running one when hidden mid-flight", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const startMs = now - 10_000;
    const { rerender } = render(
      <ElapsedProbe
        startMs={startMs}
        pausedDurationMs={0}
        pausedSinceMs={null}
        visible={false}
        tabSelected
      />,
    );
    expect(elapsedText()).toBe("10");
    // Falsification: a hook that arms its 1s interval regardless of pane
    // visibility (the pre-fix shape) leaves a pending timer here.
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // No timer was ever armed, so 5 real seconds passing cannot have moved it.
    expect(elapsedText()).toBe("10");

    act(() => {
      rerender(
        <ElapsedProbe
          startMs={startMs}
          pausedDurationMs={0}
          pausedSinceMs={null}
          visible
          tabSelected
        />,
      );
    });
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      rerender(
        <ElapsedProbe
          startMs={startMs}
          pausedDurationMs={0}
          pausedSinceMs={null}
          visible={false}
          tabSelected
        />,
      );
    });
    // Falsification: a hook whose effect never re-runs on a visibility
    // change (an empty dependency array, the pre-fix shape) leaves the
    // ALREADY-ARMED interval running instead of clearing it. Checking "no
    // NEW setInterval call" alone would miss this, since neither version
    // calls setInterval again on this transition.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches up wall time immediately on reveal, instead of waiting for the next 1s fire", () => {
    vi.useFakeTimers();
    const mountAt = Date.now();
    const startMs = mountAt - 10_000;
    const { rerender } = render(
      <ElapsedProbe
        startMs={startMs}
        pausedDurationMs={0}
        pausedSinceMs={null}
        visible={false}
        tabSelected
      />,
    );
    expect(elapsedText()).toBe("10");

    // 5s pass while hidden; nothing is subscribed to observe them.
    // (`advanceTimersByTime` itself moves the fake system clock forward, so
    // this alone lands at `mountAt + 5_000` - no separate `setSystemTime`.)
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(elapsedText()).toBe("10");

    // Reveal: the very next render must already show 15s (10 + the 5 that
    // passed while hidden) - a fresh sample, not a stale one waiting on the
    // next interval fire.
    act(() => {
      rerender(
        <ElapsedProbe
          startMs={startMs}
          pausedDurationMs={0}
          pausedSinceMs={null}
          visible
          tabSelected
        />,
      );
    });
    expect(elapsedText()).toBe("15");

    // And ticking resumes normally from there.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(elapsedText()).toBe("16");
  });

  it("schedules no interval and freezes at the paused instant while pausedSinceMs is set", () => {
    vi.useFakeTimers();
    const mountAt = Date.now();
    const startMs = mountAt - 10_000;
    const { rerender } = render(
      <ElapsedProbe
        startMs={startMs}
        pausedDurationMs={0}
        pausedSinceMs={null}
        visible
        tabSelected
      />,
    );
    expect(elapsedText()).toBe("10");

    act(() => {
      rerender(
        <ElapsedProbe
          startMs={startMs}
          pausedDurationMs={0}
          pausedSinceMs={mountAt}
          visible
          tabSelected
        />,
      );
    });
    // Falsification: a hook whose effect never re-runs on this prop change
    // (an empty dependency array, the pre-fix shape) also calls no NEW
    // `setInterval` here - the value happens to net out the same too - but
    // leaves the ORIGINAL interval running instead of clearing it. Only the
    // timer count actually distinguishes the two.
    expect(vi.getTimerCount()).toBe(0);
    expect(elapsedText()).toBe("10");

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // Frozen: no timer means the label cannot move even though 5 more real
    // seconds passed.
    expect(elapsedText()).toBe("10");
  });

  it("resuming immediately catches up wall time and correctly excludes the paused window from elapsed", () => {
    vi.useFakeTimers();
    const mountAt = Date.now();
    const startMs = mountAt - 10_000;
    const pausedAt = mountAt;
    const { rerender } = render(
      <ElapsedProbe
        startMs={startMs}
        pausedDurationMs={0}
        pausedSinceMs={pausedAt}
        visible
        tabSelected
      />,
    );
    expect(elapsedText()).toBe("10");

    // The pause lasts 8s of real/system time, with no interval running to
    // observe it.
    act(() => {
      vi.setSystemTime(mountAt + 8_000);
    });

    // Resume: the caller folds the completed pause into pausedDurationMs, the
    // same way every production call site accumulates a finished pause.
    act(() => {
      rerender(
        <ElapsedProbe
          startMs={startMs}
          pausedDurationMs={8_000}
          pausedSinceMs={null}
          visible
          tabSelected
        />,
      );
    });
    // Falsification: without the immediate re-sample on resume, this would
    // still read a stale value rather than 10 (the paused window correctly
    // excluded from elapsed).
    expect(elapsedText()).toBe("10");

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(elapsedText()).toBe("13");
  });

  it("schedules no interval while the pane is visible but its tab is not the selected one (useTileBodyVisible)", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const startMs = now - 10_000;
    render(
      <ElapsedProbe
        startMs={startMs}
        pausedDurationMs={0}
        pausedSinceMs={null}
        visible
        tabSelected={false}
      />,
    );
    expect(elapsedText()).toBe("10");
    // Falsification: a hook still gated on usePaneVisible() alone (the
    // pre-W2-H2 shape) arms its interval here, since the pane itself is
    // visible - only the tab is unselected.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches up wall time immediately when the tab becomes the selected one again", () => {
    vi.useFakeTimers();
    const mountAt = Date.now();
    const startMs = mountAt - 10_000;
    const { rerender } = render(
      <ElapsedProbe
        startMs={startMs}
        pausedDurationMs={0}
        pausedSinceMs={null}
        visible
        tabSelected={false}
      />,
    );
    expect(elapsedText()).toBe("10");

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(elapsedText()).toBe("10");

    act(() => {
      rerender(
        <ElapsedProbe
          startMs={startMs}
          pausedDurationMs={0}
          pausedSinceMs={null}
          visible
          tabSelected
        />,
      );
    });
    expect(elapsedText()).toBe("15");
    expect(vi.getTimerCount()).toBe(1);
  });
});
