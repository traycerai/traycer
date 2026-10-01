import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useNavigatorResourceMetrics } from "@/hooks/resources/use-navigator-resource-metrics";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * WHETHER rows print at all is `agentRows`; WHICH readings print is the
 * monitor's own Metrics selection (cpu/memory/processes), in chip order.
 * `ramShare` has no per-row meaning and is always ignored here.
 */
function setResourceMonitor(patch: {
  readonly cpu?: boolean;
  readonly memory?: boolean;
  readonly processes?: boolean;
  readonly ramShare?: boolean;
  readonly agentRows?: boolean;
  readonly shown?: "shown" | "hidden";
}): void {
  useLayoutStore.getState().setRegionValues("resourceMonitor", patch);
}

function resetStore(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
}

beforeEach(resetStore);
afterEach(() => {
  cleanup();
  resetStore();
});

describe("useNavigatorResourceMetrics", () => {
  it("draws the shipped preset's selection: cpu and processes", () => {
    const { result } = renderHook(() => useNavigatorResourceMetrics());

    expect(result.current).toEqual(["cpu", "processes"]);
  });

  it.each<
    [
      Partial<{
        cpu: boolean;
        memory: boolean;
        processes: boolean;
      }>,
      ReadonlyArray<string>,
    ]
  >([
    [{ cpu: true, memory: false, processes: false }, ["cpu"]],
    [{ cpu: false, memory: true, processes: false }, ["memory"]],
    [{ cpu: false, memory: false, processes: true }, ["processes"]],
    [{ cpu: true, memory: true, processes: false }, ["cpu", "memory"]],
    [{ cpu: true, memory: false, processes: true }, ["cpu", "processes"]],
    [{ cpu: false, memory: true, processes: true }, ["memory", "processes"]],
    [
      { cpu: true, memory: true, processes: true },
      ["cpu", "memory", "processes"],
    ],
    [{ cpu: false, memory: false, processes: false }, []],
  ])("selection %o draws %o, in canonical chip order", (patch, expected) => {
    setResourceMonitor(patch);

    const { result } = renderHook(() => useNavigatorResourceMetrics());

    expect(result.current).toEqual(expected);
  });

  it("draws no chips when only RAM share is selected - rows have no per-row RAM share", () => {
    setResourceMonitor({
      cpu: false,
      memory: false,
      processes: false,
      ramShare: true,
    });

    const { result } = renderHook(() => useNavigatorResourceMetrics());

    expect(result.current).toEqual([]);
  });

  it("draws no chips while agentRows is off, whatever the Metrics selection", () => {
    setResourceMonitor({
      cpu: true,
      memory: true,
      processes: true,
      agentRows: false,
    });

    const { result } = renderHook(() => useNavigatorResourceMetrics());

    expect(result.current).toEqual([]);
  });

  it("keeps drawing the selection while the monitor itself is Hidden (G7, L-174)", () => {
    // The rows' switch and the monitor's Shown used to be one control; the
    // browser driver hid the monitor and asserted the agent row kept its
    // readings, then unticked Memory under the Hidden monitor and asserted the
    // row lost it. Both halves are this hook's contract.
    setResourceMonitor({
      cpu: true,
      memory: true,
      processes: false,
      shown: "hidden",
    });
    const { result } = renderHook(() => useNavigatorResourceMetrics());
    expect(result.current).toEqual(["cpu", "memory"]);

    act(() => {
      setResourceMonitor({ memory: false });
    });
    expect(result.current).toEqual(["cpu"]);
  });

  it("stays empty while the monitor is Shown but the rows' switch is off", () => {
    setResourceMonitor({ agentRows: false, shown: "shown" });

    const { result } = renderHook(() => useNavigatorResourceMetrics());

    expect(result.current).toEqual([]);
  });

  it("returns a referentially stable array across rerenders with unchanged values", () => {
    const { result, rerender } = renderHook(() =>
      useNavigatorResourceMetrics(),
    );
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
