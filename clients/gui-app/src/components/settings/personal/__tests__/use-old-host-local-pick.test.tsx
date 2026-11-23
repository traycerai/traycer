import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useOldHostLocalPick } from "@/components/settings/personal/use-old-host-local-pick";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  UNRESOLVED_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const LOCAL_PICK = {
  kind: "local",
  hostId: "host-old",
  hostName: "Old laptop",
} as const;

const OLD_MANIFEST = ["host.status"];
const CURRENT_MANIFEST = { "environment.status": { major: 1, minor: 3 } };

function setPick(pick: EnvironmentPick | null): void {
  useSettingsEnvironmentPickStore.setState({ pick });
}

function setWindowHost(hostId: string | null): void {
  useSelectionAuthorityStore.setState({ effectiveHostId: hostId });
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  setPick(null);
  useSettingsEnvironmentPickStore.setState({
    defaultPick: UNRESOLVED_PICK,
    defaultHostId: null,
  });
  setWindowHost(null);
});

describe("useOldHostLocalPick", () => {
  it("reads a Local pick as an old host when it serves no environment.status", () => {
    recordNegotiatedHostMethods("host-old", OLD_MANIFEST);
    setPick(LOCAL_PICK);
    const { result } = renderHook(() => useOldHostLocalPick());
    expect(result.current).toBe(true);
  });

  it("reads a Local pick as a current host when it serves environment.status", () => {
    recordNegotiatedHostManifest("host-old", CURRENT_MANIFEST);
    setPick(LOCAL_PICK);
    const { result } = renderHook(() => useOldHostLocalPick());
    expect(result.current).toBe(false);
  });

  it("never reads a Personal pick as old, even when the window's host is old", () => {
    recordNegotiatedHostMethods("host-old", OLD_MANIFEST);
    setWindowHost("host-old");
    setPick({ kind: "personal" });
    const { result } = renderHook(() => useOldHostLocalPick());
    expect(result.current).toBe(false);
  });

  it("reads the window's own host when nothing is picked and no default is stored, before Settings has opened", () => {
    recordNegotiatedHostMethods("host-old", OLD_MANIFEST);
    setWindowHost("host-old");
    const { result } = renderHook(() => useOldHostLocalPick());
    expect(result.current).toBe(true);
  });

  it("reads a window host that serves environment.status, or has not answered, as not old", () => {
    recordNegotiatedHostManifest("host-new", CURRENT_MANIFEST);
    setWindowHost("host-new");
    const { result } = renderHook(() => useOldHostLocalPick());
    expect(result.current).toBe(false);

    act(() => setWindowHost("host-silent"));
    expect(result.current).toBe(false);
  });

  it("follows the window's host when it changes, and ignores a default stored for the host it left", () => {
    recordNegotiatedHostMethods("host-old", OLD_MANIFEST);
    recordNegotiatedHostManifest("host-new", CURRENT_MANIFEST);
    useSettingsEnvironmentPickStore.setState({
      defaultPick: { kind: "personal" },
      defaultHostId: "host-new",
    });
    setWindowHost("host-new");
    const { result } = renderHook(() => useOldHostLocalPick());
    expect(result.current).toBe(false);

    act(() => setWindowHost("host-old"));
    expect(result.current).toBe(true);

    act(() => setWindowHost("host-new"));
    expect(result.current).toBe(false);
  });
});
