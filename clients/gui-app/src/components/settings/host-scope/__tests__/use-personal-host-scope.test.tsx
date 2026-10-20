import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

// A Personal page in a window bound to one host reads
// THAT host, and a pick made under the Host group moves only the Host group.
// Every panel suite mocks the scope hook, so none of them can see this; here
// the REAL `useHostScope` and `usePersonalHostScope` run over the REAL
// settings pick store, and only the host list and the clients are stood in.

const WINDOW_HOST_ID = "host-window";
const PICKED_HOST_ID = "host-picked";

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
  ambientClient: null as HostClient<HostRpcRegistry> | null,
  overrideClient: null as HostClient<HostRpcRegistry> | null,
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
      requestId: () => `req-personal-scope-${hostId}`,
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-personal-scope",
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
  harness.hosts = [];
  harness.activeHostId = null;
  harness.ambientClient = null;
  harness.overrideClient = null;
});

describe("usePersonalHostScope", () => {
  it("reads the window's own host while the Host group is pointed at another host", () => {
    installTwoHosts();
    useSettingsHostScopeStore.setState({ scopedHostId: PICKED_HOST_ID });

    const { result } = renderBothScopes();

    expect(result.current.hostGroup.hostId).toBe(PICKED_HOST_ID);
    expect(result.current.hostGroup.isViewingActive).toBe(false);
    expect(result.current.personal.hostId).toBe(WINDOW_HOST_ID);
    expect(result.current.personal.isViewingActive).toBe(true);
    expect(result.current.personal.status).toBe("following");
    expect(result.current.personal.client).toBe(harness.ambientClient);
  });

  it("is moved by no pick: a pick under the Host group changes only the Host group", () => {
    installTwoHosts();
    const { result } = renderBothScopes();
    expect(result.current.hostGroup.hostId).toBe(WINDOW_HOST_ID);
    expect(result.current.personal.hostId).toBe(WINDOW_HOST_ID);

    act(() => {
      result.current.hostGroup.setHostId(PICKED_HOST_ID);
    });

    expect(result.current.hostGroup.hostId).toBe(PICKED_HOST_ID);
    expect(result.current.personal.hostId).toBe(WINDOW_HOST_ID);
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(
      PICKED_HOST_ID,
    );
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

  it("follows the window when the window's own host changes", () => {
    installTwoHosts();
    useSettingsHostScopeStore.setState({ scopedHostId: PICKED_HOST_ID });
    const { result, rerender } = renderBothScopes();
    expect(result.current.personal.hostId).toBe(WINDOW_HOST_ID);

    harness.hosts = [
      hostRow(WINDOW_HOST_ID, false),
      hostRow(PICKED_HOST_ID, true),
    ];
    harness.activeHostId = PICKED_HOST_ID;
    harness.ambientClient = makeClient(PICKED_HOST_ID);
    rerender();

    expect(result.current.personal.hostId).toBe(PICKED_HOST_ID);
    expect(result.current.personal.status).toBe("following");
  });
});
