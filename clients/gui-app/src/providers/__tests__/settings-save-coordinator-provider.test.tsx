import { NO_SERVING_PEER_DECISION } from "@traycer-clients/shared/host-client/host-rpc-routing";
import "../../../__tests__/test-browser-apis";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import {
  canonicalSettingValue,
  type SettingsSaveMapping,
} from "@traycer/protocol/host/environment/settings-save-mapping";
import {
  buildEnvironmentClient,
  hostEntryFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { AuthService } from "@/lib/auth/auth-service";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import { HostRuntimeContext } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type {
  SettingsSaveContext,
  SettingsSaveCoordinator,
} from "@/lib/environment/settings-save-coordinator";
import { settingsSaveMemoryKey } from "@/lib/persist";
import { SettingsSaveCoordinatorProvider } from "@/providers/settings-save-coordinator-provider";
import { useSettingsSaveCoordinator } from "@/providers/settings-save-coordinator-context";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsSaveMemoryStore } from "@/stores/settings/settings-save-memory-store";
import { QueryClient } from "@tanstack/react-query";

const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const ENVIRONMENT_ID = "environment-a";
const HOST_ID = "host-a";
const SHARING_GENERATION = 3;
const START_MS = 1_000_000;
const SECOND = 1_000;

const VARIABLE_VALUE = { value: "https://api.example" };
const VARIABLE_PUT: SettingsSaveMapping = {
  kind: "proposal",
  edit: {
    kind: "variable",
    key: "API_URL",
    os: "linux",
    operation: "put",
    value: VARIABLE_VALUE,
    canonicalValue: canonicalSettingValue(VARIABLE_VALUE),
  },
};

function contextFor(accountId: string): SettingsSaveContext {
  return {
    accountId,
    environmentId: ENVIRONMENT_ID,
    hostId: HOST_ID,
    sharingGeneration: SHARING_GENERATION,
    expectedLiveRevision: 7,
  };
}

