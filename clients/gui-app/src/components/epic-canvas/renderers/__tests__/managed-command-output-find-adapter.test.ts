import { describe, expect, it, vi } from "vitest";
import type { ManagedCommandTimelineLine } from "@/stores/managed-commands/managed-command-output-store";
import {
  createManagedCommandOutputFindAdapter,
  MANAGED_COMMAND_OUTPUT_FIND_COVERAGE_MESSAGE,
  type ManagedCommandOutputFindEnvironment,
  type ManagedCommandOutputFindMatch,
} from "../managed-command-output-find-adapter";

function line(seq: number, text: string): ManagedCommandTimelineLine {
  return {
    seq,
    text,
    channel: "stdout",
    atMs: 0,
    frameStart: null,
  };
}

function environment(
  overrides: Partial<ManagedCommandOutputFindEnvironment> & {
    readonly revealMatch: (match: ManagedCommandOutputFindMatch) => void;
  },
): ManagedCommandOutputFindEnvironment {
  return {
    lines: [],
    available: true,
    reachedStart: true,
    detached: false,
    ...overrides,
  };
}

describe("createManagedCommandOutputFindAdapter", () => {
  it("starts unavailable until the log is readable", () => {
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });

    expect(adapter.getSnapshot()).toMatchObject({
      status: "unavailable",
      coverageMessage: "Output is not available for search.",
      exactHighlight: "none",
    });
    expect(adapter.getSnapshot().capabilities.has("find")).toBe(false);
    expect(adapter.replace).toBeNull();
  });

  it("reports a custom unavailable message and ignores search", () => {
    const revealMatch = vi.fn();
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    adapter.updateEnvironment(
      environment({
        available: "Output is still loading.",
        revealMatch,
      }),
    );

    adapter.search({ requestId: 1, query: "alpha", matchCase: false });

    expect(adapter.getSnapshot()).toMatchObject({
      requestId: 1,
      status: "unavailable",
      query: "alpha",
      coverageMessage: "Output is still loading.",
      current: 0,
      total: 0,
    });
    expect(adapter.getSnapshot().capabilities.has("find")).toBe(false);
    expect(adapter.getMatches()).toEqual([]);
    expect(revealMatch).not.toHaveBeenCalled();
  });

  it("matches case-insensitively by default and honors matchCase", () => {
    const revealMatch = vi.fn();
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    adapter.updateEnvironment(
      environment({
        lines: [line(0, "alpha"), line(1, "Beta alpha"), line(2, "ALPHA")],
        revealMatch,
      }),
    );

    adapter.search({ requestId: 1, query: "alpha", matchCase: false });
    expect(adapter.getSnapshot()).toMatchObject({
      status: "ready",
      current: 1,
      total: 3,
      activeUnitId: "tile-1:line-0",
      exactHighlight: "painted",
    });
    expect(adapter.getMatches()).toEqual([
      { seq: 0, lineIndex: 0, startCol: 0, length: 5 },
      { seq: 1, lineIndex: 1, startCol: 5, length: 5 },
      { seq: 2, lineIndex: 2, startCol: 0, length: 5 },
    ]);
    expect(revealMatch).toHaveBeenCalledTimes(1);
    expect(revealMatch).toHaveBeenLastCalledWith({
      seq: 0,
      lineIndex: 0,
      startCol: 0,
      length: 5,
    });

    adapter.search({ requestId: 2, query: "alpha", matchCase: true });
    expect(adapter.getSnapshot()).toMatchObject({
      requestId: 2,
      matchCase: true,
      current: 1,
      total: 2,
      activeUnitId: "tile-1:line-0",
    });
  });

  it("finds multiple matches on one line", () => {
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    adapter.updateEnvironment(
      environment({
        lines: [line(7, "ab cd ab")],
        revealMatch: vi.fn(),
      }),
    );

    adapter.search({ requestId: 1, query: "ab", matchCase: false });

    expect(adapter.getMatches()).toEqual([
      { seq: 7, lineIndex: 0, startCol: 0, length: 2 },
      { seq: 7, lineIndex: 0, startCol: 6, length: 2 },
    ]);
    expect(adapter.getSnapshot().total).toBe(2);
  });

  it("cycles next and previous with wraparound and reveals each active match", () => {
    const revealMatch = vi.fn<(match: ManagedCommandOutputFindMatch) => void>();
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    adapter.updateEnvironment(
      environment({
        lines: [line(0, "one"), line(1, "two one"), line(2, "one")],
        revealMatch,
      }),
    );

    adapter.search({ requestId: 1, query: "one", matchCase: false });
    expect(adapter.getSnapshot().current).toBe(1);

    adapter.next();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      activeUnitId: "tile-1:line-1",
    });

    adapter.next();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 3,
      activeUnitId: "tile-1:line-2",
    });

    adapter.next();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      activeUnitId: "tile-1:line-0",
    });

    adapter.previous();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 3,
      activeUnitId: "tile-1:line-2",
    });

    expect(revealMatch.mock.calls.map((call) => call[0].seq)).toEqual([
      0, 1, 2, 0, 2,
    ]);
  });

  it("reports partial coverage when history is not fully loaded or the window is detached", () => {
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    adapter.updateEnvironment(
      environment({
        lines: [line(0, "needle")],
        reachedStart: false,
        revealMatch: vi.fn(),
      }),
    );
    adapter.search({ requestId: 1, query: "needle", matchCase: false });
    expect(adapter.getSnapshot()).toMatchObject({
      status: "partial",
      coverageMessage: MANAGED_COMMAND_OUTPUT_FIND_COVERAGE_MESSAGE,
      total: 1,
    });

    adapter.updateEnvironment(
      environment({
        lines: [line(0, "needle")],
        reachedStart: true,
        detached: true,
        revealMatch: vi.fn(),
      }),
    );
    expect(adapter.getSnapshot()).toMatchObject({
      status: "partial",
      coverageMessage: MANAGED_COMMAND_OUTPUT_FIND_COVERAGE_MESSAGE,
    });

    adapter.updateEnvironment(
      environment({
        lines: [line(0, "needle")],
        reachedStart: true,
        detached: false,
        revealMatch: vi.fn(),
      }),
    );
    expect(adapter.getSnapshot()).toMatchObject({
      status: "ready",
      coverageMessage: null,
    });
  });

  it("stays idle for an empty query without scanning or revealing", () => {
    const revealMatch = vi.fn();
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    adapter.updateEnvironment(
      environment({
        lines: [line(0, "needle")],
        reachedStart: false,
        revealMatch,
      }),
    );

    expect(adapter.getSnapshot()).toMatchObject({
      status: "idle",
      coverageMessage: MANAGED_COMMAND_OUTPUT_FIND_COVERAGE_MESSAGE,
      total: 0,
    });
    expect(adapter.getSnapshot().capabilities.has("find")).toBe(true);
    expect(revealMatch).not.toHaveBeenCalled();
  });

  it("re-searches on environment updates and preserves the active match", () => {
    const revealMatch = vi.fn();
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    adapter.updateEnvironment(
      environment({
        lines: [line(10, "alpha"), line(11, "beta alpha")],
        revealMatch,
      }),
    );
    adapter.search({ requestId: 1, query: "alpha", matchCase: false });
    adapter.next();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      activeUnitId: "tile-1:line-11",
    });
    revealMatch.mockClear();

    adapter.updateEnvironment(
      environment({
        lines: [
          line(9, "alpha prepended"),
          line(10, "alpha"),
          line(11, "beta alpha"),
          line(12, "alpha appended"),
        ],
        revealMatch,
      }),
    );

    expect(adapter.getSnapshot()).toMatchObject({
      current: 3,
      total: 4,
      activeUnitId: "tile-1:line-11",
    });
    expect(adapter.getMatches()[2]).toEqual({
      seq: 11,
      lineIndex: 2,
      startCol: 5,
      length: 5,
    });
    expect(revealMatch).not.toHaveBeenCalled();
  });

  it("clamps to the nearest remaining match when the active one disappears", () => {
    const revealMatch = vi.fn();
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    adapter.updateEnvironment(
      environment({
        lines: [line(1, "alpha"), line(2, "alpha"), line(3, "alpha")],
        revealMatch,
      }),
    );
    adapter.search({ requestId: 1, query: "alpha", matchCase: false });
    adapter.next();
    expect(adapter.getSnapshot().activeUnitId).toBe("tile-1:line-2");
    revealMatch.mockClear();

    adapter.updateEnvironment(
      environment({
        lines: [line(1, "alpha"), line(3, "alpha")],
        revealMatch,
      }),
    );

    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      total: 2,
      activeUnitId: "tile-1:line-3",
    });
    // Clamping is not a reveal. The tile drops follow mode whenever it is asked
    // to reveal, so revealing here would take a reader who is tailing live
    // output off the tail the moment their active match aged out of the window.
    expect(revealMatch).not.toHaveBeenCalled();
  });

  it("clears the query and matches while staying searchable", () => {
    const revealMatch = vi.fn();
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    adapter.updateEnvironment(
      environment({ lines: [line(0, "alpha")], revealMatch }),
    );
    adapter.search({ requestId: 1, query: "alpha", matchCase: true });
    expect(adapter.getSnapshot().total).toBe(1);

    adapter.clear();

    expect(adapter.getSnapshot()).toMatchObject({
      status: "idle",
      query: "",
      matchCase: true,
      current: 0,
      total: 0,
      activeUnitId: null,
      exactHighlight: "none",
    });
    expect(adapter.getSnapshot().capabilities.has("find")).toBe(true);
    expect(adapter.getMatches()).toEqual([]);
  });

  it("stops notifying a listener that has unsubscribed", () => {
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    adapter.updateEnvironment(
      environment({ lines: [line(0, "alpha")], revealMatch: vi.fn() }),
    );
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);

    adapter.search({ requestId: 1, query: "alpha", matchCase: false });
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    adapter.search({ requestId: 2, query: "alpha", matchCase: true });

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify listeners when a re-scan changes nothing", () => {
    const adapter = createManagedCommandOutputFindAdapter({
      tileInstanceId: "tile-1",
    });
    const lines = [line(0, "alpha"), line(1, "beta")];
    adapter.updateEnvironment(environment({ lines, revealMatch: vi.fn() }));
    const listener = vi.fn();
    adapter.subscribe(listener);

    // The tile re-pushes the environment on every streamed line. With no query
    // typed, the recomputed snapshot is identical, so the find store must not
    // be written once per line of output.
    adapter.updateEnvironment(environment({ lines, revealMatch: vi.fn() }));
    adapter.updateEnvironment(environment({ lines, revealMatch: vi.fn() }));

    expect(listener).not.toHaveBeenCalled();
  });
});
