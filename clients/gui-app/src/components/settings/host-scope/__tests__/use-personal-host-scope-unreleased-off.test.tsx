import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

// The build without environments (`unreleased-features.ts`) has no
// Environment dropdown: the pages it would govern sit under the Host picker
// and read the host it names, as they did before the feature. So the
// Personal scope follows the Host group's own selection, vanished pick
// included, and offers no setter of its own. Same harness as the on-build
// suite: the REAL hooks over the REAL stores, with the host list and the
// clients stood in.

const WINDOW_HOST_ID = "host-window";
const PICKED_HOST_ID = "host-picked";
const GONE_HOST_ID = "host-gone";

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
  ambientClient: null as HostClient<HostRpcRegistry> | null,
  overrideClient: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    selectionAuthority: {
      activate: () => Promise.resolve({ ok: true as const }),
    },
    hostManagement: null,
  }),
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } = await import("../host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: harness.hosts,
        activeHostId: harness.activeHostId,
      }),
  };
});

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (harness.ambientClient === null) {
        throw new Error("ambient client not installed");
      }
      return harness.ambientClient;
    },
  };
});

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => harness.overrideClient,
}));

vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
}));

import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  useHostScope,
  usePersonalHostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import {
  useEnvironmentPick,
  useSettingsEnvironmentPickStore,
} from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

function makeClient(hostId: string): HostClient<HostRpcRegistry> {
  const entry: HostDirectoryEntry = {
    hostId,
    label: hostId,
    kind: "remote",
    websocketUrl: "wss://mock-remote.invalid/rpc",
    version: "1.1.11",
    transportDialability: "dialable",
  };
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (id) => (id === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-personal-scope-off-${hostId}`,
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-personal-scope-off",
    }),
  );
  return client.createRequester(entry);
}

function hostRow(hostId: string, isActive: boolean): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    isLocalMachine: false,
    isActive,
    connectable: true,
  });
}

function installTwoHosts(): void {
  harness.hosts = [
    hostRow(WINDOW_HOST_ID, true),
    hostRow(PICKED_HOST_ID, false),
  ];
  harness.activeHostId = WINDOW_HOST_ID;
  harness.ambientClient = makeClient(WINDOW_HOST_ID);
  harness.overrideClient = makeClient(PICKED_HOST_ID);
}

function renderBothScopes() {
  return renderHook(() => ({
    hostGroup: useHostScope(),
    personal: usePersonalHostScope(),
  }));
}

afterEach(() => {
  cleanup();
  useSettingsHostScopeStore.setState({ scopedHostId: null });
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
  harness.hosts = [];
  harness.activeHostId = null;
  harness.ambientClient = null;
  harness.overrideClient = null;
});

describe("usePersonalHostScope without environments", () => {
  it("reads the host the Host picker names, with that host's client", () => {
    installTwoHosts();
    useSettingsHostScopeStore.setState({ scopedHostId: PICKED_HOST_ID });

    const { result } = renderBothScopes();

    expect(result.current.hostGroup.hostId).toBe(PICKED_HOST_ID);
    expect(result.current.personal.hostId).toBe(PICKED_HOST_ID);
    expect(result.current.personal.isViewingActive).toBe(false);
    expect(result.current.personal.client).toBe(harness.overrideClient);
  });

  it("follows a pick made under the Host group", () => {
    installTwoHosts();
    const { result } = renderBothScopes();
    expect(result.current.personal.hostId).toBe(WINDOW_HOST_ID);
    expect(result.current.personal.status).toBe("following");

    act(() => {
      result.current.hostGroup.setHostId(PICKED_HOST_ID);
    });

    expect(result.current.personal.hostId).toBe(PICKED_HOST_ID);
  });

  it("keeps a vanished pick vanished instead of reading the active host", () => {
    installTwoHosts();
    useSettingsHostScopeStore.setState({ scopedHostId: GONE_HOST_ID });

    const { result } = renderBothScopes();

    expect(result.current.hostGroup.status).toBe("vanished");
    expect(result.current.personal.status).toBe("vanished");
    expect(result.current.personal.hostId).toBeNull();
    expect(result.current.personal.vanishedHostId).toBe(GONE_HOST_ID);
  });

  it("offers no way to re-point itself: its setter changes neither scope", () => {
    installTwoHosts();
    const { result } = renderBothScopes();

    act(() => {
      result.current.personal.setHostId(PICKED_HOST_ID);
    });

    expect(result.current.personal.hostId).toBe(WINDOW_HOST_ID);
    expect(result.current.hostGroup.hostId).toBe(WINDOW_HOST_ID);
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBeNull();
  });
});

// Every page branches on the pick; without the dropdown it is the Host
// picker's host as a Local row, so no page takes its Personal arm, whatever
// the store holds.
describe("useEnvironmentPick without environments", () => {
  it("is the Host picker's host as a Local row, never Personal", () => {
    installTwoHosts();
    const { result } = renderHook(() => useEnvironmentPick());
    expect(result.current).toEqual({
      kind: "local",
      hostId: WINDOW_HOST_ID,
      hostName: WINDOW_HOST_ID,
    });

    act(() => {
      useSettingsHostScopeStore.setState({ scopedHostId: PICKED_HOST_ID });
    });

    expect(result.current).toEqual({
      kind: "local",
      hostId: PICKED_HOST_ID,
      hostName: PICKED_HOST_ID,
    });
  });

  it("stays a Local row with no host to name", () => {
    const { result } = renderHook(() => useEnvironmentPick());
    expect(result.current).toEqual({
      kind: "local",
      hostId: "",
      hostName: "No host",
    });
  });
});
