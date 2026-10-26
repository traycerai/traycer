// The reads that name a configuration's hosts, list its secrets or look up a
// team environment, over a real client and a recording messenger: with the
// verdict off or unread none of them reaches the host; with environments on
// the same host is read. The verdict is read through the real
// `usePreviewFeature` from what `useAuthUser` returns.
const authUser = vi.hoisted(
  (): { current: { readonly data: unknown } } => ({
    current: { data: undefined },
  }),
);
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: authUser.current.data,
    isPending: authUser.current.data === undefined,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve({}),
  }),
}));
const windowHost = vi.hoisted(
  (): { client: HostClient<HostRpcRegistry> | null } => ({ client: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (windowHost.client === null) throw new Error("no window host");
      return windowHost.client;
    },
    useOptionalHostClient: () => windowHost.client,
  };
});
const tier = vi.hoisted((): { pool: { readonly hostId: string } | null } => ({
  pool: null,
}));
vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    return {
      ...actual,
      readProcessHostRpcTierPlan: () => ({
        ...actual.readProcessHostRpcTierPlan(),
        pool: tier.pool,
      }),
    };
  },
);
vi.mock("@/hooks/host/use-pool-tier", () => ({
  usePoolTierHostClient: (client: HostClient<HostRpcRegistry> | null) => client,
  usePoolTierStreamClient: () => ({ stub: "stream-client" }),
}));
vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/host/stream-runtime-context")
  >()),
  useStreamMethodSupportFor: () => "supported",
}));
const published = vi.hoisted(
  (): { scopes: unknown[] } => ({ scopes: [] }),
);
vi.mock("@/hooks/environment/use-environment-arms", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/environment/use-environment-arms")
  >()),
  publishEnvironmentArmScope: (scope: unknown) => {
    published.scopes.push(scope);
  },
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-requester-host-id", () => ({
  useRequesterHostId: () => "host-a",
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: { providers: [] } }),
}));
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: [] }),
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () =>
      hostScopeFixture({
        host: hostScopeOptionFixture({ hostId: "host-a", name: "dev-box" }),
        hostId: "host-a",
        status: "ready",
      }),
  };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { useGettingStartedFacts } from "@/components/onboarding/getting-started-checklist";
import { useHostsRunningPersonal } from "@/components/settings/environment/use-hosts-running-configuration";
import {
  environmentStatusFixture,
  hostEntryFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { EnvironmentArmScopeMount } from "@/providers/environment-arm-scope-mount";
import { useAuthStore } from "@/stores/auth/auth-store";

const HOST_ID = "host-a";
const RECORD_ON = {
  userId: "user-me",
  previewFeatures: { environments: true, sandboxes: false, bots: true },
};
const OFF_READINGS = [
  { reading: "an unread user record", user: undefined },
  { reading: "a record without a verdict", user: { userId: "user-me" } },
  {
    reading: "a record with environments off",
    user: {
      userId: "user-me",
      previewFeatures: { environments: false, sandboxes: false, bots: false },
    },
  },
] as const;

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  windowHost.client = null;
  authUser.current = { data: undefined };
  tier.pool = null;
  published.scopes = [];
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

function mountHost(): { readonly requests: () => string[] } {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-reads",
    handlers: {
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
          {
            environmentId: "env-team",
            ownerKind: "organization" as const,
            ownerId: "team-a",
            roomId: "room-team",
            label: "Acme",
            effectiveRole: "admin" as const,
            kind: "team" as const,
            hostCount: 1,
            providerHandle: "handle-a",
          },
        ],
      }),
      "environment.host.list": () => ({ hosts: [] }),
      "environment.status": () => environmentStatusFixture({}),
      "environment.secrets.list": () => ({ removed: [], secrets: [] }),
    },
  });
  const entry = hostEntryFixture(HOST_ID);
  const poolEntry = hostEntryFixture(POOL_HOST_ID);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => {
      if (hostId === entry.hostId) return entry;
      return hostId === poolEntry.hostId ? poolEntry : null;
    },
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  windowHost.client = spine.createRequester(entry);
  for (const id of [HOST_ID, POOL_HOST_ID]) {
    recordNegotiatedHostManifest(id, {
      "environment.list": { major: 1, minor: 0 },
      "environment.host.list": { major: 1, minor: 0 },
      "environment.status": { major: 1, minor: 1 },
      "environment.secrets.list": { major: 1, minor: 1 },
    });
  }
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-me", username: "me" },
  });
  return { requests: () => messenger.calls.map((call) => call.method) };
}

function queries({ children }: { readonly children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}

describe("useHostsRunningPersonal", () => {
  describe.each(OFF_READINGS)("with $reading", ({ user }) => {
    it("sends no environment.list, environment.host.list or environment.status request and lists no host", async () => {
      authUser.current = { data: user };
      const host = mountHost();
      const { result } = renderHook(() => useHostsRunningPersonal(), {
        wrapper: queries,
      });

      await settle();
      expect(host.requests()).toEqual([]);
      expect(result.current.hosts).toEqual([]);
    });
  });

  it("reads the environment list and the host list with environments on", async () => {
    authUser.current = { data: RECORD_ON };
    const host = mountHost();
    renderHook(() => useHostsRunningPersonal(), { wrapper: queries });

    await waitFor(() => {
      expect(host.requests()).toEqual(
        expect.arrayContaining(["environment.list", "environment.host.list"]),
      );
    });
  });
});

describe("the getting-started facts", () => {
  describe.each(OFF_READINGS)("with $reading", ({ user }) => {
    it("reads no secrets, names no second computer and shows neither environment card", async () => {
      authUser.current = { data: user };
      const host = mountHost();
      const { result } = renderHook(() => useGettingStartedFacts(), {
        wrapper: queries,
      });

      await settle();
      expect(host.requests()).toEqual([]);
      expect(result.current.environments).toBe(false);
      expect(result.current.hasSecret).toBe(false);
    });
  });

  it("reads environment.secrets.list with environments on", async () => {
    authUser.current = { data: RECORD_ON };
    const host = mountHost();
    const { result } = renderHook(() => useGettingStartedFacts(), {
      wrapper: queries,
    });

    await waitFor(() => {
      expect(host.requests()).toContain("environment.secrets.list");
    });
    expect(result.current.environments).toBe(true);
  });
});

describe("the environment arm scope", () => {
  describe.each(OFF_READINGS)("with $reading", ({ user }) => {
    it("publishes no scope and sends no environment.list request", async () => {
      authUser.current = { data: user };
      tier.pool = { hostId: "pool-host" };
      const host = mountHost();
      render(<EnvironmentArmScopeMount />, { wrapper: queries });

      await settle();
      expect(host.requests()).toEqual([]);
      expect(published.scopes.length).toBeGreaterThan(0);
      expect(published.scopes.every((scope) => scope === null)).toBe(true);
    });
  });

  it("reads the environment list and publishes the team's scope with environments on", async () => {
    authUser.current = { data: RECORD_ON };
    tier.pool = { hostId: HOST_ID };
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "user-me", username: "me" },
    });
    const host = mountHost();
    render(<EnvironmentArmScopeMount />, { wrapper: queries });

    await waitFor(() => {
      expect(published.scopes.some((scope) => scope !== null)).toBe(true);
    });
    expect(host.requests()).toContain("environment.list");
  });
});
