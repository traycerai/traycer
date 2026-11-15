import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  EnvironmentHostRecordV12,
  EnvironmentListResponseV11,
} from "@traycer/protocol/host/environment/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import {
  OwnEnvironmentAuthProvider,
  createOwnEnvironmentAuthRuntime,
  installOwnEnvironmentTransport,
  jsonResponse,
  signInOwnEnvironment,
  WINDOW_HOST,
  type OwnEnvironmentAuthRuntime,
  type OwnEnvironmentTransport,
} from "./own-environment-authn-test-support";
import { useHostOwnEnvironment } from "@/hooks/environment/use-host-own-environment";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const PERSONAL_ID = "env-personal";
const TEAM_A_ID = "env-team-a";
const TEAM_B_ID = "env-team-b";

const hostRecord: EnvironmentHostRecordV12 = {
  hostId: WINDOW_HOST,
  hostLabel: "window host",
  hostPlatform: "linux",
  enrolledByUserId: null,
  kind: "personal",
  boundAt: null,
  reachable: true,
  lastReportedAt: null,
  applied: [],
  hasLocalRow: null,
};

const personalDirectory: EnvironmentListResponseV11 = {
  environments: [
    {
      environmentId: PERSONAL_ID,
      ownerKind: "user",
      ownerId: "user-1",
      roomId: "room-personal",
      label: "Personal",
      effectiveRole: "owner",
      kind: "personal",
      hostCount: 1,
      providerHandle: null,
    },
  ],
};

const teamDirectory: EnvironmentListResponseV11 = {
  environments: [
    {
      environmentId: TEAM_A_ID,
      ownerKind: "organization",
      ownerId: "team-1",
      roomId: "room-a",
      label: "Team A",
      effectiveRole: "owner",
      kind: "team",
      hostCount: 1,
      providerHandle: null,
    },
    {
      environmentId: TEAM_B_ID,
      ownerKind: "organization",
      ownerId: "team-2",
      roomId: "room-b",
      label: "Team B",
      effectiveRole: "owner",
      kind: "team",
      hostCount: 1,
      providerHandle: null,
    },
  ],
};

let runtime: OwnEnvironmentAuthRuntime;
let transport: OwnEnvironmentTransport;
let directory: EnvironmentListResponseV11;
let route: (url: URL, method: string) => Response | undefined;

function installTransport(): void {
  transport = installOwnEnvironmentTransport((request) => {
    if (request.url.pathname === "/api/environments") {
      return jsonResponse(200, { environments: directory.environments });
    }
    return route(request.url, request.method);
  }, { environments: directory.environments });
}

function mount(
  handlers: MockHandlerMap<HostRpcRegistry>,
  methods: readonly string[],
) {
  const client = buildEnvironmentClient({
    hostId: WINDOW_HOST,
    handlers,
  }).client;
  recordNegotiatedHostMethods(WINDOW_HOST, methods);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const wrapper = (props: { children: ReactNode }) => (
    <OwnEnvironmentAuthProvider binding={runtime.binding}>
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    </OwnEnvironmentAuthProvider>
  );
  return renderHook(
    () => useHostOwnEnvironment(client, WINDOW_HOST, true),
    { wrapper },
  );
}

beforeEach(async () => {
  route = () => undefined;
  directory = personalDirectory;
  installTransport();
  runtime = createOwnEnvironmentAuthRuntime();
  await signInOwnEnvironment(runtime);
  recordNegotiatedHostMethods(WINDOW_HOST, ["environment.status"]);
});

afterEach(() => {
  cleanup();
  transport.restore();
  runtime.dispose();
  useAuthStore.setState({ status: "signed-out" });
  resetNegotiatedManifests();
});

