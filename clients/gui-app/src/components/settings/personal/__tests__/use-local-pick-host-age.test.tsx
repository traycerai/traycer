import { cleanup, renderHook } from "@testing-library/react";
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
  it("reads a Local pick's computer as old when it serves no environment.status", () => {
    recordNegotiatedHostMethods("host-old", ["host.status"]);
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK });
    const { result } = renderHook(() => useLocalPickHostAge());
    expect(result.current).toBe("old");
  });

  it("reads a Local pick's computer as current when it serves environment.status", () => {
    recordNegotiatedHostMethods("host-old", ["environment.status"]);
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK });
    const { result } = renderHook(() => useLocalPickHostAge());
    expect(result.current).toBe("current");
  });

  it("never reads a Personal pick as old, whatever the window's host has negotiated", () => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });
    const { result } = renderHook(() => useLocalPickHostAge());
    expect(result.current).toBe("none");
  });
});
