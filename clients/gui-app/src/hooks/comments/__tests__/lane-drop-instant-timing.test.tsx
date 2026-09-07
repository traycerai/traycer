/** Drop instant is stamped on the first getSnapshot after the drop. `?? Date.now()` must not walk forward on later snapshots. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { create } from "zustand";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  resolveArtifactCommentThreads,
  useEpicLaneCommentThreadsDroppedAt,
} from "@/hooks/comments/use-lane-comment-threads";

type LaneStatusState = { readonly recordsTransportStatus: string };

let clock = 1_000;
function tick(by: number): number {
  clock += by;
  return clock;
}

function makeHandle(initialStatus: string): {
  readonly handle: OpenEpicStoreHandle;
  // A property of function type, not a method shorthand: `unbound-method`
  // reads the shorthand as a method that could lose its `this`.
  readonly setStatus: (status: string) => void;
} {
  const store = create<LaneStatusState>(() => ({
    recordsTransportStatus: initialStatus,
  }));
  return {
    // Only `store` is ever read by the hook under test - it reaches `handle.store.getState().recordsTransportStatus` and nothing else - so the rest of the handle is deliberately absent rather than stubbed with values a reader might think are load-bearing.
    handle: { store } as unknown as OpenEpicStoreHandle,
    setStatus: (status) => {
      store.setState({ recordsTransportStatus: status });
    },
  };
}

const observed: (number | null)[] = [];

function Probe() {
  observed.push(useEpicLaneCommentThreadsDroppedAt());
  return null;
}

describe("the lane-drop instant is stamped at the TRANSITION", () => {
  beforeEach(() => {
    clock = 1_000;
    observed.length = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not walk the instant forward to a later render, so a poll that answered in the gap still reads as post-drop", async () => {
    const { handle, setStatus } = makeHandle("open");
    render(
      <EpicSessionContext.Provider value={handle}>
        <Probe />
      </EpicSessionContext.Provider>,
    );
    expect(observed.at(-1)).toBeNull();

    // The lane closes OUTSIDE `act`, so React does not flush a render yet -
    // though it DOES run `getSnapshot` synchronously from the notification, at
    // this clock, which is the read that stamps.
    setStatus("closed");

    // The in-flight poll resolves in the gap ...
    const pollUpdatedAt = tick(5);
    // Wrapping the write in `act` instead collapses both reads into one clock and makes this vacuous - which is how an earlier version of this pin passed against the very shape it was written to reject.
    tick(5);
    await act(async () => {});
    const droppedAt = observed.at(-1);

    expect(droppedAt).not.toBeNull();
    expect(droppedAt).toBeLessThan(pollUpdatedAt);

    // The consequence, through the real resolver: a post-drop poll must win,
    // which is what stops a thread another client deleted from coming back.
    const laneThreads = [threadFixture("stale-lane-row")];
    const pollThreads = [threadFixture("fresh-poll-row")];
    expect(
      resolveArtifactCommentThreads({
        laneThreads,
        pollThreads,
        laneDroppedAt: droppedAt ?? null,
        pollUpdatedAt,
      }),
    ).toEqual({ threads: pollThreads, source: "poll" });
  });

  it("does not re-stamp on a later store change while the lane stays closed", () => {
    const { handle, setStatus } = makeHandle("open");
    render(
      <EpicSessionContext.Provider value={handle}>
        <Probe />
      </EpicSessionContext.Provider>,
    );
    act(() => {
      setStatus("closed");
    });
    const first = observed.at(-1);
    tick(50);
    act(() => {
      setStatus("connecting");
    });

    // Still not open, so the ORIGINAL drop stands. Re-stamping would walk the
    // instant forward past every poll that answered since, which is the same
    // misclassification from the other direction.
    expect(observed.at(-1)).toBe(first);
  });

  it("clears the instant when the lane comes back, and stamps a fresh one on the next drop", () => {
    const { handle, setStatus } = makeHandle("open");
    render(
      <EpicSessionContext.Provider value={handle}>
        <Probe />
      </EpicSessionContext.Provider>,
    );
    act(() => {
      setStatus("closed");
    });
    const first = observed.at(-1);
    tick(50);
    act(() => {
      setStatus("open");
    });
    expect(observed.at(-1)).toBeNull();
    tick(50);
    act(() => {
      setStatus("closed");
    });
    const second = observed.at(-1);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second).toBeGreaterThan(first ?? 0);
  });

  it("stamps at MOUNT when the lane closed before this hook existed", () => {
    // Reading "never dropped" there would put rows the lane pushed at an unknown earlier time back in front of every poll.
    const { handle } = makeHandle("closed");
    render(
      <EpicSessionContext.Provider value={handle}>
        <Probe />
      </EpicSessionContext.Provider>,
    );
    expect(observed.at(-1)).toBe(1_000);
  });
});

function threadFixture(threadId: string) {
  return {
    threadId,
    resolved: false,
    createdAt: 1,
    comments: [],
    data: { createdByUserId: "user-1" },
  };
}
