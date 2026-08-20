import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { IHostManagement } from "@traycer-clients/shared/platform/runner-host";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  buildOverviewManagement,
  updateCheckManifest,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

const LOCAL_HOST_ID = "host-local";
const REMOTE_HOST_ID = "host-remote";
const FOREIGN_HOST_ID = "host-foreign";

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
  hostManagement: null as IHostManagement | null,
  ambientClient: null as HostClient<HostRpcRegistry> | null,
  overrideClient: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    selectionAuthority: {
      activate: () => Promise.resolve({ ok: true as const }),
    },
    hostManagement: harness.hostManagement,
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
import { useHostScopeFor } from "@/components/settings/host-scope/use-host-scope";

function makeClient(input: {
  readonly hostId: string;
  readonly rpcCalls: string[] | undefined;
}): HostClient<HostRpcRegistry> {
  const entry: HostDirectoryEntry = {
    hostId: input.hostId,
    label: input.hostId,
    kind: input.hostId === LOCAL_HOST_ID ? "local" : "remote",
    websocketUrl:
      input.hostId === LOCAL_HOST_ID
        ? "ws://127.0.0.1:0"
        : "wss://mock-remote.invalid/rpc",
    version: "1.1.11",
    transportDialability: "dialable",
  };
  const rpcCalls = input.rpcCalls;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-scope-fallback-${input.hostId}`,
      handlers: {
        "host.update.check": () => {
          if (rpcCalls !== undefined) rpcCalls.push("host.update.check");
          return {
            outcome: "ok" as const,
            manifest: updateCheckManifest("rpc-only-1.0.0"),
          };
        },
      },
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-scope-fallback",
    }),
  );
  return client.createRequester(entry);
}

function localHost(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: LOCAL_HOST_ID,
    isLocalMachine: true,
    isActive: true,
    connectable: true,
  });
}

function remoteHost(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: REMOTE_HOST_ID,
    isLocalMachine: false,
    isActive: true,
    connectable: true,
  });
}

function renderScope(scopedHostId: string | null) {
  return renderHook(() =>
    useHostScopeFor({
      scopedHostId,
      setScopedHostId: () => undefined,
    }),
  );
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  harness.hosts = [];
  harness.activeHostId = null;
  harness.hostManagement = null;
  harness.ambientClient = null;
  harness.overrideClient = null;
});

describe("useHostScopeFor local-maintenance fallback construction", () => {
  it("in the following state, scope.client serves an intercepted method over the bridge, not the RPC spine", async () => {
    const rpcCalls: string[] = [];
    const ambient = makeClient({ hostId: LOCAL_HOST_ID, rpcCalls });
    const maintenanceUpdateCheck = vi.fn(() =>
      Promise.resolve({
        outcome: "ok" as const,
        manifest: updateCheckManifest("bridge-1.2.0"),
      }),
    );
    harness.ambientClient = ambient;
    harness.overrideClient = null;
    harness.hosts = [localHost()];
    harness.activeHostId = LOCAL_HOST_ID;
    harness.hostManagement = buildOverviewManagement({
      maintenanceUpdateCheck,
    });
    recordNegotiatedHostMethods(LOCAL_HOST_ID, ["host.status"]);

    const { result } = renderScope(null);

    expect(result.current.status).toBe("following");
    expect(result.current.client).not.toBeNull();
    expect(result.current.client).not.toBe(ambient);
    expect(result.current.localMaintenanceFallback).toBe(true);
    expect(result.current.client?.getActiveHostId()).toBe(LOCAL_HOST_ID);

    const answer = await result.current.client?.request("host.update.check", {
      includePreReleases: false,
    });
    expect(answer).toEqual({
      outcome: "ok",
      manifest: updateCheckManifest("bridge-1.2.0"),
    });
    expect(maintenanceUpdateCheck).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toEqual([]);
  });

  it("delegates an intercepted method when the wrapped client's active host is not the local id", async () => {
    const rpcCalls: string[] = [];
    const ambient = makeClient({ hostId: FOREIGN_HOST_ID, rpcCalls });
    const maintenanceUpdateCheck = vi.fn(() =>
      Promise.resolve({
        outcome: "ok" as const,
        manifest: updateCheckManifest("bridge-1.2.0"),
      }),
    );
    harness.ambientClient = ambient;
    harness.overrideClient = null;
    harness.hosts = [localHost()];
    harness.activeHostId = LOCAL_HOST_ID;
    harness.hostManagement = buildOverviewManagement({
      maintenanceUpdateCheck,
    });
    recordNegotiatedHostMethods(LOCAL_HOST_ID, ["host.status"]);

    const { result } = renderScope(null);

    expect(result.current.status).toBe("following");
    expect(result.current.localMaintenanceFallback).toBe(true);
    expect(result.current.client?.getActiveHostId()).toBe(FOREIGN_HOST_ID);

    const answer = await result.current.client?.request("host.update.check", {
      includePreReleases: false,
    });
    expect(answer).toEqual({
      outcome: "ok",
      manifest: updateCheckManifest("rpc-only-1.0.0"),
    });
    expect(rpcCalls).toEqual(["host.update.check"]);
    expect(maintenanceUpdateCheck).not.toHaveBeenCalled();
  });

  it("decorates the client for a ready local scope when a bridge exists", () => {
    const ambient = makeClient({
      hostId: REMOTE_HOST_ID,
      rpcCalls: undefined,
    });
    const override = makeClient({
      hostId: LOCAL_HOST_ID,
      rpcCalls: undefined,
    });
    harness.ambientClient = ambient;
    harness.overrideClient = override;
    harness.hosts = [
      hostScopeOptionFixture({
        hostId: LOCAL_HOST_ID,
        isLocalMachine: true,
        isActive: false,
        connectable: true,
      }),
      remoteHost(),
    ];
    harness.activeHostId = REMOTE_HOST_ID;
    harness.hostManagement = buildOverviewManagement({});

    const { result } = renderScope(LOCAL_HOST_ID);

    expect(result.current.status).toBe("ready");
    expect(result.current.client).not.toBeNull();
    expect(result.current.client).not.toBe(override);
    expect(result.current.client).not.toBe(ambient);
    expect(result.current.localMaintenanceFallback).toBe(true);
    expect(result.current.client?.getActiveHostId()).toBe(LOCAL_HOST_ID);
  });

  it("does not decorate a remote scope even when a bridge exists", () => {
    const ambient = makeClient({
      hostId: REMOTE_HOST_ID,
      rpcCalls: undefined,
    });
    harness.ambientClient = ambient;
    harness.overrideClient = null;
    harness.hosts = [remoteHost()];
    harness.activeHostId = REMOTE_HOST_ID;
    harness.hostManagement = buildOverviewManagement({});

    const { result } = renderScope(null);

    expect(result.current.status).toBe("following");
    expect(result.current.client).toBe(ambient);
    expect(result.current.localMaintenanceFallback).toBe(false);
  });

  it("does not decorate a local scope in a bridge-less shell", () => {
    const ambient = makeClient({
      hostId: LOCAL_HOST_ID,
      rpcCalls: undefined,
    });
    harness.ambientClient = ambient;
    harness.overrideClient = null;
    harness.hosts = [localHost()];
    harness.activeHostId = LOCAL_HOST_ID;
    harness.hostManagement = null;

    const { result } = renderScope(null);

    expect(result.current.status).toBe("following");
    expect(result.current.client).toBe(ambient);
    expect(result.current.localMaintenanceFallback).toBe(false);
  });

  it("sets localMaintenanceFallback true exactly when the client is decorated", () => {
    const ambient = makeClient({
      hostId: LOCAL_HOST_ID,
      rpcCalls: undefined,
    });
    harness.ambientClient = ambient;
    harness.overrideClient = null;
    harness.hosts = [localHost()];
    harness.activeHostId = LOCAL_HOST_ID;
    harness.hostManagement = buildOverviewManagement({});

    const decorated = renderScope(null);
    expect(decorated.result.current.localMaintenanceFallback).toBe(
      decorated.result.current.client !== ambient,
    );
    expect(decorated.result.current.localMaintenanceFallback).toBe(true);
    decorated.unmount();

    harness.hostManagement = null;
    const plain = renderScope(null);
    expect(plain.result.current.localMaintenanceFallback).toBe(
      plain.result.current.client !== ambient,
    );
    expect(plain.result.current.localMaintenanceFallback).toBe(false);
    expect(plain.result.current.client).toBe(ambient);
  });
});
