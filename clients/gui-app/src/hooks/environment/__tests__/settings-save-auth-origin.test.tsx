import "../../../../__tests__/test-browser-apis";
import { installAuthValidationFetch } from "../../../../__tests__/test-browser-apis";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { EnvironmentHostReadResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { ProvidersSetPackPolicyRequestV11 } from "@traycer/protocol/host/provider-schemas";
import type { SlackAppView } from "@traycer/protocol/host/slack-app";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { AuthService } from "@/lib/auth/auth-service";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import { HostRuntimeContext, type HostRuntimeBinding } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { SettingsSaveCoordinatorProvider } from "@/providers/settings-save-coordinator-provider";
import { useProvidersSetPackPolicy } from "@/hooks/providers/use-providers-set-pack-policy-mutation";
import { useBotSlackDisconnectMutation } from "@/hooks/bots/use-bot-slack-mutations";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { useBotSlackPendingInstallStore } from "@/stores/bots/bot-slack-pending-install-store";
import { settingsSaveMemoryKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useSettingsSaveMemoryStore,
  type SettingsSaveMemoryRecord,
} from "@/stores/settings/settings-save-memory-store";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const HOST_ID = "team-host";
const ENVIRONMENT_ID = "team-environment";
const USER_ID = "user-1";
const PACK_POLICY: ProvidersSetPackPolicyRequestV11 = {
  packId: "pack-a",
  autoDownload: false,
  policy: { pinnedVersion: "1.2.0", autoDownload: false },
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const TEAM_HOST_BINDING: EnvironmentHostReadResponseV11 = {
  hostId: HOST_ID,
  environment: {
    environmentId: ENVIRONMENT_ID,
    ownerKind: "organization",
    ownerId: "team-1",
    roomId: "team-room",
    label: "Team",
  },
  explicit: true,
  enrolledByUserId: USER_ID,
  canUnbind: true,
  sharingGeneration: 1,
};

const PACK_POLICY_ROW = {
  kind: "pack_policy",
  key: "pack-a",
  os: null,
  value: { pinnedVersion: "1.2.0", autoDownload: true },
  revision: 3,
  updatedAt: 1,
  writtenBy: { source: "user", hostId: null, hostName: null },
};

const SLACK_APP: SlackAppView = {
  botId: "bot-1",
  appId: "A123",
  clientId: "123.456",
  installState: "registered",
  teamId: null,
  teamName: null,
  botUserId: null,
  installedAt: null,
  dmsEnabled: true,
};

interface AuthSaveHarness {
  readonly auth: AuthService;
  readonly runnerHost: MockRunnerHost;
  readonly client: ReturnType<typeof buildEnvironmentClient>["client"];
  readonly queryClient: QueryClient;
  readonly authnRequests: EnvironmentTransportRequest[];
  readonly hostWrites: ProvidersSetPackPolicyRequestV11[];
  readonly recordsAtSend: (SettingsSaveMemoryRecord | null)[];
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly dispose: () => void;
}

const activeHarnesses: AuthSaveHarness[] = [];

function makeHarness(
  mutationGate: Promise<void> | null = null,
): AuthSaveHarness {
  window.localStorage.clear();
  useSettingsSaveMemoryStore.persist.setOptions({
    name: settingsSaveMemoryKey(null),
  });
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  useBotSlackPendingInstallStore.setState({ entries: {} });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  const restoreFetch = installAuthValidationFetch();
  const authnRequests: EnvironmentTransportRequest[] = [];
  const hostWrites: ProvidersSetPackPolicyRequestV11[] = [];
  const recordsAtSend: (SettingsSaveMemoryRecord | null)[] = [];
  const mutationCache = new MutationCache(
    mutationGate === null ? {} : { onMutate: () => mutationGate },
  );
  const queryClient = new QueryClient({
    mutationCache,
    defaultOptions: {
      queries: { retry: false, gcTime: 60_000 },
      mutations: { retry: false },
    },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.test/sign-in",
    authnBaseUrl: "https://authn.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  Object.defineProperty(runnerHost, "environmentTransport", {
    configurable: true,
    writable: true,
    value: async (
      request: EnvironmentTransportRequest,
    ): Promise<EnvironmentTransportAnswer> => {
      authnRequests.push(request);
      if (request.url.includes("/hosts?include=binding")) {
        return {
          status: 200,
          text: JSON.stringify({
            hosts: [
              {
                hostId: HOST_ID,
                sharingGeneration: 1,
                hostPlatform: "darwin-arm64",
              },
            ],
          }),
        };
      }
      if (request.url.includes("/items?kind=")) {
        return {
          status: 200,
          text: JSON.stringify({ items: [PACK_POLICY_ROW] }),
        };
      }
      if (request.url.includes("/review?include=operation")) {
        return {
          status: 200,
          text: JSON.stringify({ review: { hosts: [], needsYou: [] } }),
        };
      }
      return { status: 200, text: "{}" };
    },
  });
  const auth = new AuthService({ runnerHost });
  const directory = createAuthBoundHostDirectory({
    auth,
    runnerHost,
    remoteFetcher: null,
    localHostIdSeeder: () => Promise.resolve(null),
    onRegistryPollTick: null,
  });
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.status": () =>
        environmentStatusFixture({
          principal: { kind: "team", teamName: "Team" },
        }),
      "environment.host.read": () => TEAM_HOST_BINDING,
      "providers.setPackPolicy": (request) => {
        hostWrites.push(request);
        recordsAtSend.push(
          Object.values(useSettingsSaveMemoryStore.getState().records)[0] ??
            null,
        );
        return { autoDownload: request.autoDownload };
      },
    },
  });
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
    "environment.host.read": { major: 1, minor: 1 },
    "providers.setPackPolicy": { major: 1, minor: 1 },
  });
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "runtime-unused",
      handlers: {},
    }),
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    singleAttemptMessenger: null,
    authorityRegistry: null,
    requestCoordinator: null,
    selectedHostId: () => HOST_ID,
    connectionRegistry: null,
    onHostTokenRenewal: () => undefined,
  });
  const binding: HostRuntimeBinding<HostRpcRegistry> = {
    runtime,
    hostClient: client,
    directory,
    auth,
    hostId: HOST_ID,
  };
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <HostRuntimeContext.Provider value={binding}>
        <SettingsSaveCoordinatorProvider>
          {props.children}
        </SettingsSaveCoordinatorProvider>
      </HostRuntimeContext.Provider>
    </QueryClientProvider>
  );
  const harness: AuthSaveHarness = {
    auth,
    runnerHost,
    client,
    queryClient,
    authnRequests,
    hostWrites,
    recordsAtSend,
    wrapper,
    dispose: () => {
      runtime.dispose();
      directory.dispose();
      auth.dispose();
      queryClient.clear();
      restoreFetch();
    },
  };
  activeHarnesses.push(harness);
  return harness;
}

