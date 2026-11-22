import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useWatchHostScope } from "@/hooks/host-scope/use-watch-host-scope";
import { useWatchHostStore } from "@/stores/host-scope/watch-host-store";

const hooks = vi.hoisted(() => ({ useHostScopeFor: vi.fn() }));

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScopeFor: hooks.useHostScopeFor,
}));

describe("useWatchHostScope", () => {
  let scope: HostScope;

  beforeEach(() => {
    useWatchHostStore.setState({ scopedHostId: null, scopedHostName: null });
    window.localStorage.clear();
    const active = hostScopeOptionFixture({ hostId: "host-a", name: "Alpha" });
    const picked = hostScopeOptionFixture({ hostId: "host-b", name: "Bravo" });
    scope = hostScopeFixture({
      host: active,
      hosts: [active, picked],
      activeHost: active,
      activeHostId: active.hostId,
    });
    hooks.useHostScopeFor.mockImplementation(() => scope);
  });

  afterEach(() => {
    cleanup();
    hooks.useHostScopeFor.mockReset();
    useWatchHostStore.setState({ scopedHostId: null, scopedHostName: null });
    window.localStorage.clear();
  });

  it("records a picked host name and exposes it when that host vanishes", () => {
    const { result, rerender } = renderHook(() => useWatchHostScope());

    act(() => result.current.scope.setHostId("host-b"));

    expect(useWatchHostStore.getState()).toMatchObject({
      scopedHostId: "host-b",
      scopedHostName: "Bravo",
    });

    const active = hostScopeOptionFixture({ hostId: "host-a", name: "Alpha" });
    scope = hostScopeFixture({
      host: null,
      hosts: [active],
      activeHost: active,
      activeHostId: active.hostId,
      vanishedHostId: "host-b",
      hostLabel: "host-b",
      status: "vanished",
      isViewingActive: false,
    });
    rerender();

    expect(result.current.scope.vanishedSelection?.name).toBe("Bravo");
    const forget = result.current.scope.vanishedSelection?.forget;

    act(() => forget?.());

    expect(useWatchHostStore.getState()).toMatchObject({
      scopedHostId: null,
      scopedHostName: null,
    });
    expect(result.current.scope.vanishedSelection).toBeNull();
  });
});
