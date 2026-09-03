import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { AgentActivityCloudSyncStatus } from "@traycer/protocol/host/agent/activity";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { useAgentActivityPresenceDegraded } from "@/hooks/agent/use-agent-activity-presence-degraded";
import {
  __resetAgentActivityStoreForTests,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";

const GRACE_MS = 2_000;
const STREAM_GRACE_MS = 2_000;
const CLOUD_GRACE_MS = 15_000;

/**
 * The store is keyed by host. The hook no longer takes one - it resolves the
 * SERVING host itself - so this is both what the writes below key on and what
 * the mocked serving-host entry returns. They must agree, or the hook reads an
 * empty slice and every case degrades to `stream-down`.
 */
const HOST_ID = "host-1";
/**
 * Annotated rather than `"host-1" as string | null` on each field. The
 * assertion form does not survive the lint step: `eslint --fix` runs with
 * `no-unnecessary-type-assertion`, strips both assertions, and the fields
 * narrow to `string` - which then fails the `= null` writes below, and turned
 * a `=== null` comparison into a "types have no overlap" error. An annotation
 * expresses the same widening and is not a fixable offence.
 */
interface HostRouting {
  localHostId: string | null;
  servingHostId: string | null;
}
const hostRouting = vi.hoisted((): HostRouting => ({
  localHostId: "host-1",
  servingHostId: "host-1",
}));

/**
 * Deliberately HOOK-SHAPED, and the `useState` is the whole point rather than
 * incidental detail. The real `useNotificationsServingHostId` consumes three
 * hooks; a mock that consumes none is invisible to React's hook counter, so a
 * conditional call site would reorder nothing and the transition test below
 * would pass against the very defect it exists to catch. Consuming one real
 * hook restores the property being asserted: call this conditionally and the
 * render throws.
 */
vi.mock("@/hooks/host/use-notifications-serving-host-entry", async () => {
  const { useState } = await import("react");
  return {
    useNotificationsServingHostId: (): string | null => {
      useState(0);
      return hostRouting.servingHostId;
    },
  };
});

vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => hostRouting.localHostId,
}));

/**
 * Writes THIS host's slice, creating it on first use. `byEpic` is irrelevant
 * here - the reading under test is the health of the stream, not the union it
 * carried.
 */
function setHostHealth(patch: {
  readonly connectionStatus?: StreamConnectionStatus;
  readonly cloudSyncStatus?: AgentActivityCloudSyncStatus | null;
}): void {
  setHostHealthFor(HOST_ID, patch);
}

function setHostHealthFor(
  hostId: string,
  patch: {
    readonly connectionStatus?: StreamConnectionStatus;
    readonly cloudSyncStatus?: AgentActivityCloudSyncStatus | null;
  },
): void {
  useAgentActivityStore.setState((state) => {
    const current = state.byHost.get(hostId) ?? {
      servedBy: null,
      connectionStatus: "connecting" as StreamConnectionStatus,
      cloudSyncStatus: null,
      byEpic: new Map(),
      stateFrameSeenThisEpoch: false,
    };
    const next = new Map(state.byHost);
    next.set(hostId, { ...current, ...patch });
    return { byHost: next };
  });
}

