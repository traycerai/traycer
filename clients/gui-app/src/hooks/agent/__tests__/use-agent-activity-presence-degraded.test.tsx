import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentActivityPresenceDegraded } from "@/hooks/agent/use-agent-activity-presence-degraded";
import {
  __resetAgentActivityStoreForTests,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";

const GRACE_MS = 2_000;

describe("useAgentActivityPresenceDegraded", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetAgentActivityStoreForTests();
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
      useAgentActivityStore.setState({ connectionStatus: "open" });
    });
    expect(result.current).toBe(null);
  });

  it("holds 'reconnecting' back for a fresh grace window after being open, then reads 'stream-down'", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      useAgentActivityStore.setState({ connectionStatus: "open" });
    });
    expect(result.current).toBe(null);

    act(() => {
      useAgentActivityStore.setState({ connectionStatus: "reconnecting" });
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
      useAgentActivityStore.setState({ connectionStatus: "open" });
    });
    expect(result.current).toBe(null);

    act(() => {
      useAgentActivityStore.setState({ connectionStatus: "closed" });
    });
    act(() => {
      vi.advanceTimersByTime(GRACE_MS - 1);
    });
    expect(result.current).toBe(null);

    act(() => {
      useAgentActivityStore.setState({ connectionStatus: "open" });
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
      useAgentActivityStore.setState({
        connectionStatus: "open",
        cloudSyncStatus: "reconnecting",
      });
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(GRACE_MS - 1);
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
      useAgentActivityStore.setState({
        connectionStatus: "open",
        cloudSyncStatus: "disconnected",
      });
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(GRACE_MS - 1);
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("cloud-down");
  });

  it("stays null past the grace when open with cloudSyncStatus null - no claim is not degraded", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      useAgentActivityStore.setState({
        connectionStatus: "open",
        cloudSyncStatus: null,
      });
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(GRACE_MS);
    });
    expect(result.current).toBe(null);
  });

  it("stays null while open with cloudSyncStatus 'connected'", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      useAgentActivityStore.setState({
        connectionStatus: "open",
        cloudSyncStatus: "connected",
      });
    });
    expect(result.current).toBe(null);

    act(() => {
      vi.advanceTimersByTime(GRACE_MS);
    });
    expect(result.current).toBe(null);
  });

  it("clears a sustained 'cloud-down' reading immediately once cloudSyncStatus returns to 'connected'", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      useAgentActivityStore.setState({
        connectionStatus: "open",
        cloudSyncStatus: "reconnecting",
      });
    });
    act(() => {
      vi.advanceTimersByTime(GRACE_MS);
    });
    expect(result.current).toBe("cloud-down");

    act(() => {
      useAgentActivityStore.setState({ cloudSyncStatus: "connected" });
    });
    expect(result.current).toBe(null);
  });

  it("restarts the grace under 'stream-down' when the stream closes during a sustained 'cloud-down'", () => {
    const { result } = renderHook(() => useAgentActivityPresenceDegraded());

    act(() => {
      useAgentActivityStore.setState({
        connectionStatus: "open",
        cloudSyncStatus: "reconnecting",
      });
    });
    act(() => {
      vi.advanceTimersByTime(GRACE_MS);
    });
    expect(result.current).toBe("cloud-down");

    act(() => {
      useAgentActivityStore.setState({ connectionStatus: "closed" });
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
