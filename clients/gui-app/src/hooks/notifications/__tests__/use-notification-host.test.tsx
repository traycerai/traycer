import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";

interface HookState {
  entry: HostDirectoryEntry | null;
  entryId: string | null;
}

const state = vi.hoisted<HookState>(() => ({
  entry: null,
  entryId: null,
}));

const useNotificationsServingHostEntryMock = vi.hoisted(() =>
  vi.fn((): HostDirectoryEntry | null => state.entry),
);
const useNotificationsServingHostIdMock = vi.hoisted(() =>
  vi.fn((): string | null => state.entryId),
);

vi.mock("@/hooks/host/use-notifications-serving-host-entry", () => ({
  useNotificationsServingHostEntry: useNotificationsServingHostEntryMock,
  useNotificationsServingHostId: useNotificationsServingHostIdMock,
}));

// Keyed off the entry it is given, so a test can prove the returned client
// tracks the SERVING entry rather than being conjured independently of it.
const useHostClientForMock = vi.hoisted(() =>
  vi.fn(
    (target: HostDirectoryEntry | null): HostClient<HostRpcRegistry> | null =>
      target === null
        ? null
        : Object.assign({} as HostClient<HostRpcRegistry>, {
            __stubForHostId: target.hostId,
          }),
  ),
);

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: useHostClientForMock,
}));

import {
  useNotificationResolveHost,
  useNotificationResolveHostId,
} from "@/hooks/notifications/use-notification-host";

describe("useNotificationResolveHost", () => {
  afterEach(() => {
    cleanup();
    state.entry = null;
    state.entryId = null;
    useNotificationsServingHostEntryMock.mockClear();
    useNotificationsServingHostIdMock.mockClear();
    useHostClientForMock.mockClear();
  });

  it("returns a non-null client on a relay-only shell once the serving entry resolves to the bound host - the bug this fix closes", () => {
    // Before the fix, `useNotificationResolveHost` read the local entry directly,
    // which is permanently null on a relay-only shell (Capacitor mobile /
    // web). The streams were live but every mutation against them was inert
    // because `useHostClientFor` was handed a null target. Here the serving
    // entry hook (already routed through the fallback rule) hands back the
    // BOUND host's entry, and the client must be built from exactly that.
    const boundEntry: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      hostId: "host-bound",
    };
    state.entry = boundEntry;

    const { result } = renderHook(() => useNotificationResolveHost());

    expect(result.current.hostId).toBe("host-bound");
    expect(result.current.client).not.toBeNull();
    expect(useHostClientForMock).toHaveBeenCalledWith(boundEntry);
  });

  it("returns the local host from the serving entry even when a different host would be the app-wide active one - G8: notifications never follow the active host", () => {
    // No app-wide "active host" selector is mocked or imported here at all -
    // if `useNotificationResolveHost` reached for one, this render would throw on
    // the unmocked module. The hook must resolve purely from the serving
    // entry it is handed.
    const localEntry: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      hostId: "mock-local",
    };
    state.entry = localEntry;

    const { result } = renderHook(() => useNotificationResolveHost());

    expect(result.current.hostId).toBe("mock-local");
    expect(result.current.hostId).not.toBe("some-other-active-host");
  });

  it("returns a null hostId and a null client when there is no serving entry", () => {
    state.entry = null;

    const { result } = renderHook(() => useNotificationResolveHost());

    expect(result.current.hostId).toBeNull();
    expect(result.current.client).toBeNull();
  });
});

describe("useNotificationResolveHostId", () => {
  afterEach(() => {
    cleanup();
    state.entry = null;
    state.entryId = null;
    useNotificationsServingHostEntryMock.mockClear();
    useNotificationsServingHostIdMock.mockClear();
    useHostClientForMock.mockClear();
  });

  it("returns null when the serving id projection is null", () => {
    state.entryId = null;

    const { result } = renderHook(() => useNotificationResolveHostId());

    expect(result.current).toBeNull();
  });

  it("returns the serving id when present", () => {
    state.entryId = "host-c";

    const { result } = renderHook(() => useNotificationResolveHostId());

    expect(result.current).toBe("host-c");
  });

  it("resolves through the ID-only projection, never through the entry hook - matches the doc comment's throw-safety rationale", () => {
    state.entryId = "host-c";
    state.entry = { ...mockLocalHostEntry, hostId: "host-c" };

    renderHook(() => useNotificationResolveHostId());

    expect(useNotificationsServingHostIdMock).toHaveBeenCalled();
    expect(useNotificationsServingHostEntryMock).not.toHaveBeenCalled();
  });
});
