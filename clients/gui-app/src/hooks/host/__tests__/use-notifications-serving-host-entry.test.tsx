import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";

interface HookState {
  localEntry: HostDirectoryEntry | null;
  runnerHost: Pick<IRunnerHost, "hasLocalHost"> | null;
  boundHostId: string | null;
  /**
   * When `true`, the mocked `useHostDirectoryEntry` throws instead of
   * answering - standing in for the real hook's documented behaviour outside
   * a `<HostRuntimeProvider>` (it reads `useHostDirectory()`, which throws).
   * Exists so a test can prove `useNotificationsServingHostId` never reaches
   * the entry hook's fallback path: flip this on, and the ID hook must still
   * answer from `fallbackHostId` without tripping it.
   */
  throwOnDirectoryEntry: boolean;
}

const state = vi.hoisted<HookState>(() => ({
  localEntry: null,
  runnerHost: null,
  boundHostId: null,
  throwOnDirectoryEntry: false,
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
  useHostDirectoryEntry: (hostId: string): HostDirectoryEntry | null => {
    if (state.throwOnDirectoryEntry) {
      throw new Error(
        "useHostDirectoryEntry called outside a HostRuntimeProvider",
      );
    }
    return hostId.length === 0 ? null : { ...mockLocalHostEntry, hostId };
  },
}));

import {
  useNotificationsServingHostEntry,
  useNotificationsServingHostId,
} from "@/hooks/host/use-notifications-serving-host-entry";

describe("useNotificationsServingHostEntry", () => {
  afterEach(() => {
    cleanup();
    state.localEntry = null;
    state.runnerHost = null;
    state.boundHostId = null;
    state.throwOnDirectoryEntry = false;
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

describe("useNotificationsServingHostId", () => {
  afterEach(() => {
    cleanup();
    state.localEntry = null;
    state.runnerHost = null;
    state.boundHostId = null;
    state.throwOnDirectoryEntry = false;
  });

  it("does not throw outside a HostRuntimeProvider - it answers from fallbackHostId directly, never through the entry hook's directory read", () => {
    // Relay-only shell taking the fallback, with the mocked directory read
    // configured to throw exactly as the real `useHostDirectoryEntry` does
    // outside a `<HostRuntimeProvider>`. If this hook composed through
    // `useNotificationsServingHostEntry()` (which calls that directory read
    // to resolve the fallback), this render would throw.
    state.localEntry = null;
    state.runnerHost = { hasLocalHost: false };
    state.boundHostId = "host-b";
    state.throwOnDirectoryEntry = true;

    const { result } = renderHook(() => useNotificationsServingHostId());

    expect(result.current).toBe("host-b");
  });

  it("agrees with useNotificationsServingHostEntry when a local host is present", () => {
    state.localEntry = mockLocalHostEntry;
    state.runnerHost = { hasLocalHost: true };
    state.boundHostId = "host-b";

    const entryResult = renderHook(() => useNotificationsServingHostEntry());
    const idResult = renderHook(() => useNotificationsServingHostId());

    expect(idResult.result.current).toBe(entryResult.result.current?.hostId);
    expect(idResult.result.current).toBe(mockLocalHostEntry.hostId);
  });

  it("agrees with useNotificationsServingHostEntry on a relay-only shell with a bound host", () => {
    state.localEntry = null;
    state.runnerHost = { hasLocalHost: false };
    state.boundHostId = "host-b";

    const entryResult = renderHook(() => useNotificationsServingHostEntry());
    const idResult = renderHook(() => useNotificationsServingHostId());

    expect(idResult.result.current).toBe(entryResult.result.current?.hostId);
    expect(idResult.result.current).toBe("host-b");
  });

  it("agrees with useNotificationsServingHostEntry on a relay-only shell with no bound host yet", () => {
    state.localEntry = null;
    state.runnerHost = { hasLocalHost: false };
    state.boundHostId = null;

    const entryResult = renderHook(() => useNotificationsServingHostEntry());
    const idResult = renderHook(() => useNotificationsServingHostId());

    expect(entryResult.result.current).toBeNull();
    expect(idResult.result.current).toBeNull();
  });

  it("agrees with useNotificationsServingHostEntry on an undeclared shell (no RunnerHostProvider)", () => {
    state.localEntry = null;
    state.runnerHost = null;
    state.boundHostId = "host-b";

    const entryResult = renderHook(() => useNotificationsServingHostEntry());
    const idResult = renderHook(() => useNotificationsServingHostId());

    expect(entryResult.result.current).toBeNull();
    expect(idResult.result.current).toBeNull();
  });
});
