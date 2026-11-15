import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { AuthEra } from "@traycer-clients/shared/auth/request-context-provider";
import type { HostOwnershipResult } from "@traycer-clients/shared/host-client/host-ownership";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostCredentialState } from "@traycer/protocol/framework/stream-ws-protocol";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { WsStreamClientOptions } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";

const TEAM_OWNER: HostOwnerPrincipal = {
  kind: "team",
  id: "team-1",
  name: "Acme",
};
const WARNING = "This computer can't work for the team right now.";

const mocks = vi.hoisted(() => ({
  observer: null as
    | ((hostId: string, state: HostCredentialState) => void)
    | null,
  auth: {
    currentAuthEra: vi.fn<() => AuthEra>(),
    readHostOwnership:
      vi.fn<(hostId: string, era: AuthEra) => Promise<HostOwnershipResult>>(),
  },
  refreshDirectory: vi.fn<() => Promise<unknown>>(),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/ws-stream-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/ws-stream-client")
      >();
    return {
      ...actual,
      WsStreamClient: class {
        constructor(options: WsStreamClientOptions<HostStreamRpcRegistry>) {
          mocks.observer = options.onHostCredentialState;
        }
      },
    };
  },
);

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => ({
      auth: mocks.auth,
      directory: { refresh: mocks.refreshDirectory },
    }),
  };
});

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => ({
    kind: "binding",
    query: { isError: false, data: undefined },
  }),
}));
vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => ({ data: null }),
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: () => new Map(),
}));

import { HostEnvironmentSection } from "@/components/settings/panels/host-environment-section";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHostCredentialStatusStore } from "@/stores/host/host-credential-status-store";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { inertHostTokenSource } from "../../../../../__tests__/create-fake-runner-host";

function ownershipResult(): HostOwnershipResult {
  return {
    kind: "ok",
    host: {
      hostId: mockLocalHostEntry.hostId,
      owner: TEAM_OWNER,
      kind: "personal",
      remoteAccess: false,
    },
  };
}

function makeClient(): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

function reportThroughBuiltStream(state: HostCredentialState): void {
  const client = buildHostStreamClient({
    target: mockLocalHostEntry,
    userId: "user-me",
    endpoint: () => null,
    bearer: () => null,
    cloudAuthorized: () => false,
    authnBaseUrl: "http://localhost:5005",
    auth: null,
    hostTokens: inertHostTokenSource(),
    proactiveWakeEligible: false,
    autoStart: false,
  });
  expect(client).not.toBeNull();
  const observer = mocks.observer;
  if (observer === null) throw new Error("stream observer was not configured");
  act(() => observer(mockLocalHostEntry.hostId, state));
}

function renderSection(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HostEnvironmentSection
        hostName="Mac mini"
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({
            hostId: mockLocalHostEntry.hostId,
            name: "Mac mini",
            isLocalMachine: true,
          }),
          client: makeClient(),
        })}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.observer = null;
  mocks.auth.currentAuthEra.mockReset();
  mocks.auth.currentAuthEra.mockReturnValue({
    identity: "user-me",
    credentialGeneration: 1,
  });
  mocks.auth.readHostOwnership.mockReset();
  mocks.auth.readHostOwnership.mockResolvedValue(ownershipResult());
  mocks.refreshDirectory.mockReset();
  mocks.refreshDirectory.mockResolvedValue(undefined);
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "user-me", userName: "Me", email: "me@example.com" },
    contextMetadata: { userId: "user-me", username: "me" },
    shareableTeams: [],
    subscriptionStatus: null,
  });
  useHostCredentialStatusStore.setState({ reports: {} });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  });
  useHostCredentialStatusStore.setState({ reports: {} });
});

describe("HostEnvironmentSection stream credential warning", () => {
  it.each([
    ["team-unavailable", true],
    ["missing", false],
    ["active", false],
    ["needs-reauth", false],
  ] as const)("shows the warning only for %s", async (state, visible) => {
    reportThroughBuiltStream(state);
    renderSection();
    await waitFor(() => {
      expect(mocks.auth.readHostOwnership).toHaveBeenCalledWith(
        mockLocalHostEntry.hostId,
        { identity: "user-me", credentialGeneration: 1 },
      );
    });

    if (visible) {
      expect(await screen.findByText(WARNING, { exact: true })).toBeTruthy();
      return;
    }
    expect(screen.queryByText(WARNING, { exact: true })).toBeNull();
  });
});
