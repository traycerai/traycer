import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";

interface HookState {
  localEntry: HostDirectoryEntry | null;
  runnerHost: Pick<IRunnerHost, "hasLocalHost"> | null;
  boundHostId: string | null;
}

const state = vi.hoisted<HookState>(() => ({
  localEntry: null,
  runnerHost: null,
  boundHostId: null,
}));

vi.mock("@/hooks/host/use-reactive-local-host-entry", () => ({
  useReactiveLocalHostEntry: (): HostDirectoryEntry | null => state.localEntry,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: (): Pick<IRunnerHost, "hasLocalHost"> | null =>
    state.runnerHost,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: (): string | null => state.boundHostId,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string): HostDirectoryEntry | null =>
    hostId.length === 0 ? null : { ...mockLocalHostEntry, hostId },
}));

import { useNotificationsServingHostEntry } from "@/hooks/host/use-notifications-serving-host-entry";

describe("useNotificationsServingHostEntry", () => {
  afterEach(() => {
    cleanup();
    state.localEntry = null;
    state.runnerHost = null;
    state.boundHostId = null;
  });

  it("returns the local entry when a local host is present and the shell declares local capability", () => {
    state.localEntry = mockLocalHostEntry;
    state.runnerHost = { hasLocalHost: true };
    state.boundHostId = "host-b";

    const { result } = renderHook(() => useNotificationsServingHostEntry());

    expect(result.current).toBe(mockLocalHostEntry);
  });

  it("still returns the local entry when the shell declares NOT local-capable - local wins over the shell's own declared capability", () => {
    state.localEntry = mockLocalHostEntry;
    state.runnerHost = { hasLocalHost: false };
    state.boundHostId = "host-b";

    const { result } = renderHook(() => useNotificationsServingHostEntry());

    expect(result.current).toBe(mockLocalHostEntry);
  });

  it("returns null (no fallback) when there is no local entry yet but the shell IS local-capable - a booting local host must not bind to the bound host", () => {
    state.localEntry = null;
    state.runnerHost = { hasLocalHost: true };
    state.boundHostId = "host-b";

    const { result } = renderHook(() => useNotificationsServingHostEntry());

    expect(result.current).toBeNull();
  });

  it("falls back to the bound host's directory entry on a relay-only shell with no local entry", () => {
    state.localEntry = null;
    state.runnerHost = { hasLocalHost: false };
    state.boundHostId = "host-b";

    const { result } = renderHook(() => useNotificationsServingHostEntry());

    expect(result.current).toEqual({ ...mockLocalHostEntry, hostId: "host-b" });
  });

  it("returns null on a relay-only shell with no local entry and no bound host id yet", () => {
    state.localEntry = null;
    state.runnerHost = { hasLocalHost: false };
    state.boundHostId = null;

    const { result } = renderHook(() => useNotificationsServingHostEntry());

    expect(result.current).toBeNull();
  });

  it("treats an undeclared shell (no RunnerHostProvider) as local-capable and returns null rather than acquiring the fallback", () => {
    state.localEntry = null;
    state.runnerHost = null;
    state.boundHostId = "host-b";

    const { result } = renderHook(() => useNotificationsServingHostEntry());

    expect(result.current).toBeNull();
  });
});
