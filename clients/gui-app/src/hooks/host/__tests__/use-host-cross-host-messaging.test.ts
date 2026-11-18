import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { HostStatusCrossHostMessaging } from "@traycer/protocol/host/status/contracts";
import { useHostCrossHostMessaging } from "@/hooks/host/use-host-cross-host-messaging";

type FakeQuery = {
  data: { crossHostMessaging: HostStatusCrossHostMessaging | null } | undefined;
  isStale: boolean;
};

const queryRef = vi.hoisted((): { value: FakeQuery; lastArgs: unknown } => ({
  value: { data: undefined, isStale: false },
  lastArgs: null,
}));
const clientRef = vi.hoisted((): { value: object | null } => ({ value: {} }));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => clientRef.value,
}));
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: unknown) => {
    queryRef.lastArgs = args;
    return queryRef.value;
  },
}));

const PAUSED: HostStatusCrossHostMessaging = {
  state: "paused",
  pausedSince: 1_700_000_000_000,
  nextRetryAt: null,
  cause: "transient",
};

beforeEach(() => {
  queryRef.value = { data: undefined, isStale: false };
  queryRef.lastArgs = null;
  clientRef.value = {};
});

describe("useHostCrossHostMessaging", () => {
  it("polls the shared host.status query, only while there is a client", () => {
    clientRef.value = null;
    renderHook(() => useHostCrossHostMessaging("host-a"));

    expect(queryRef.lastArgs).toMatchObject({
      method: "host.status",
      params: {},
      options: { enabled: false, poll: true },
    });
  });

  it("is null before any answer", () => {
    const { result } = renderHook(() => useHostCrossHostMessaging("host-a"));
    expect(result.current).toBeNull();
  });

  it("returns the host's reading", () => {
    queryRef.value = {
      data: { crossHostMessaging: PAUSED },
      isStale: false,
    };
    const { result } = renderHook(() => useHostCrossHostMessaging("host-a"));
    expect(result.current).toEqual(PAUSED);
  });

  it("is null when the answer has gone stale", () => {
    queryRef.value = { data: { crossHostMessaging: PAUSED }, isStale: true };
    const { result } = renderHook(() => useHostCrossHostMessaging("host-a"));
    expect(result.current).toBeNull();
  });

  it("is null for a host that does not report it", () => {
    queryRef.value = { data: { crossHostMessaging: null }, isStale: false };
    const { result } = renderHook(() => useHostCrossHostMessaging("host-a"));
    expect(result.current).toBeNull();
  });
});
