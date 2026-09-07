import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  activeUpdateAcceleratorCountForTest,
  useActiveUpdatePollAccelerator,
} from "../use-active-update-poll-accelerator";
import { FLEET_ACTIVE_POLL_MS } from "@/lib/host/fleet-update/fleet-poll-policy";
import type { FleetUpdateView } from "@/lib/host/fleet-update/fleet-update-view";

// Acceleration is per host, not per hook instance. Unmount explicitly: gui-app has no RTL auto-cleanup, and a leaked mount holds the ref-count into the next test.

const ACTIVE_VIEW: FleetUpdateView = {
  kind: "downloading",
  attemptId: "attempt-1",
  targetVersion: "1.3.0",
  progress: { kind: "none" },
  qualified: false,
  lastKnownKind: null,
  lastObservedAtMs: 0,
  blockingSessionCount: null,
  blockingBreakdown: null,
  errorMessage: null,
};

const IDLE_VIEW: FleetUpdateView = {
  kind: "idle",
  attemptId: null,
  targetVersion: null,
  progress: { kind: "none" },
  qualified: false,
  lastKnownKind: null,
  lastObservedAtMs: 0,
  blockingSessionCount: null,
  blockingBreakdown: null,
  errorMessage: null,
};

function harness(): {
  client: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactNode;
} {
  const client = new QueryClient();
  return {
    client,
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useActiveUpdatePollAccelerator - one timer per host, not per consumer", () => {
  it("two consumers on the SAME host invalidate once per cadence, not twice", () => {
    vi.useFakeTimers();
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const first = renderHook(
      () =>
        useActiveUpdatePollAccelerator({ hostId: "host-a", view: ACTIVE_VIEW }),
      { wrapper },
    );
    const second = renderHook(
      () =>
        useActiveUpdatePollAccelerator({ hostId: "host-a", view: ACTIVE_VIEW }),
      { wrapper },
    );

    act(() => {
      vi.advanceTimersByTime(FLEET_ACTIVE_POLL_MS);
    });

    // THE BUG, asserted FIRST and deliberately so.
    expect(invalidate).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(FLEET_ACTIVE_POLL_MS * 3);
    });
    expect(invalidate).toHaveBeenCalledTimes(4);

    expect(activeUpdateAcceleratorCountForTest(client, "host-a")).toBe(2);

    first.unmount();
    second.unmount();
  });

  it("keeps polling while ANY consumer remains, and stops only when the last leaves", () => {
    // The ref-count, both directions. Last-one-wins would kill the timer when
    // the first consumer unmounted, stalling a download the other surface is
    // still displaying.
    vi.useFakeTimers();
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const first = renderHook(
      () =>
        useActiveUpdatePollAccelerator({ hostId: "host-a", view: ACTIVE_VIEW }),
      { wrapper },
    );
    const second = renderHook(
      () =>
        useActiveUpdatePollAccelerator({ hostId: "host-a", view: ACTIVE_VIEW }),
      { wrapper },
    );

    first.unmount();
    expect(activeUpdateAcceleratorCountForTest(client, "host-a")).toBe(1);

    act(() => {
      vi.advanceTimersByTime(FLEET_ACTIVE_POLL_MS);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);

    second.unmount();
    expect(activeUpdateAcceleratorCountForTest(client, "host-a")).toBe(0);

    invalidate.mockClear();
    act(() => {
      vi.advanceTimersByTime(FLEET_ACTIVE_POLL_MS * 3);
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("separate hosts keep separate timers", () => {
    // The sharing must be per HOST. Collapsing to a single global timer would
    // starve one host's banner while another host's operation ran.
    vi.useFakeTimers();
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const a = renderHook(
      () =>
        useActiveUpdatePollAccelerator({ hostId: "host-a", view: ACTIVE_VIEW }),
      { wrapper },
    );
    const b = renderHook(
      () =>
        useActiveUpdatePollAccelerator({ hostId: "host-b", view: ACTIVE_VIEW }),
      { wrapper },
    );

    expect(activeUpdateAcceleratorCountForTest(client, "host-a")).toBe(1);
    expect(activeUpdateAcceleratorCountForTest(client, "host-b")).toBe(1);

    act(() => {
      vi.advanceTimersByTime(FLEET_ACTIVE_POLL_MS);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);

    a.unmount();
    b.unmount();
  });

  it("every interval-driven invalidateQueries call passes { cancelRefetch: false }", () => {
    // Non-canceling, or the cadence eats its own reads: TanStack's default `cancelRefetch: true` would abort the in-flight `host.status` read on every tick, so on a link whose RTT exceeds this cadence no poll would ever complete.
    vi.useFakeTimers();
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const hook = renderHook(
      () =>
        useActiveUpdatePollAccelerator({ hostId: "host-a", view: ACTIVE_VIEW }),
      { wrapper },
    );

    act(() => {
      vi.advanceTimersByTime(FLEET_ACTIVE_POLL_MS * 3);
    });

    expect(invalidate).toHaveBeenCalledTimes(3);
    for (const call of invalidate.mock.calls) {
      expect(call[1]).toEqual({ cancelRefetch: false });
    }

    hook.unmount();
  });

  it("a view that does not warrant fast polling registers nothing", () => {
    // The positive control for the gate: if this registered, the accelerator
    // would be running during idle and every assertion above would be measuring
    // an unconditional timer rather than an operation-scoped one.
    vi.useFakeTimers();
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const idle = renderHook(
      () =>
        useActiveUpdatePollAccelerator({ hostId: "host-a", view: IDLE_VIEW }),
      { wrapper },
    );

    expect(activeUpdateAcceleratorCountForTest(client, "host-a")).toBe(0);
    act(() => {
      vi.advanceTimersByTime(FLEET_ACTIVE_POLL_MS * 3);
    });
    expect(invalidate).not.toHaveBeenCalled();

    idle.unmount();
  });
});