function setAccount(userId: string): void {
  useAuthStore.setState({
    ...useAuthStore.getInitialState(),
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.test` },
    contextMetadata: { userId, username: userId },
  });
}

/** The cloud a settled hold would be applied through; no test here gets that far. */
const CLOUD: EnvironmentCloud = {
  authnBaseUrl: "https://authn.test/",
  bearer: { kind: "cloud", getBearerToken: () => "test-token" },
  onOriginSignIn: () => true,
  transport: () => Promise.reject(new Error("no hold is applied here")),
};

interface BindingHarness {
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
  /** The memory each `environment.proposals` read found installed. */
  readonly proposalReads: string[];
  /** The directory row of this window's own host, in place of the notified path. */
  readonly hosts: Map<string, HostDirectoryEntry>;
  readonly dispose: () => void;
}

/**
 * A binding whose local host answers `environment.proposals` with nothing
 * listed. A binding that starts `connected: false` has a row without an
 * address, so the reconcile effect sees no connection until the row is put
 * back without a notification.
 */
function makeBindingHarness(connected: boolean): BindingHarness {
  const proposalReads: string[] = [];
  const { client, hosts } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.proposals": () => {
        proposalReads.push(
          useSettingsSaveMemoryStore.persist.getOptions().name ?? "",
        );
        return { proposals: [] };
      },
    },
  });
  if (!connected) {
    hosts.set(HOST_ID, { ...hostEntryFixture(HOST_ID), websocketUrl: null });
  }
  const queryClient = new QueryClient();
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.test/sign-in",
    authnBaseUrl: "https://authn.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const authService = new AuthService({ runnerHost });
  const auth = Object.assign(authService, { environmentCloud: () => CLOUD });
  const directoryService = createAuthBoundHostDirectory({
    auth: authService,
    runnerHost,
    remoteFetcher: null,
    localHostIdSeeder: () => Promise.resolve(HOST_ID),
    onRegistryPollTick: null,
  });
  const directory = Object.assign(directoryService, {
    getLocalHostId: () => HOST_ID,
  });
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "provider-test-unused",
      handlers: {},
    }),
    singleAttemptMessenger: null,
    requestContextProvider: authService.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    selectedHostId: () => HOST_ID,
    servingDecision: () => NO_SERVING_PEER_DECISION,
    connectionRegistry: null,
    onHostTokenRenewal: () => undefined,
  });
  return {
    binding: {
      runtime,
      hostClient: client,
      directory,
      auth,
      hostId: HOST_ID,
    },
    proposalReads,
    hosts,
    dispose: () => {
      runtime.dispose();
      directory.dispose();
      authService.dispose();
      queryClient.clear();
    },
  };
}

const harnesses: BindingHarness[] = [];

function bindingHarness(connected: boolean): BindingHarness {
  const harness = makeBindingHarness(connected);
  harnesses.push(harness);
  return harness;
}

/** What a test reads of the provider's coordinator, the way a hook's scope holds it. */
interface CoordinatorProbe {
  readonly capture: (coordinator: SettingsSaveCoordinator | null) => void;
  readonly held: () => SettingsSaveCoordinator;
}

function coordinatorProbe(): CoordinatorProbe {
  let current: SettingsSaveCoordinator | null = null;
  return {
    capture: (coordinator) => {
      current = coordinator;
    },
    held: () => {
      if (current === null) throw new Error("No coordinator in context");
      return current;
    },
  };
}

function Probe(props: { readonly probe: CoordinatorProbe }): ReactNode {
  const coordinator = useSettingsSaveCoordinator();
  const { probe } = props;
  useEffect(() => {
    probe.capture(coordinator);
  }, [coordinator, probe]);
  return null;
}

function tree(
  binding: HostRuntimeBinding<HostRpcRegistry>,
  probe: CoordinatorProbe,
): ReactNode {
  return (
    <HostRuntimeContext.Provider value={binding}>
      <SettingsSaveCoordinatorProvider>
        <Probe probe={probe} />
      </SettingsSaveCoordinatorProvider>
    </HostRuntimeContext.Provider>
  );
}

async function rememberSave(
  coordinator: SettingsSaveCoordinator,
  accountId: string,
) {
  const beginning = await coordinator.begin(
    VARIABLE_PUT,
    contextFor(accountId),
    () => undefined,
  );
  if (beginning.kind !== "remembered") {
    throw new Error(`Expected a remembered save, got ${beginning.kind}`);
  }
  return beginning.ticket;
}

/** The bridge retargets the memory as the account changes; its rehydrate settles on the clock. */
async function memoryOf(accountId: string): Promise<void> {
  expect(useSettingsSaveMemoryStore.persist.getOptions().name).toBe(
    settingsSaveMemoryKey(accountId),
  );
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  window.localStorage.clear();
  useSettingsSaveMemoryStore.persist.setOptions({
    name: settingsSaveMemoryKey(null),
  });
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  setAccount(ACCOUNT_A);
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.proposals": { major: 1, minor: 0 },
  });
  vi.useFakeTimers({ now: START_MS });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const harness of harnesses.splice(0)) harness.dispose();
  resetNegotiatedManifests();
  useSettingsSaveMemoryStore.persist.clearStorage();
  useSettingsSaveMemoryStore.setState({ records: {}, inFlight: {} });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  window.localStorage.clear();
});

describe("SettingsSaveCoordinatorProvider", () => {
  it("follows up a save, left unanswered, that began before a new binding through the new binding", async () => {
    const first = bindingHarness(false);
    const second = bindingHarness(false);
    const probe = coordinatorProbe();
    const view = render(tree(first.binding, probe));
    await memoryOf(ACCOUNT_A);
    const coordinator = probe.held();
    const ticket = await rememberSave(coordinator, ACCOUNT_A);

    view.rerender(tree(second.binding, probe));
    // Put back without a notification: no reconcile effect runs for it, so
    // only the follow-up the held coordinator arms can read it.
    second.hosts.set(HOST_ID, hostEntryFixture(HOST_ID));
    await coordinator.settle(ticket, false);
    await vi.advanceTimersByTimeAsync(2 * SECOND);

    expect(second.proposalReads).toHaveLength(1);
    expect(first.proposalReads).toEqual([]);
  });

  it("reads a host again once the signed-in account changes to one with its own save on that host", async () => {
    const harness = bindingHarness(true);
    const probe = coordinatorProbe();
    render(tree(harness.binding, probe));
    await memoryOf(ACCOUNT_A);
    const coordinator = probe.held();

    act(() => setAccount(ACCOUNT_B));
    await memoryOf(ACCOUNT_B);
    await rememberSave(coordinator, ACCOUNT_B);
    act(() => setAccount(ACCOUNT_A));
    await memoryOf(ACCOUNT_A);
    await rememberSave(coordinator, ACCOUNT_A);
    await vi.advanceTimersByTimeAsync(0);
    const readsBefore = harness.proposalReads.length;

    act(() => setAccount(ACCOUNT_B));
    await memoryOf(ACCOUNT_B);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.proposalReads.length).toBeGreaterThan(readsBefore);
    expect(harness.proposalReads.at(-1)).toBe(settingsSaveMemoryKey(ACCOUNT_B));
  });
});
