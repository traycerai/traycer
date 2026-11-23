import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useLocalPickHostAge } from "@/components/settings/personal/use-old-host-local-pick";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const LOCAL_PICK = {
  kind: "local",
  hostId: "host-old",
  hostName: "Old laptop",
} as const;

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("useLocalPickHostAge", () => {
  it("waits on a Local pick's computer until its handshake, then reads its release", () => {
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK });
    const { result } = renderHook(() => useLocalPickHostAge());
    expect(result.current).toBe("unknown");

    act(() => recordNegotiatedHostMethods("host-old", ["host.status"]));
    expect(result.current).toBe("old");
  });

  it("never waits on a Personal pick, whatever the window's host has negotiated", () => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });
    const { result } = renderHook(() => useLocalPickHostAge());
    expect(result.current).toBe("none");
  });
});
