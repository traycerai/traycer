import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { HostOwnershipResult } from "@traycer-clients/shared/host-client/host-ownership";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type { AuthEra } from "@traycer-clients/shared/auth/request-context-provider";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { AuthService } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcRegistry } from "@/lib/host";
import { HostRuntimeContext } from "@/lib/host/runtime";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { authQueryKeys } from "@/lib/query-keys";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useLandingOwner } from "@/hooks/home/use-landing-owner";
import { LandingTeamChatLine } from "@/components/home/composer/landing-team-chat-line";
import { useAuthStore } from "@/stores/auth/auth-store";

const USER_ID = "user-me";
const LOCAL_HOST_ID = "owner-local-host";
const REMOTE_HOST_ID = "owner-remote-host";
const AUTH_ERA: AuthEra = { identity: USER_ID, credentialGeneration: 1 };

const LOCAL_SNAPSHOT: LocalHostSnapshot = {
  hostId: LOCAL_HOST_ID,
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "local-test-host",
  displayName: "Local Test Host",
  availability: "available",
};

const TEAM_OWNER: HostOwnerPrincipal = {
  kind: "team",
  id: "team-acme",
  name: "Acme",
};
const OTHER_TEAM_OWNER: HostOwnerPrincipal = {
  kind: "team",
  id: "team-beta",
  name: "Beta",
};
const USER_OWNER: HostOwnerPrincipal = { kind: "user", id: USER_ID };

const ACME = { teamId: "team-acme", slug: "acme", avatarUrl: null };
const BETA = { teamId: "team-beta", slug: "beta", avatarUrl: null };

interface MutableOwner {
  current: HostOwnerPrincipal;
}

interface OwnerHarness {
  readonly auth: AuthService;
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
  readonly directory: HostDirectoryService;
  readonly ownershipReads: Array<{
    readonly hostId: string;
    readonly era: AuthEra;
  }>;
  readonly queryClient: QueryClient;
  readonly runnerHost: MockRunnerHost;
  readonly runtime: HostRuntime<HostRpcRegistry>;
}

const harnesses: OwnerHarness[] = [];

function ownerResult(
  hostId: string,
  owner: HostOwnerPrincipal,
): HostOwnershipResult {
  return {
    kind: "ok",
    host: { hostId, owner, kind: "personal", remoteAccess: false },
  };
}

function teamRemoteEntry(): RemoteHostDirectoryEntry {
  return {
    ...remoteEntry(REMOTE_HOST_ID, null),
    owner: TEAM_OWNER,
  };
}

async function createOwnerHarness(input: {
  readonly owner: MutableOwner;
  readonly remoteEntries: readonly HostDirectoryEntry[];
}): Promise<OwnerHarness> {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: LOCAL_SNAPSHOT,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const auth = new AuthService({ runnerHost });
  vi.spyOn(auth, "currentAuthEra").mockReturnValue(AUTH_ERA);
  const ownershipReads: Array<{
    readonly hostId: string;
    readonly era: AuthEra;
  }> = [];
  vi.spyOn(auth, "readHostOwnership").mockImplementation((hostId, era) => {
    ownershipReads.push({ hostId, era });
    return Promise.resolve(ownerResult(hostId, input.owner.current));
  });

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: () =>
      Promise.resolve({ kind: "hosts", entries: [...input.remoteEntries] }),
    onRegistryPollTick: null,
    authContextId: () => USER_ID,
    credentialGeneration: () => AUTH_ERA.credentialGeneration,
    localHostIdSeeder: () => Promise.resolve(LOCAL_HOST_ID),
  });
  await directory.start();

  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-landing-owner",
      handlers: {},
    }),
    requestContextProvider: new DefaultRequestContextProvider({
      origin: "renderer",
    }),
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    selectedHostId: () => LOCAL_HOST_ID,
    connectionRegistry: {
      directory: {
        findById: (hostId) => directory.findById(hostId),
        onDirectoryChanged: (listener) => directory.onChange(listener),
      },
      leases: null,
    },
  });
  runtime.start();

  const binding: HostRuntimeBinding<HostRpcRegistry> = {
    runtime,
    hostClient: runtime.hostClient,
    directory,
    auth,
    hostId: LOCAL_HOST_ID,
  };
  const harness = {
    auth,
    binding,
    directory,
    ownershipReads,
    queryClient,
    runnerHost,
    runtime,
  };
  harnesses.push(harness);
  return harness;
}

