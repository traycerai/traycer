/**
 * W2-H2: `useElapsedSeconds` resamples wall time in a `useLayoutEffect` (so a
 * reveal or a resume already shows the correct second before the browser
 * paints), while interval ownership stays in a passive `useEffect`. An
 * ordinary `act()`-flushed test cannot tell those two apart: React flushes
 * layout AND passive effects before `rerender()` returns either way, so the
 * committed DOM looks identical whether the resample runs in the layout or
 * the passive phase.
 *
 * This file gets a real boundary by replacing `react`'s `useEffect` export
 * with one that CAPTURES callbacks instead of invoking them (never handing
 * them to React's own dispatcher) - every passive effect in this tree,
 * including the hook's own interval-arming one, is queued and never runs.
 * `useLayoutEffect` is untouched. If the resample still shows up correctly
 * with every passive effect withheld, it cannot have come from a passive
 * effect - only a layout effect runs unconditionally in this setup.
 *
 * Isolated in its own file (rather than added to use-elapsed-seconds.test.tsx)
 * because `vi.mock("react", ...)` is file-global: layered into the main
 * suite, it would silently withhold every OTHER test's interval-arming
 * effect too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";

const pendingPassiveEffects = vi.hoisted(() => ({
  queue: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      pendingPassiveEffects.queue.push(effect);
    },
  };
});

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
}): ReactNode {
  return (
    <PaneVisibilityContext.Provider value={props.visible}>
      <ElapsedLeaf
        startMs={props.startMs}
        pausedDurationMs={props.pausedDurationMs}
        pausedSinceMs={props.pausedSinceMs}
      />
    </PaneVisibilityContext.Provider>
  );
}

describe("useElapsedSeconds resample runs in the layout-effect commit, not a passive effect", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    pendingPassiveEffects.queue.length = 0;
  });

  it("shows the resampled elapsed time immediately on reveal, before any passive effect - including the hook's own interval-arming one - has run", () => {
    vi.useFakeTimers();
    const mountAt = Date.now();
    const startMs = mountAt - 10_000;
    const { rerender, getByTestId } = render(
      <ElapsedProbe
        startMs={startMs}
        pausedDurationMs={0}
        pausedSinceMs={null}
        visible={false}
      />,
    );
    expect(getByTestId("elapsed").textContent).toBe("10");
    // Sanity check on the mock itself: at least one passive effect (the
    // hook's own interval-arming one) was captured and withheld. If this
    // were ever 0, the mock would not be engaged and the test below would
    // prove nothing.
    expect(pendingPassiveEffects.queue.length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // No interval was ever actually armed (its callback sits in the queue,
    // uninvoked), so 5s of fake time passing while hidden cannot have moved
    // this on its own - confirms the queue is genuinely inert, not just
    // unobserved.
    expect(getByTestId("elapsed").textContent).toBe("10");

    act(() => {
      rerender(
        <ElapsedProbe
          startMs={startMs}
          pausedDurationMs={0}
          pausedSinceMs={null}
          visible
        />,
      );
    });
    // Falsification: switching the resample effect in use-elapsed-seconds.ts
    // from `useLayoutEffect` to `useEffect` routes it through this SAME
    // mock, so it too is captured and never invoked - this assertion goes
    // red (stays "10") on that mutation, since nothing in this tree ever
    // actually runs a passive effect.
    expect(getByTestId("elapsed").textContent).toBe("15");
  });
});
