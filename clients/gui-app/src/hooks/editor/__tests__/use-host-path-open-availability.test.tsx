import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

const state = vi.hoisted(() => ({
  entries: new Map<string, HostDirectoryEntry>(),
  requestedHostId: null as string | null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null): HostDirectoryEntry | null => {
    state.requestedHostId = hostId;
    return hostId === null ? null : (state.entries.get(hostId) ?? null);
  },
}));

import { useHostPathOpenAvailability } from "../use-host-path-open-availability";

function entry(
  hostId: string,
  kind: HostDirectoryEntry["kind"],
): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind,
    websocketUrl: "ws://127.0.0.1:1234",
    version: "1.2.0",
    transportDialability: "dialable",
  };
}

beforeEach(() => {
  state.requestedHostId = null;
  state.entries = new Map([
    ["host-A", entry("host-A", "local")],
    ["host-B", entry("host-B", "remote")],
    ["host-C", entry("host-C", "mock")],
  ]);
});

describe("useHostPathOpenAvailability", () => {
  it.each([
    ["local", "host-A", true],
    ["remote", "host-B", false],
    ["mock", "host-C", true],
    ["unresolved", "host-missing", false],
  ] as const)(
    "uses the target host's %s directory entry",
    (_kind, targetHostId, expected) => {
      const { result } = renderHook(() =>
        useHostPathOpenAvailability(targetHostId),
      );

      expect(state.requestedHostId).toBe(targetHostId);
      expect(result.current).toBe(expected);
    },
  );

  it("fails closed for a null target host", () => {
    const { result } = renderHook(() => useHostPathOpenAvailability(null));

    expect(state.requestedHostId).toBeNull();
    expect(result.current).toBe(false);
  });
});
