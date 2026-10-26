import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useRereadHostReadsOnFocus } from "@/hooks/environment/use-reread-host-reads-on-focus";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import {
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  personalPoolSource,
  requireTeamHostClient,
  requireViewingHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const LOCAL_HOST_ID = mockLocalHostEntry.hostId;
const REMOTE_HOST_ID = mockRemoteHostEntry.hostId;

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

function LocalEnvironmentReaders(): ReactNode {
  const client = requireTeamHostClient();
  const status = useEnvironmentStatusRead(client, LOCAL_HOST_ID, true);
  useHostQuery<HostRpcRegistry, "environment.secrets.list">({
    cacheKeyIdentity: ["user-me"],
    client,
    method: "environment.secrets.list",
    params: { environmentId: "env-personal" },
    options: {},
  });
  useHostQuery<HostRpcRegistry, "environment.secrets.versions">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.secrets.versions",
    params: { environmentId: "env-personal", secretId: "sec-1" },
    options: {},
  });
  useHostQuery<HostRpcRegistry, "environment.secrets.rotation">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.secrets.rotation",
    params: { environmentId: "env-personal", secretId: "sec-1" },
    options: {},
  });
  useHostQuery<HostRpcRegistry, "providers.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.list",
    params: { native: null },
    options: {},
  });
  useHostQuery<HostRpcRegistry, "config.env.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "config.env.list",
    params: {},
    options: {},
  });
  return (
    <p data-testid="received-revision">{status.data?.receivedRevision ?? ""}</p>
  );
}

function FocusReaders(): ReactNode {
  useRereadHostReadsOnFocus(LOCAL_HOST_ID);
  const localClient = requireTeamHostClient();
  const remoteClient = requireViewingHostClient();
  useHostQuery<HostRpcRegistry, "providers.list">({
    cacheKeyIdentity: undefined,
    client: localClient,
    method: "providers.list",
    params: { native: null },
    options: {},
  });
  useHostQuery<HostRpcRegistry, "config.env.list">({
    cacheKeyIdentity: undefined,
    client: localClient,
    method: "config.env.list",
    params: {},
    options: {},
  });
  useHostQuery<HostRpcRegistry, "providers.list">({
    cacheKeyIdentity: undefined,
    client: remoteClient,
    method: "providers.list",
    params: { native: null },
    options: {},
  });
  useHostQuery<HostRpcRegistry, "config.env.list">({
    cacheKeyIdentity: undefined,
    client: remoteClient,
    method: "config.env.list",
    params: {},
    options: {},
  });
  useHostQuery<HostRpcRegistry, "environment.secrets.list">({
    cacheKeyIdentity: ["user-me"],
    client: localClient,
    method: "environment.secrets.list",
    params: { environmentId: "env-personal" },
    options: {},
  });
  useHostQuery<HostRpcRegistry, "environment.secrets.versions">({
    cacheKeyIdentity: undefined,
    client: localClient,
    method: "environment.secrets.versions",
    params: { environmentId: "env-personal", secretId: "sec-1" },
    options: {},
  });
  useHostQuery<HostRpcRegistry, "environment.secrets.rotation">({
    cacheKeyIdentity: undefined,
    client: localClient,
    method: "environment.secrets.rotation",
    params: { environmentId: "env-personal", secretId: "sec-1" },
    options: {},
  });
  return null;
}

function handlersFor(status: () => EnvironmentStatusResponseV11) {
  return {
    "environment.status": status,
    "environment.list": () => ({
      environments: [
        {
          environmentId: "env-personal",
          ownerKind: "user" as const,
          ownerId: "user-me",
          roomId: "room-personal",
          label: "Personal",
          effectiveRole: "owner" as const,
          kind: "personal" as const,
          hostCount: 1,
          providerHandle: null,
        },
      ],
    }),
    "environment.secrets.list": () => ({ secrets: [], removed: [] }),
    "environment.secrets.versions": () => ({ versions: [], removal: null }),
    "environment.secrets.rotation": () => ({
      rotation: null,
      lastVerify: null,
    }),
    "providers.list": () => ({ providers: [], native: null }),
    "config.env.list": () => ({ entries: [] }),
  };
}

function readCounts(
  harness: TeamPageHarness,
  methods: readonly string[],
  hostId: string,
): Record<string, number> {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      hostIdsOf(harness, method).filter((id) => id === hostId).length,
    ]),
  );
}

function seedPersonalHostReads(): EnvironmentStatusResponseV11 {
  return environmentStatusFixture({
    principal: { kind: "personal" },
    receivedRevision: 1,
    appliedRevision: 1,
  });
}

beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("a Personal host on a build with a server pool", () => {
  it("re-reads pool secrets and host-local provider and environment reads when its revision moves", async () => {
    let status = seedPersonalHostReads();
    recordNegotiatedHostManifest(LOCAL_HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
    });
    const harness = mountTeamPageOnPoolBuild(
      personalPoolSource(),
      handlersFor(() => status),
    );
    render(<LocalEnvironmentReaders />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("received-revision").textContent).toBe("1");
      expect(hostIdsOf(harness, "environment.list")).toEqual([POOL_HOST_ID]);
    });
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    const poolBefore = readCounts(
      harness,
      [
        "environment.secrets.list",
        "environment.secrets.versions",
        "environment.secrets.rotation",
      ],
      POOL_HOST_ID,
    );
    const localBefore = readCounts(
      harness,
      ["providers.list", "config.env.list"],
      LOCAL_HOST_ID,
    );

    status = environmentStatusFixture({
      principal: { kind: "personal" },
      receivedRevision: 2,
      appliedRevision: 2,
    });
    await harness.queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(LOCAL_HOST_ID, "environment.status"),
    });

    await waitFor(() => {
      expect(screen.getByTestId("received-revision").textContent).toBe("2");
      for (const [method, count] of Object.entries(poolBefore)) {
        expect(
          hostIdsOf(harness, method).filter((id) => id === POOL_HOST_ID),
        ).toHaveLength(count + 1);
      }
      for (const [method, count] of Object.entries(localBefore)) {
        expect(
          hostIdsOf(harness, method).filter((id) => id === LOCAL_HOST_ID),
        ).toHaveLength(count + 1);
      }
    });
    for (const method of [
      "environment.secrets.list",
      "environment.secrets.versions",
      "environment.secrets.rotation",
    ]) {
      expect(new Set(hostIdsOf(harness, method))).toEqual(
        new Set([POOL_HOST_ID]),
      );
    }
    for (const method of ["providers.list", "config.env.list"]) {
      expect(new Set(hostIdsOf(harness, method))).toEqual(
        new Set([LOCAL_HOST_ID]),
      );
    }
  });

  it("re-reads pool secrets and only this Local host's provider and environment reads on focus", async () => {
    const harness = mountTeamPageOnPoolBuild(
      personalPoolSource(),
      handlersFor(seedPersonalHostReads),
    );
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: LOCAL_HOST_ID, hostName: "This Mac" },
    });
    render(
      <PersonalPageFrame section="secrets">
        <FocusReaders />
      </PersonalPageFrame>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => {
      for (const method of [
        "environment.secrets.list",
        "environment.secrets.versions",
        "environment.secrets.rotation",
        "providers.list",
        "config.env.list",
      ]) {
        expect(hostIdsOf(harness, method)).not.toHaveLength(0);
      }
      expect(hostIdsOf(harness, "providers.list")).toContain(REMOTE_HOST_ID);
      expect(hostIdsOf(harness, "config.env.list")).toContain(REMOTE_HOST_ID);
    });
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    const before = harness.messenger.calls.map((call) => ({
      method: call.method,
      hostId: call.authority.endpoint.hostId,
    }));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      for (const method of [
        "environment.secrets.list",
        "environment.secrets.versions",
        "environment.secrets.rotation",
        "providers.list",
        "config.env.list",
      ]) {
        expect(
          harness.messenger.calls.filter(
            (call) =>
              call.method === method &&
              call.authority.endpoint.hostId ===
                (method.startsWith("environment.secrets.")
                  ? POOL_HOST_ID
                  : LOCAL_HOST_ID),
          ),
        ).toHaveLength(
          before.filter(
            (call) =>
              call.method === method &&
              call.hostId ===
                (method.startsWith("environment.secrets.")
                  ? POOL_HOST_ID
                  : LOCAL_HOST_ID),
          ).length + 1,
        );
      }
    });
    for (const method of ["providers.list", "config.env.list"]) {
      expect(
        hostIdsOf(harness, method).filter((id) => id === REMOTE_HOST_ID),
      ).toHaveLength(1);
    }
    for (const method of [
      "environment.secrets.list",
      "environment.secrets.versions",
      "environment.secrets.rotation",
    ]) {
      expect(new Set(hostIdsOf(harness, method))).toEqual(
        new Set([POOL_HOST_ID]),
      );
    }
    for (const method of ["providers.list", "config.env.list"]) {
      expect(new Set(hostIdsOf(harness, method))).toEqual(
        new Set([LOCAL_HOST_ID, REMOTE_HOST_ID]),
      );
    }
  });
});