describe("the window host's own environment through authn", () => {
  it("names the listed Personal environment for a Personal host", async () => {
    directory = personalDirectory;
    route = (url, method) => {
      if (url.pathname === "/api/v3/environments/env-personal/hosts" && method === "GET") {
        return jsonResponse(200, { hosts: [{ ...hostRecord, purgePending: false }] });
      }
      return undefined;
    };
    const { result } = mount(
      { "environment.status": () => environmentStatusFixture({ principal: { kind: "personal" } }) },
      ["environment.status"],
    );

    await waitFor(() => expect(result.current).toMatchObject({
      environmentId: PERSONAL_ID,
      resolved: true,
    }));
    expect(transport.requests.some((request) =>
      request.url.pathname === "/api/v3/environments/env-personal/hosts",
    )).toBe(true);
  });

  it("names the team environment whose authn host list contains this host", async () => {
    directory = teamDirectory;
    useAuthStore.setState({
      shareableTeams: [
        { teamId: "team-1", slug: "team-a", avatarUrl: null },
        { teamId: "team-2", slug: "team-b", avatarUrl: null },
      ],
    });
    route = (url, method) => {
      const path = url.pathname;
      if (path.endsWith("/hosts") && method === "GET") {
        const environmentId = path.split("/")[4];
        return jsonResponse(200, {
          hosts: environmentId === TEAM_B_ID ? [{ ...hostRecord, purgePending: false }] : [],
        });
      }
      if (path.endsWith("/members") && method === "GET") {
        return jsonResponse(200, { viewer: { effectiveRole: "editor" } });
      }
      return undefined;
    };
    const { result } = mount(
      { "environment.status": () => environmentStatusFixture({
        principal: { kind: "team", teamName: "Team B" },
      }) },
      ["environment.status"],
    );

    await waitFor(() => expect(result.current).toMatchObject({
      environmentId: TEAM_B_ID,
      resolved: true,
    }));
    expect(transport.requests.some((request) =>
      request.url.pathname === "/api/v3/environments/env-team-b/hosts",
    )).toBe(true);
  });

  it("does not guess a team environment when a host list fails", async () => {
    directory = teamDirectory;
    useAuthStore.setState({
      shareableTeams: [
        { teamId: "team-1", slug: "team-a", avatarUrl: null },
        { teamId: "team-2", slug: "team-b", avatarUrl: null },
      ],
    });
    route = (url, method) => {
      if (url.pathname.endsWith("/hosts") && method === "GET") {
        const environmentId = url.pathname.split("/")[4];
        if (environmentId === TEAM_B_ID) return jsonResponse(503, {});
        return jsonResponse(200, { hosts: [] });
      }
      if (url.pathname.endsWith("/members") && method === "GET") {
        return jsonResponse(200, { viewer: { effectiveRole: "editor" } });
      }
      return undefined;
    };
    const { result } = mount(
      { "environment.status": () => environmentStatusFixture({
        principal: { kind: "team", teamName: "Team B" },
      }) },
      ["environment.status"],
    );

    await waitFor(() => expect(result.current.resolved).toBe(false));
    expect(result.current.environmentId).toBeNull();
  });

  it("resolves to no named environment only after every team host list answers without this host", async () => {
    directory = teamDirectory;
    useAuthStore.setState({
      shareableTeams: [
        { teamId: "team-1", slug: "team-a", avatarUrl: null },
        { teamId: "team-2", slug: "team-b", avatarUrl: null },
      ],
    });
    route = (url, method) => {
      if (url.pathname.endsWith("/hosts") && method === "GET") {
        return jsonResponse(200, { hosts: [] });
      }
      if (url.pathname.endsWith("/members") && method === "GET") {
        return jsonResponse(200, { viewer: { effectiveRole: "editor" } });
      }
      return undefined;
    };
    const { result } = mount(
      { "environment.status": () => environmentStatusFixture({
        principal: { kind: "team", teamName: "Team B" },
      }) },
      ["environment.status"],
    );

    await waitFor(() => expect(result.current).toMatchObject({
      environmentId: null,
      resolved: true,
    }));
  });

  it("keeps both host support gates and the status failure closed", async () => {
    const statusClient = buildEnvironmentClient({
      hostId: WINDOW_HOST,
      handlers: { "environment.status": () => environmentStatusFixture({}) },
    }).client;
    recordNegotiatedHostMethods(WINDOW_HOST, []);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = (props: { children: ReactNode }) => (
      <OwnEnvironmentAuthProvider binding={runtime.binding}>
        <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>
      </OwnEnvironmentAuthProvider>
    );
    const { result } = renderHook(
      () => useHostOwnEnvironment(statusClient, WINDOW_HOST, true),
      { wrapper },
    );

    await waitFor(() => expect(result.current).toMatchObject({
      environmentId: null,
      resolved: true,
    }));
    expect(transport.requests.filter((request) =>
      request.url.pathname.startsWith("/api/v3/environments"),
    )).toEqual([]);
  });

  it("does not resolve a failed status as an environment", async () => {
    const { result } = mount(
      { "environment.status": () => { throw new Error("status read failed"); } },
      ["environment.status"],
    );

    await waitFor(() => expect(result.current).toMatchObject({
      environmentId: null,
      resolved: true,
    }));
    expect(transport.requests.filter((request) =>
      request.url.pathname.startsWith("/api/v3/environments"),
    )).toEqual([]);
  });
});
