import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
  membershipState: "ready" as "ready" | "loading" | "failed",
  membershipHostIds: [] as string[],
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
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningConfiguration: () => ({
      hosts: harness.membershipHostIds.map((hostId) => ({
        hostId,
        name: hostId,
      })),
      state: harness.membershipState,
      collisions: [],
      retry: () => undefined,
      reread: () => undefined,
      thisComputerUnread: false,
    }),
  }),
);
vi.mock("@/components/settings/host-scope/use-settings-host-entry", () => ({
  useSettingsHostEntry: () => ({ failed: false, retry: () => undefined }),
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => harnessClient,
  };
});
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (target: HostDirectoryEntry | null) =>
    target === null ? null : harnessClient,
}));
vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
}));

let harnessClient: HostClient<HostRpcRegistry>;

import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

function makeClient(): HostClient<HostRpcRegistry> {
  const entry: HostDirectoryEntry = {
    hostId: "ambient",
    label: "Ambient",
    kind: "remote",
    websocketUrl: "wss://mock-remote.invalid/rpc",
    version: "1.1.11",
    transportDialability: "dialable",
  };
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-settings-scope",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok" }),
  );
  return client.createRequester(entry);
}

function installHosts(): void {
  harnessClient = makeClient();
  harness.hosts = [
    hostScopeOptionFixture({
      hostId: "host-b",
      isLocalMachine: false,
      isActive: false,
    }),
    hostScopeOptionFixture({
      hostId: "host-a",
      isLocalMachine: false,
      isActive: true,
    }),
    hostScopeOptionFixture({
      hostId: "host-c",
      isLocalMachine: false,
      isActive: false,
    }),
  ];
  harness.activeHostId = "host-a";
  harness.membershipHostIds = ["host-a", "host-b"];
  harness.membershipState = "ready";
  useSettingsEnvironmentPickStore.setState({
    pick: PERSONAL_PICK,
    defaultPick: PERSONAL_PICK,
  });
}

afterEach(() => {
  cleanup();
  useSettingsHostScopeStore.getState().reset();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
  harness.hosts = [];
  harness.activeHostId = null;
  harness.membershipHostIds = [];
  harness.membershipState = "ready";
});

describe("Settings host scope membership", () => {
  it("chooses the first filtered option and remembers explicit hosts by environment", () => {
    installHosts();
    const { result, rerender } = renderHook(() => useHostScope());

    expect(result.current.hostId).toBe("host-b");

    act(() => result.current.setHostId("host-a"));
    act(() => {
      harness.membershipHostIds = ["host-b", "host-c"];
      useSettingsEnvironmentPickStore
        .getState()
        .setPick({ kind: "team", environmentId: "team-one" });
    });
    rerender();
    expect(result.current.hostId).toBe("host-b");

    act(() => result.current.setHostId("host-c"));
    act(() => {
      harness.membershipHostIds = ["host-a", "host-b"];
      useSettingsEnvironmentPickStore.getState().setPick(PERSONAL_PICK);
    });
    rerender();
    expect(result.current.hostId).toBe("host-a");

    act(() => {
      harness.membershipHostIds = ["host-b", "host-c"];
      useSettingsEnvironmentPickStore
        .getState()
        .setPick({ kind: "team", environmentId: "team-one" });
    });
    rerender();
    expect(result.current.hostId).toBe("host-c");
  });

  it("keeps the named host vanished when membership no longer includes it", () => {
    installHosts();
    useSettingsHostScopeStore.getState().selectHost(PERSONAL_PICK, {
      hostId: "host-gone",
      name: "Old workstation",
    });
    const { result } = renderHook(() => useHostScope());

    expect(result.current.hostId).toBeNull();
    expect(result.current.vanishedHostId).toBe("host-gone");
    const vanishedSelection = result.current.vanishedSelection;
    expect(vanishedSelection?.name).toBe("Old workstation");
    act(() => vanishedSelection?.forget());
    expect(result.current.hostId).toBe("host-b");
    expect(result.current.vanishedHostId).toBeNull();
  });

  it.each(["loading", "failed"] as const)(
    "selects no host while membership is %s",
    (membershipState) => {
      installHosts();
      harness.membershipState = membershipState;
      const { result } = renderHook(() => useHostScope());

      expect(result.current.hostId).toBeNull();
      expect(result.current.client).toBeNull();
      expect(result.current.isLoading).toBe(membershipState === "loading");
      expect(result.current.listsFailed).toBe(membershipState === "failed");
    },
  );
});