describe("useAgentActivityPresenceDegraded", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetAgentActivityStoreForTests();
    hostRouting.localHostId = HOST_ID;
    hostRouting.servingHostId = HOST_ID;
  });

  afterEach(() => {
    __resetAgentActivityStoreForTests();
    vi.useRealTimers();
  });

  it("stays null for the bootstrap 'connecting' status until the grace elapses, then reads 'stream-down'", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(GRACE_MS - 1);
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("stream-down");
  });

  it("flips back to null immediately once the stream reports 'open'", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      vi.advanceTimersByTime(GRACE_MS);
    });
    expect(result.current).toBe("stream-down");

    act(() => {
      setHostHealth({ connectionStatus: "open" });
    });
    expect(result.current).toBe(null);
  });

  it("survives the local host arriving mid-mount, which a short-circuited serving-host read cannot", () => {
    // The regression: `localHostId ?? useNotificationsServingHostId()` drops
    // the second hook the instant the first answers, so the hook order changes
    // between these two renders and React throws "Rendered fewer hooks than
    // expected". A booting local host publishing its id IS that edge, and it
    // is reached on every cold start of a local-capable shell - so the defect
    // is a crash on the ordinary path, not a corner case.
    hostRouting.localHostId = null;
    hostRouting.servingHostId = "relay-serving-host";
    const { result, rerender } = renderHook(() =>
      useAgentActivityPresenceDegraded(),
    );

    act(() => {
      setHostHealthFor("relay-serving-host", { connectionStatus: "open" });
    });
    expect(result.current).toBe(null);

    // The local host lands. Both reads must still happen.
    hostRouting.localHostId = "durable-local-host";
    expect(() => {
      rerender();
    }).not.toThrow();

    act(() => {
      setHostHealthFor("durable-local-host", { connectionStatus: "closed" });
      vi.advanceTimersByTime(GRACE_MS);
    });
    // And the answer moved to the newly-arrived local host, proving the
    // rerender re-resolved rather than merely surviving.
    expect(result.current).toBe("stream-down");
  });

  it("uses the durable local host while the serving entry is absent during a restart", () => {
    hostRouting.localHostId = "durable-local-host";
    hostRouting.servingHostId = null;
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealthFor("durable-local-host", { connectionStatus: "closed" });
      vi.advanceTimersByTime(GRACE_MS);
    });

    expect(result.current).toBe("stream-down");
  });

  it("holds 'reconnecting' back for a fresh grace window after being open, then reads 'stream-down'", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({ connectionStatus: "open" });
    });
    expect(result.current).toBe(null);

    act(() => {
      setHostHealth({ connectionStatus: "reconnecting" });
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(GRACE_MS - 1);
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("stream-down");
  });

  it("never reads 'stream-down' when a close reopens within the grace window", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({ connectionStatus: "open" });
    });
    expect(result.current).toBe(null);

    act(() => {
      setHostHealth({ connectionStatus: "closed" });
    });
    act(() => {
      vi.advanceTimersByTime(GRACE_MS - 1);
    });
    expect(result.current).toBe(null);

    act(() => {
      setHostHealth({ connectionStatus: "open" });
    });
    expect(result.current).toBe(null);

    // The abandoned grace timer from the earlier close must not fire later
    // and flip the reading to 'stream-down' after the stream has already
    // reopened.
    act(() => {
      vi.advanceTimersByTime(GRACE_MS);
    });
    expect(result.current).toBe(null);
  });

  it("holds 'reconnecting' cloudSyncStatus back while open, then reads 'cloud-down' after the grace", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({
        connectionStatus: "open",
        cloudSyncStatus: "reconnecting",
      });
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(CLOUD_GRACE_MS - 1);
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("cloud-down");
  });

  it("holds 'disconnected' cloudSyncStatus back while open, then reads 'cloud-down' after the grace", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({
        connectionStatus: "open",
        cloudSyncStatus: "disconnected",
      });
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(CLOUD_GRACE_MS - 1);
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("cloud-down");
  });

  it("never reads 'cloud-down' when the cloud link recovers at 14_999ms, one short of the grace", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({
        connectionStatus: "open",
        cloudSyncStatus: "reconnecting",
      });
    });
    act(() => {
      vi.advanceTimersByTime(CLOUD_GRACE_MS - 1);
    });
    expect(result.current).toBe(null);

    act(() => {
      setHostHealth({ cloudSyncStatus: "connected" });
    });
    expect(result.current).toBe(null);

    // The abandoned grace timer must not fire later and flip the reading to
    // 'cloud-down' after the cloud link has already recovered.
    act(() => {
      vi.advanceTimersByTime(CLOUD_GRACE_MS);
    });
    expect(result.current).toBe(null);
  });

  it("does not restart the cloud-down grace when 'disconnected' flips to 'reconnecting' - same reason", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({
        connectionStatus: "open",
        cloudSyncStatus: "disconnected",
      });
    });
    act(() => {
      vi.advanceTimersByTime(CLOUD_GRACE_MS - 500);
    });
    expect(result.current).toBe(null);

    act(() => {
      setHostHealth({ cloudSyncStatus: "reconnecting" });
    });
    // Still 'cloud-down' both before and after the flip, so the grace timer
    // set for the ORIGINAL entry into 'cloud-down' keeps running rather than
    // restarting.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe("cloud-down");
  });

  it("restarts the grace under the new reason when 'cloud-down' flips to 'stream-down' mid-window", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({
        connectionStatus: "open",
        cloudSyncStatus: "reconnecting",
      });
    });
    act(() => {
      vi.advanceTimersByTime(CLOUD_GRACE_MS - 500);
    });
    expect(result.current).toBe(null);

    act(() => {
      setHostHealth({ connectionStatus: "closed" });
    });
    // The reason changed from 'cloud-down' to 'stream-down', so the clock
    // restarts under the new reason's (shorter) grace rather than inheriting
    // whatever remained of the old one.
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(STREAM_GRACE_MS - 1);
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("stream-down");
  });

  it("stays null past the grace when open with cloudSyncStatus null - no claim is not degraded", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({
        connectionStatus: "open",
        cloudSyncStatus: null,
      });
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(CLOUD_GRACE_MS);
    });
    expect(result.current).toBe(null);
  });

  it("stays null while open with cloudSyncStatus 'connected'", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({
        connectionStatus: "open",
        cloudSyncStatus: "connected",
      });
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(CLOUD_GRACE_MS);
    });
    expect(result.current).toBe(null);
  });

  it("clears a sustained 'cloud-down' reading immediately once cloudSyncStatus returns to 'connected'", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({
        connectionStatus: "open",
        cloudSyncStatus: "reconnecting",
      });
    });
    act(() => {
      vi.advanceTimersByTime(CLOUD_GRACE_MS);
    });
    expect(result.current).toBe("cloud-down");

    act(() => {
      setHostHealth({ cloudSyncStatus: "connected" });
    });
    expect(result.current).toBe(null);
  });

  it("restarts the grace under 'stream-down' when the stream closes during a sustained 'cloud-down'", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      setHostHealth({
        connectionStatus: "open",
        cloudSyncStatus: "reconnecting",
      });
    });
    act(() => {
      vi.advanceTimersByTime(CLOUD_GRACE_MS);
    });
    expect(result.current).toBe("cloud-down");

    act(() => {
      setHostHealth({ connectionStatus: "closed" });
    });
    // The reason flipped from 'cloud-down' to 'stream-down', which restarts
    // the grace - the reading must clear immediately rather than carry the
    // old sustained value over to the new reason.
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(GRACE_MS - 1);
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("stream-down");
  });
});