function LandingOwnerLine(props: { readonly hostId: string }) {
  return <LandingTeamChatLine owner={useLandingOwner(props.hostId)} />;
}

function renderLandingOwnerLine(harness: OwnerHarness, hostId: string) {
  return render(<LandingOwnerLine hostId={hostId} />, {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <RunnerHostProvider runnerHost={harness.runnerHost}>
        <QueryClientProvider client={harness.queryClient}>
          <HostRuntimeContext.Provider value={harness.binding}>
            {children}
          </HostRuntimeContext.Provider>
        </QueryClientProvider>
      </RunnerHostProvider>
    ),
  });
}

async function waitForLocalOwnershipQuery(
  harness: OwnerHarness,
): Promise<void> {
  await waitFor(() => {
    expect(harness.ownershipReads).toContainEqual({
      hostId: LOCAL_HOST_ID,
      era: AUTH_ERA,
    });
    expect(
      harness.queryClient.getQueryState(
        authQueryKeys.hostOwnership(harness.auth, USER_ID, LOCAL_HOST_ID),
      )?.status,
    ).toBe("success");
  });
}

beforeEach(() => {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: USER_ID, username: USER_ID },
    shareableTeams: [ACME, BETA],
  });
});

afterEach(() => {
  cleanup();
  for (const harness of harnesses.splice(0)) {
    harness.runtime.dispose();
    harness.directory.dispose();
    harness.auth.dispose();
    harness.queryClient.clear();
  }
  useAuthStore.setState({
    status: "signed-out",
    contextMetadata: null,
    shareableTeams: [],
  });
  vi.restoreAllMocks();
});

describe("landing team line uses the resolved host owner", () => {
  it("reads local ownership even while Remote access is off", async () => {
    const harness = await createOwnerHarness({
      owner: { current: TEAM_OWNER },
      remoteEntries: [],
    });
    renderLandingOwnerLine(harness, LOCAL_HOST_ID);

    expect(harness.directory.findById(LOCAL_HOST_ID)?.kind).toBe("local");
    expect(
      await screen.findByText("Chats here are visible to everyone in acme"),
    ).toBeTruthy();
    await waitForLocalOwnershipQuery(harness);
  });

  it("does not show a team line for a local host owned by the signed-in user", async () => {
    const harness = await createOwnerHarness({
      owner: { current: USER_OWNER },
      remoteEntries: [],
    });
    renderLandingOwnerLine(harness, LOCAL_HOST_ID);

    await waitForLocalOwnershipQuery(harness);
    expect(screen.queryByTestId("landing-team-first-chat-line")).toBeNull();
  });

  it("keeps using trusted directory ownership for a remote team host", async () => {
    const harness = await createOwnerHarness({
      owner: { current: USER_OWNER },
      remoteEntries: [teamRemoteEntry()],
    });
    renderLandingOwnerLine(harness, REMOTE_HOST_ID);

    expect(
      await screen.findByText("Chats here are visible to everyone in acme"),
    ).toBeTruthy();
    expect(harness.ownershipReads).toEqual([]);
  });

  it("updates and removes local ownership on ownership query refresh without changing the endpoint", async () => {
    const owner: MutableOwner = { current: TEAM_OWNER };
    const harness = await createOwnerHarness({ owner, remoteEntries: [] });
    renderLandingOwnerLine(harness, LOCAL_HOST_ID);
    const endpoint = harness.directory.findById(LOCAL_HOST_ID)?.websocketUrl;

    expect(
      await screen.findByText("Chats here are visible to everyone in acme"),
    ).toBeTruthy();
    await waitForLocalOwnershipQuery(harness);

    owner.current = OTHER_TEAM_OWNER;
    await harness.queryClient.invalidateQueries({
      queryKey: authQueryKeys.hostOwnership(
        harness.auth,
        USER_ID,
        LOCAL_HOST_ID,
      ),
    });
    expect(
      await screen.findByText("Chats here are visible to everyone in beta"),
    ).toBeTruthy();

    owner.current = USER_OWNER;
    await harness.queryClient.invalidateQueries({
      queryKey: authQueryKeys.hostOwnership(
        harness.auth,
        USER_ID,
        LOCAL_HOST_ID,
      ),
    });
    await waitFor(() =>
      expect(screen.queryByTestId("landing-team-first-chat-line")).toBeNull(),
    );
    expect(harness.directory.findById(LOCAL_HOST_ID)?.kind).toBe("local");
    expect(harness.directory.findById(LOCAL_HOST_ID)?.websocketUrl).toBe(
      endpoint,
    );
  });
});