async function startAuth(harness: AuthSaveHarness): Promise<void> {
  await act(async () => harness.auth.start());
}

async function signIn(harness: AuthSaveHarness, token: string): Promise<void> {
  await act(async () => {
    await harness.auth.signIn();
    harness.runnerHost.deviceFlow.emitResult({
      kind: "authorized",
      token,
      refreshToken: `${token}-refresh`,
    });
    await vi.waitFor(() => {
      expect(harness.auth.getCurrentSessionSnapshot().token).toBe(token);
    });
  });
}

async function waitForSaveBaseReads(harness: AuthSaveHarness): Promise<void> {
  await waitFor(() => {
    expect(
      harness.authnRequests.some((request) =>
        request.url.includes("/hosts?include=binding"),
      ),
    ).toBe(true);
    expect(
      harness.authnRequests.some((request) =>
        request.url.includes("/items?kind=pack_policy"),
      ),
    ).toBe(true);
    expect(harness.queryClient.isFetching()).toBe(0);
  });
}

afterEach(() => {
  cleanup();
  for (const harness of activeHarnesses.splice(0)) harness.dispose();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  useBotSlackPendingInstallStore.setState({ entries: {} });
  window.localStorage.clear();
  resetNegotiatedManifests();
});

describe("settings save origin through the real AuthService", () => {
  it("sends a signed-out host write on a team-enrolled host without an account follow", async () => {
    const harness = makeHarness();
    await startAuth(harness);
    const binding = await harness.client.request("environment.host.read", {});
    expect(binding.environment.ownerKind).toBe("organization");
    expect(binding.enrolledByUserId).toBe(USER_ID);

    const mutation = renderHook(() => useProvidersSetPackPolicy(), {
      wrapper: harness.wrapper,
    });
    await act(async () => {
      await mutation.result.current.mutateAsync(PACK_POLICY);
    });

    expect(harness.hostWrites).toEqual([PACK_POLICY]);
    expect(harness.authnRequests).toEqual([]);
  });

  it("keeps a named configuration-row write behind sign-in", async () => {
    const harness = makeHarness();
    await startAuth(harness);
    const mutations = renderHook(() => useConfigurationItemMutations(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await expect(
        mutations.result.current.put.mutateAsync({
          environmentId: ENVIRONMENT_ID,
          kind: "pack_policy",
          key: "pack-a",
          os: null,
          value: { pinnedVersion: "1.2.0", autoDownload: false },
          revision: 3,
        }),
      ).rejects.toBeDefined();
    });

    expect(harness.authnRequests).toEqual([]);
    expect(harness.hostWrites).toEqual([]);
  });

  it("runs a void Slack disconnect and ends its real install wait", async () => {
    const harness = makeHarness();
    await startAuth(harness);
    await signIn(harness, "account-token-a");
    const disconnect = vi
      .spyOn(harness.runnerHost, "disconnectSlackApp")
      .mockResolvedValue({ kind: "ok", app: SLACK_APP });
    useBotSlackPendingInstallStore.setState({
      entries: {
        [SLACK_APP.botId]: {
          botId: SLACK_APP.botId,
          expiresAt: 1,
          baselineInstalledAt: null,
        },
      },
    });
    const mutation = renderHook(
      () => useBotSlackDisconnectMutation(SLACK_APP.botId),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await mutation.result.current.mutateAsync();
    });

    expect(disconnect).toHaveBeenCalledOnce();
    expect(
      useBotSlackPendingInstallStore.getState().entries[SLACK_APP.botId],
    ).toBeUndefined();
  });

  it("keeps each same-input press on the sign-in state it captured before send", async () => {
    const gate = deferred<void>();
    const harness = makeHarness(gate.promise);
    await startAuth(harness);
    const mutation = renderHook(() => useProvidersSetPackPolicy(), {
      wrapper: harness.wrapper,
    });
    let signedOutPress: Promise<{ autoDownload: boolean }> | undefined;
    act(() => {
      signedOutPress = mutation.result.current.mutateAsync(PACK_POLICY);
    });

    await signIn(harness, "account-token-a");
    await waitForSaveBaseReads(harness);
    let signedInPress: Promise<{ autoDownload: boolean }> | undefined;
    act(() => {
      signedInPress = mutation.result.current.mutateAsync(PACK_POLICY);
    });
    const readsBeforeSend = harness.authnRequests.length;
    gate.resolve(undefined);
    if (signedOutPress === undefined || signedInPress === undefined) {
      throw new Error("The saves did not start");
    }
    await act(async () => {
      await expect(
        Promise.all([signedOutPress, signedInPress]),
      ).resolves.toEqual([{ autoDownload: false }, { autoDownload: false }]);
    });

    expect(harness.hostWrites).toEqual([PACK_POLICY, PACK_POLICY]);
    expect(harness.recordsAtSend[0]).toBeNull();
    expect(harness.recordsAtSend[1]).toMatchObject({
      kind: "pack_policy",
      key: "pack-a",
      operation: "put",
    });
    expect(harness.authnRequests).toHaveLength(readsBeforeSend);
  });

  it("abandons an active press after the same account signs in again", async () => {
    const gate = deferred<void>();
    const harness = makeHarness(gate.promise);
    await startAuth(harness);
    await signIn(harness, "account-token-a");
    const signedInUserId =
      harness.auth.getCurrentSessionSnapshot().profile?.userId;
    expect(signedInUserId).toBe(USER_ID);
    const mutation = renderHook(() => useProvidersSetPackPolicy(), {
      wrapper: harness.wrapper,
    });
    await waitForSaveBaseReads(harness);
    let pendingSave: Promise<{ autoDownload: boolean }> | undefined;
    act(() => {
      pendingSave = mutation.result.current.mutateAsync(PACK_POLICY);
    });

    await act(async () => harness.auth.signOut());
    await signIn(harness, "account-token-b");
    expect(harness.auth.getCurrentSessionSnapshot().profile?.userId).toBe(
      signedInUserId,
    );
    await waitForSaveBaseReads(harness);
    gate.resolve(undefined);
    if (pendingSave === undefined) throw new Error("The save did not start");
    await act(async () => {
      await expect(pendingSave).rejects.toMatchObject({
        method: "providers.setPackPolicy",
        mayHaveDispatched: false,
      });
    });

    expect(harness.hostWrites).toEqual([]);
    expect(
      harness.authnRequests.some((request) => request.url.includes("/review")),
    ).toBe(false);
    expect(
      Object.values(useSettingsSaveMemoryStore.getState().records),
    ).toEqual([]);
  });
});
