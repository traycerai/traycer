import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  Profiler,
  useState,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { Toaster, toast } from "sonner";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostEntryFixture } from "@/lib/environment/__tests__/environment-test-support";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  hostRpcSchedulingPolicy,
  stampHostRpcMethod,
} from "@/lib/host-rpc-policy/host-method-policy-table";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import { StopSharingSession } from "@/components/settings/move/stop-sharing-session";
import { AddProviderProfileDialog } from "@/components/settings/panels/add-provider-profile-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  EnvironmentMovePersonalProfile,
  EnvironmentMoveStopPreviewResponseV14,
  EnvironmentMoveStopResponseV11,
} from "@traycer/protocol/host/environment/move-contracts";
import {
  buildConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/capability-manifest";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import type {
  HostRequestOptions,
  IHostMessenger,
  RequiredHostMethodVersion,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { RemoteHostMessenger } from "@traycer-clients/shared/host-transport/remote/remote-host-messenger";
import { RemoteSession } from "@traycer-clients/shared/host-transport/remote/remote-session";
import {
  emptyStreamRegistry,
  FakeRelayHost,
} from "@traycer-clients/shared/host-transport/remote/__tests__/fake-relay-host";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  pinProfile,
  providerState,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import type {
  ProviderLoginProfileOutcome,
  ProviderLoginTarget,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  differentAccountText,
  profileNotChangedText,
  SIGN_IN_UNPROVEN_TEXT,
} from "@/components/providers/profile-sync-copy";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { AuthService } from "@/lib/auth/auth-service";
import { unavailableSignInRequestAuthService } from "@/lib/auth/__tests__/provider-sign-in-request-test-support";
import {
  environmentMutationKeys,
  hostQueryKeys,
  providersMutationKeys,
} from "@/lib/query-keys";

let authServiceForTest: AuthService | null = null;

function currentAuthService(): AuthService {
  if (authServiceForTest === null) {
    throw new Error("sign-in request AuthService was not set up");
  }
  return authServiceForTest;
}

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useAuthService: currentAuthService };
});
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useAuthService: currentAuthService };
});

const HOST_ID = "leave-remote-test-host";
type HostMethod = keyof HostRpcRegistry & string;
type HostVersion = { readonly major: number; readonly minor: number };
const FOLDER = (
  profileId: string,
  label: string,
  signIn: EnvironmentMovePersonalProfile["signIn"],
): EnvironmentMovePersonalProfile => folder("codex", profileId, label, signIn);

const folder = (
  providerId: EnvironmentMovePersonalProfile["providerId"],
  profileId: string,
  label: string,
  signIn: EnvironmentMovePersonalProfile["signIn"],
): EnvironmentMovePersonalProfile => ({
  providerId,
  profileId,
  label,
  signIn,
  shared: false,
});

const SHARED_FOLDER = (
  profileId: string,
  label: string,
): EnvironmentMovePersonalProfile => ({
  ...FOLDER(profileId, label, "offered"),
  shared: true,
});

const GUIDANCE =
  "Sign in to each account you want to keep using on this computer, or skip it.";
const SKIPPED_SHARED = "Skipped. Not kept on this computer.";
const CUT_GUIDANCE_SENTENCE = "A skipped account keeps working until";

function guidanceParagraphs(): string[] {
  return Array.from(
    screen.getByTestId("personal-leave-accounts").querySelectorAll("p"),
  )
    .map((paragraph) => paragraph.textContent)
    .filter((text) => text.startsWith("Sign in to each account"));
}

function stopRequests(harness: RemoteHarness): unknown[] {
  return harness.relay.unaryRequests
    .filter((request) => request.method === "environment.move.stop")
    .map((request) => request.params);
}

type ProvidersList = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type StartLogin = ResponseOfMethod<HostRpcRegistry, "providers.startLogin">;
type AwaitLogin = ResponseOfMethod<HostRpcRegistry, "providers.awaitLogin">;
type HostResponse = {
  readonly result: unknown;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly holders: unknown;
  } | null;
};

type CapturedHostRequest = {
  readonly method: HostMethod;
  readonly params: unknown;
  readonly requiredHostMethodVersion: RequiredHostMethodVersion | null;
};

interface RemoteHarness {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly relay: FakeRelayHost;
  readonly session: RemoteSession<HostRpcRegistry, typeof emptyStreamRegistry>;
  readonly capturedFloorRequirements: (RequiredHostMethodVersion | null)[];
  readonly capturedFloorErrors: unknown[];
  readonly capturedFloorCalls: {
    readonly method: HostMethod;
    readonly params: unknown;
  }[];
  readonly observedHostRequests: CapturedHostRequest[];
  subscribeRequests(
    listener: (request: CapturedHostRequest) => void,
  ): () => void;
  subscribeFloorErrors(listener: () => void): () => void;
  armFloorDowngrade(method: HostMethod, version: HostVersion): void;
  close(): void;
}

const harnesses: RemoteHarness[] = [];
const extraQueryClients: QueryClient[] = [];

beforeEach(() => {
  authServiceForTest = unavailableSignInRequestAuthService();
});

afterEach(() => {
  cleanup();
  for (const harness of harnesses.splice(0)) harness.close();
  for (const queryClient of extraQueryClients.splice(0)) queryClient.clear();
  authServiceForTest?.dispose();
  authServiceForTest = null;
  toast.dismiss();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetNegotiatedManifests();
});

function fullHostManifest(): Record<string, { major: number; minor: number }> {
  const manifest = buildConnectionManifest(
    hostRpcRegistry,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  // Preserve the previous released Stop pair for existing compatibility cases.
  return Object.fromEntries(
    Object.entries(manifest).map(([method, version]) => {
      if (method === "environment.move.stopPreview")
        return [method, { major: 1, minor: 3 }];
      if (method === "environment.move.stop")
        return [method, { major: 1, minor: 2 }];
      return [method, { major: version.major, minor: version.minor }];
    }),
  );
}

const releasedFloorMethods = new Set(RELEASED_FLOOR_METHOD_NAMES);

function advertiseFullHostManifest(relay: FakeRelayHost): void {
  const manifest = fullHostManifest();
  relay.floorRpcManifest = Object.fromEntries(
    Object.entries(manifest).filter(([method]) =>
      releasedFloorMethods.has(method),
    ),
  );
  relay.optionalRpcManifest = Object.fromEntries(
    Object.entries(manifest).filter(
      ([method]) => !releasedFloorMethods.has(method),
    ),
  );
}

function setAdvertisedMethodVersion(
  relay: FakeRelayHost,
  method: string,
  version: { readonly major: number; readonly minor: number },
): void {
  if (releasedFloorMethods.has(method)) {
    relay.floorRpcManifest = { ...relay.floorRpcManifest, [method]: version };
  } else {
    relay.optionalRpcManifest = {
      ...relay.optionalRpcManifest,
      [method]: version,
    };
  }
}

function advertiseSheetDigestStopPair(relay: FakeRelayHost): void {
  setAdvertisedMethodVersion(relay, "environment.move.stopPreview", {
    major: 1,
    minor: 4,
  });
  setAdvertisedMethodVersion(relay, "environment.move.stop", {
    major: 1,
    minor: 3,
  });
}

function makeHarness(
  answer: (request: {
    readonly method: string;
    readonly params: unknown;
  }) => HostResponse,
): RemoteHarness {
  const relay = new FakeRelayHost();
  advertiseFullHostManifest(relay);
  relay.unaryResponseFor = answer;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const lease = new MutableBearerLease("test-bearer", "test-user");
  let nextRequestId = 0;
  const session = new RemoteSession({
    hostId: HOST_ID,
    attachBaseUrl: "wss://relay.test/attach",
    hostStaticPublicKey: relay.hostStaticPublicKey,
    grantProvider: () =>
      Promise.resolve({
        kind: "ok" as const,
        grant: { grant: "test-grant", expiresInSeconds: 300 },
      }),
    hostToken: () => {
      try {
        return lease.getBearerToken();
      } catch {
        return null;
      }
    },
    auth: null,
    door: null,
    clock: null,
    rpcRegistry: hostRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `leave-${String((nextRequestId += 1))}`,
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
    livenessProbe: null,
  });
  const remoteMessenger = new RemoteHostMessenger<
    HostRpcRegistry,
    typeof emptyStreamRegistry
  >(session);
  let armedFloorDowngrade: {
    readonly method: HostMethod;
    readonly version: HostVersion;
  } | null = null;
  const capturedFloorRequirements: (RequiredHostMethodVersion | null)[] = [];
  const capturedFloorErrors: unknown[] = [];
  const capturedFloorCalls: {
    readonly method: HostMethod;
    readonly params: unknown;
  }[] = [];
  const observedHostRequests: CapturedHostRequest[] = [];
  const requestListeners = new Set<(request: CapturedHostRequest) => void>();
  const floorErrorListeners = new Set<() => void>();
  const recordRequest = (request: CapturedHostRequest): void => {
    observedHostRequests.push(request);
    for (const listener of requestListeners) listener(request);
  };
  let reconnectAfterFloorDowngrade: Promise<void> | null = null;
  const applyFloorDowngrade = (
    method: HostMethod,
    params: unknown,
    options: HostRequestOptions,
  ): boolean => {
    const downgrade = armedFloorDowngrade;
    if (downgrade === null || downgrade.method !== method) return false;
    armedFloorDowngrade = null;
    capturedFloorRequirements.push(options.requiredHostMethodVersion);
    capturedFloorCalls.push({ method, params });
    setAdvertisedMethodVersion(relay, method, downgrade.version);
    reconnectAfterFloorDowngrade = nextAvailabilityRecovered(session);
    relay.dropCurrentConnection();
    return true;
  };
  const messenger: IHostMessenger<HostRpcRegistry> = {
    async request<Method extends HostMethod>(
      method: Method,
      params: RequestOfMethod<HostRpcRegistry, Method>,
      options: HostRequestOptions,
    ): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
      recordRequest({
        method,
        params,
        requiredHostMethodVersion: options.requiredHostMethodVersion,
      });
      const downgraded = applyFloorDowngrade(method, params, options);
      if (downgraded) {
        if (reconnectAfterFloorDowngrade === null)
          throw new Error("expected the floor downgrade reconnect");
        await reconnectAfterFloorDowngrade;
        expect(relay.openBearers).toHaveLength(2);
        expect(session.isReady()).toBe(true);
      }
      try {
        return await remoteMessenger.request(method, params, options);
      } catch (error: unknown) {
        if (downgraded) {
          capturedFloorErrors.push(error);
          for (const listener of floorErrorListeners) listener();
        }
        throw error;
      }
    },
    async requestWithResponseTimeout<Method extends HostMethod>(
      method: Method,
      params: RequestOfMethod<HostRpcRegistry, Method>,
      responseTimeoutMs: number,
      options: HostRequestOptions,
    ): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
      recordRequest({
        method,
        params,
        requiredHostMethodVersion: options.requiredHostMethodVersion,
      });
      const downgraded = applyFloorDowngrade(method, params, options);
      if (downgraded) {
        if (reconnectAfterFloorDowngrade === null)
          throw new Error("expected the floor downgrade reconnect");
        await reconnectAfterFloorDowngrade;
        expect(relay.openBearers).toHaveLength(2);
        expect(session.isReady()).toBe(true);
      }
      try {
        return await remoteMessenger.requestWithResponseTimeout(
          method,
          params,
          responseTimeoutMs,
          options,
        );
      } catch (error: unknown) {
        if (downgraded) {
          capturedFloorErrors.push(error);
          for (const listener of floorErrorListeners) listener();
        }
        throw error;
      }
    },
  };
  const entry: HostDirectoryEntry = {
    ...hostEntryFixture(HOST_ID),
    kind: "remote",
    websocketUrl: "wss://relay.test/attach",
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) => (hostId === HOST_ID ? entry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "test-bearer",
    }),
  );
  const client = spine.createRequester(entry);
  const harness: RemoteHarness = {
    client,
    queryClient,
    relay,
    session,
    capturedFloorRequirements,
    capturedFloorErrors,
    capturedFloorCalls,
    observedHostRequests,
    subscribeRequests(listener) {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    subscribeFloorErrors(listener) {
      floorErrorListeners.add(listener);
      return () => floorErrorListeners.delete(listener);
    },
    armFloorDowngrade(method, version) {
      armedFloorDowngrade = { method, version };
    },
    close: () => {
      session.close();
      queryClient.clear();
    },
  };
  harnesses.push(harness);
  return harness;
}

function successful(result: unknown): HostResponse {
  return { result, error: null };
}

function failed(code: string, message: string): HostResponse {
  return { result: null, error: { code, message, holders: undefined } };
}

function preview(
  profiles: readonly EnvironmentMovePersonalProfile[] | null | undefined,
): EnvironmentMoveStopPreviewResponseV14 {
  const base = { managed: [], needsChoice: [], sheetDigest: null };
  return profiles === undefined
    ? base
    : { ...base, personalProfiles: profiles === null ? null : [...profiles] };
}

function previewWithDigest(
  profiles: readonly EnvironmentMovePersonalProfile[] | null | undefined,
  sheetDigest: string,
): EnvironmentMoveStopPreviewResponseV14 {
  return { ...preview(profiles), sheetDigest };
}

function previewWithChoice(
  sheetDigest: string | null,
  detail: string,
): EnvironmentMoveStopPreviewResponseV14 {
  return {
    ...preview(null),
    sheetDigest,
    needsChoice: [
      {
        row: {
          kind: "variable",
          key: "API_TOKEN",
          os: "any",
          label: "API_TOKEN",
          detail,
        },
        reason: "edited_here",
        origin: "changed_here",
        usedBy: [],
      },
    ],
  };
}

function queryDataEvent<T>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  matches: (data: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => {};
    const check = (): void => {
      const data = queryClient.getQueryData<T>(queryKey);
      if (data === undefined || !matches(data)) return;
      unsubscribe();
      resolve(data);
    };
    unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
  });
}

function hostQuerySettledEvent(
  queryClient: QueryClient,
  method: HostMethod,
): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      const query = queryClient
        .getQueryCache()
        .getAll()
        .find(
          (candidate) =>
            candidate.queryKey[0] === "host" &&
            candidate.queryKey[1] === HOST_ID &&
            candidate.queryKey[2] === method &&
            candidate.state.fetchStatus === "idle" &&
            candidate.state.status !== "pending",
        );
      if (query === undefined) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
  });
}

function hostQueryStatusEvent(
  queryClient: QueryClient,
  method: HostMethod,
  status: "success" | "error",
): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      const query = queryClient
        .getQueryCache()
        .getAll()
        .find(
          (candidate) =>
            candidate.queryKey[0] === "host" &&
            candidate.queryKey[1] === HOST_ID &&
            candidate.queryKey[2] === method &&
            candidate.state.status === status &&
            candidate.state.fetchStatus === "idle",
        );
      if (query === undefined) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
  });
}

function nextQuerySettlementEvent(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): Promise<void> {
  return new Promise((resolve) => {
    let startedQueryHash: string | null = null;
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      const query = queryClient.getQueryCache().find({ queryKey, exact: true });
      if (query?.state.fetchStatus === "fetching")
        startedQueryHash = query.queryHash;
      if (
        startedQueryHash !== null &&
        query?.queryHash === startedQueryHash &&
        query.state.fetchStatus === "idle" &&
        query.state.status !== "pending"
      ) {
        unsubscribe();
        resolve();
      }
    };
    unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
  });
}

function mutationSettledCountEvent(
  queryClient: QueryClient,
  mutationKey: readonly unknown[],
  count: number,
): Promise<void> {
  const settledCount = (): number =>
    queryClient
      .getMutationCache()
      .getAll()
      .filter(
        (mutation) =>
          mutation.options.mutationKey?.[0] === mutationKey[0] &&
          (mutation.state.status === "success" ||
            mutation.state.status === "error"),
      ).length;
  const targetCount = settledCount() + count;
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      if (settledCount() < targetCount) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = queryClient.getMutationCache().subscribe(check);
    check();
  });
}

function nextMutationStatusEvent(
  queryClient: QueryClient,
  mutationKey: readonly unknown[],
  status: "success" | "error",
): Promise<void> {
  const priorCount = queryClient
    .getMutationCache()
    .getAll()
    .filter(
      (mutation) =>
        mutation.options.mutationKey?.[0] === mutationKey[0] &&
        mutation.state.status === status,
    ).length;
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      const count = queryClient
        .getMutationCache()
        .getAll()
        .filter(
          (mutation) =>
            mutation.options.mutationKey?.[0] === mutationKey[0] &&
            mutation.state.status === status,
        ).length;
      if (count <= priorCount) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = queryClient.getMutationCache().subscribe(check);
    check();
  });
}

function floorRefusalEvent(harness: RemoteHarness): Promise<void> {
  if (harness.capturedFloorErrors.length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      if (harness.capturedFloorErrors.length === 0) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = harness.subscribeFloorErrors(check);
    check();
  });
}

function hostRequestEvent(
  harness: RemoteHarness,
  method: HostMethod,
  count: number,
): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      const matching = harness.observedHostRequests.filter(
        (request) => request.method === method,
      );
      if (matching.length < count) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = harness.subscribeRequests(check);
    check();
  });
}

function moveStopOutcomeEvent(
  queryClient: QueryClient,
  expectedOutcome: string,
): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      const hasOutcome = queryClient
        .getMutationCache()
        .getAll()
        .some((mutation) => {
          const data = mutation.state.data;
          const outcome =
            typeof data === "object" && data !== null && "outcome" in data
              ? data.outcome
              : null;
          return (
            mutation.options.mutationKey?.[0] ===
              environmentMutationKeys.moveStop()[0] &&
            mutation.state.status === "success" &&
            outcome === expectedOutcome
          );
        });
      if (!hasOutcome) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = queryClient.getMutationCache().subscribe(check);
    check();
  });
}

function eventGate(): { readonly promise: Promise<void>; resolve(): void } {
  let openGate = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return { promise, resolve: openGate };
}

function providerAwaitLoginSettledEvent(
  queryClient: QueryClient,
): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      const settled = queryClient
        .getMutationCache()
        .getAll()
        .some(
          (mutation) =>
            mutation.options.mutationKey?.[0] ===
              providersMutationKeys.awaitLogin()[0] &&
            mutation.state.status === "success",
        );
      if (!settled) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = queryClient.getMutationCache().subscribe(check);
    check();
  });
}

function providerList(profiles: readonly ProviderProfile[]): ProvidersList {
  const state = providerState({
    providerId: "codex",
    authStatus: "unauthenticated",
    profiles,
  });
  return {
    providers: [
      {
        ...state,
        cliBinaryResolved: true,
        candidates: [
          {
            kind: "bundled",
            path: "/usr/bin/codex",
            version: "1.0.0",
            available: true,
            versionPending: false,
          },
        ],
      },
    ],
    native: null,
    removedProfiles: [],
  };
}

function cacheProvidersList(
  harness: RemoteHarness,
  profiles: readonly ProviderProfile[],
): void {
  const providerListKey = hostQueryKeys.method<
    HostRpcRegistry,
    "providers.list"
  >(HOST_ID, "providers.list", { native: null });
  harness.queryClient.setQueryDefaults(
    hostQueryKeys.methodScope(HOST_ID, "providers.list"),
    { meta: stampHostRpcMethod(undefined, "providers.list") },
  );
  harness.queryClient.setQueryData(providerListKey, providerList(profiles));
}

function providerProfile(
  profileId: string,
  label: string,
  aliases: readonly string[],
): ProviderProfile {
  return pinProfile({
    profileId,
    label,
    kind: "managed",
    enabled: true,
    authStatus: "authenticated",
    aliases,
    personNotice: null,
    terminalOnThisComputer: false,
    otherNames: [],
  });
}

function stopped(): EnvironmentMoveStopResponseV11 {
  return { outcome: "stopped", profileResults: null };
}

function started(
  profileId: string,
  targetRefusal: NonNullable<StartLogin["targetRefusal"]> | null,
): StartLogin {
  return {
    url: null,
    started: true,
    profileId,
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
    targetRefusal,
  };
}

function loginAnswer(
  profileOutcome: ProviderLoginProfileOutcome | null,
): AwaitLogin {
  return {
    state: null,
    existingProfileId: null,
    codeRejected: false,
    refusal: null,
    installation: null,
    profileOutcome,
  };
}

function staged(profileId: string): AwaitLogin {
  return loginAnswer({ kind: "staged-for-leave", profileId });
}

function PersonalListConsumer(props: {
  readonly client: HostClient<HostRpcRegistry>;
}): ReactNode {
  const list = useProvidersListForClient(props.client, {
    enabled: true,
    subscribed: true,
  });
  const names = list.data?.providers
    .flatMap((provider) => provider.profiles.map((profile) => profile.label))
    .join(", ");
  return <p data-testid="providers-list-consumer">{names ?? "Loading"}</p>;
}

function SessionView(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly showListAfterStop: boolean;
  readonly showToaster: boolean;
}): ReactNode {
  const [open, setOpen] = useState(true);
  let afterStop: ReactNode = null;
  if (!open) {
    afterStop = props.showListAfterStop ? (
      <PersonalListConsumer client={props.client} />
    ) : (
      <p data-testid="stop-complete">stop complete</p>
    );
  }
  return (
    <>
      <StopSharingSession
        client={props.client}
        hostId={HOST_ID}
        hostName="This computer"
        open={open}
        onOpenChange={setOpen}
      />
      {afterStop}
      {props.showToaster ? <Toaster /> : null}
    </>
  );
}

function nextAvailabilityRecovered(
  session: RemoteHarness["session"],
): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    unsubscribe = session.subscribeAvailabilityRecovered(() => {
      unsubscribe();
      resolve();
    });
  });
}

async function renderSession(
  client: HostClient<HostRpcRegistry>,
  options: {
    readonly showListAfterStop: boolean;
    readonly showToaster: boolean;
  },
  onRender: ProfilerOnRenderCallback | null,
): Promise<void> {
  const harness = harnesses.find((candidate) => candidate.client === client);
  if (harness === undefined) throw new Error("expected a test query client");
  const ready = nextAvailabilityRecovered(harness.session);
  harness.session.start();
  await ready;
  const previewSettled = hostQuerySettledEvent(
    harness.queryClient,
    "environment.move.stopPreview",
  );
  mountSession(client, harness.queryClient, options, onRender);
  await act(async () => {
    await previewSettled;
  });
}

interface LeaveSheetCommit {
  readonly mutationStatus: string | null;
  readonly confirmDisabled: boolean;
  readonly loading: boolean;
  readonly staleProfileVisible: boolean;
}

function recordLeaveSheetCommits(
  queryClient: QueryClient,
  commits: LeaveSheetCommit[],
): ProfilerOnRenderCallback {
  return () => {
    const stopMutation = queryClient
      .getMutationCache()
      .getAll()
      .find(
        (mutation) =>
          mutation.options.mutationKey?.[0] ===
          environmentMutationKeys.moveStop()[0],
      );
    const confirm = screen.queryByTestId("stop-sharing-confirm");
    commits.push({
      mutationStatus: stopMutation?.state.status ?? null,
      confirmDisabled: confirm === null || confirm.hasAttribute("disabled"),
      loading: screen.queryByTestId("stop-sharing-preview-loading") !== null,
      staleProfileVisible:
        screen.queryByTestId("personal-leave-codex-folder-one") !== null,
    });
  };
}

async function redialAtAdvertisedFloor(
  harness: RemoteHarness,
  method: HostMethod,
  version: HostVersion,
): Promise<void> {
  setAdvertisedMethodVersion(harness.relay, method, version);
  const reconnected = nextAvailabilityRecovered(harness.session);
  harness.relay.dropCurrentConnection();
  await reconnected;
  expect(harness.relay.openBearers).toHaveLength(2);
  expect(harness.session.isReady()).toBe(true);
}

function mountSession(
  client: HostClient<HostRpcRegistry>,
  queryClient: QueryClient,
  options: {
    readonly showListAfterStop: boolean;
    readonly showToaster: boolean;
  },
  onRender: ProfilerOnRenderCallback | null,
): void {
  scheduleQueryNotificationsImmediately();
  const sessionView = (
    <SessionView
      client={client}
      showListAfterStop={options.showListAfterStop}
      showToaster={options.showToaster}
    />
  );
  render(
    <QueryClientProvider client={queryClient}>
      {onRender === null ? (
        sessionView
      ) : (
        <Profiler id="leave-session" onRender={onRender}>
          {sessionView}
        </Profiler>
      )}
    </QueryClientProvider>,
  );
}

function scheduleQueryNotificationsImmediately(): void {
  notifyManager.setScheduler((notify) => notify());
  onTestFinished(() => notifyManager.setScheduler(defaultScheduler));
}

function mountLeaveTargetAddDialog(
  harness: RemoteHarness,
  profileId: string,
): void {
  scheduleQueryNotificationsImmediately();
  const state = providerState({
    providerId: "codex",
    authStatus: "unauthenticated",
    profiles: [],
  });
  const target: ProviderLoginTarget = { kind: "leave-to-local", profileId };
  render(
    <QueryClientProvider client={harness.queryClient}>
      <TooltipProvider>
        <AddProviderProfileDialog
          state={state}
          client={harness.client}
          isLocalHost
          open
          target={target}
          targetResult={(result) => (
            <output data-testid="leave-target-result">
              {result.kind === "target-outcome"
                ? (result.profileOutcome?.kind ?? "null-outcome")
                : result.kind}
            </output>
          )}
          onOpenChange={() => undefined}
          onFailedAttempt={() => undefined}
          onProfileCreated={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function requestCount(relay: FakeRelayHost, method: string): number {
  return relay.unaryRequests.filter((request) => request.method === method)
    .length;
}

async function expectFloorRefusalAfterReconnect(
  harness: RemoteHarness,
  requirement: RequiredHostMethodVersion,
): Promise<void> {
  await floorRefusalEvent(harness);
  expect(harness.capturedFloorErrors).toHaveLength(1);
  expect(harness.session.isReady()).toBe(true);
  expect(harness.capturedFloorErrors[0]).toBeInstanceOf(
    HostMethodVersionUnsatisfiedError,
  );
  expect(harness.relay.openBearers).toHaveLength(2);
  expect(harness.capturedFloorRequirements).toEqual([requirement]);
  expect(harness.relay.errors).toEqual([]);
}

describe("StopSharingSession over the real remote session", () => {
  it("query refresh clears item choices when the shown digest changes", async () => {
    notifyManager.setScheduler((notify) => notify());
    onTestFinished(() => notifyManager.setScheduler(defaultScheduler));
    const shownDigest = "e".repeat(64);
    const refreshedDigest = "f".repeat(64);
    let resolveStopRequest: ((params: unknown) => void) | null = null;
    const stopRequest = new Promise<unknown>((resolve) => {
      resolveStopRequest = resolve;
    });
    const harness = makeHarness(({ method, params }) => {
      if (method === "environment.move.stopPreview")
        return successful(
          previewWithChoice(shownDigest, "Old credential detail"),
        );
      if (method === "environment.move.stop") {
        resolveStopRequest?.(params);
        return successful(stopped());
      }
      if (method === "providers.list") return successful(providerList([]));
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    advertiseSheetDigestStopPair(harness.relay);
    const previewKey = hostQueryKeys.method<
      HostRpcRegistry,
      "environment.move.stopPreview"
    >(HOST_ID, "environment.move.stopPreview", {
      profileMode: "keep-personal",
    });
    const shownPreview = queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
      harness.queryClient,
      previewKey,
      (data) => data.sheetDigest === shownDigest,
    );
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );
    await act(async () => {
      await shownPreview;
    });

    const keepChoice = screen.getByTestId(
      "stop-sharing-choice-variable-API_TOKEN-keep_locally",
    );
    fireEvent.click(keepChoice);
    expect(keepChoice.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByTestId("stop-sharing-confirm").hasAttribute("disabled"),
    ).toBe(false);

    const refreshedPreview =
      queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
        harness.queryClient,
        previewKey,
        (data) => data.sheetDigest === refreshedDigest,
      );
    await act(async () => {
      harness.queryClient.setQueryData(
        previewKey,
        previewWithChoice(refreshedDigest, "Updated credential detail"),
      );
      await refreshedPreview;
    });

    expect(screen.getByText("Updated credential detail")).toBeTruthy();
    const refreshedChoice = screen.getByTestId(
      "stop-sharing-choice-variable-API_TOKEN-keep_locally",
    );
    expect(refreshedChoice.getAttribute("aria-pressed")).toBe("false");
    const confirm = screen.getByTestId("stop-sharing-confirm");
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.click(refreshedChoice);
    expect(confirm.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
      expect(await stopRequest).toEqual({
        choices: [
          {
            kind: "variable",
            key: "API_TOKEN",
            choice: "keep_locally",
          },
        ],
        profileMode: null,
        profileSignIns: [],
        sheetDigest: refreshedDigest,
      });
    });
  });

  it("query refresh resets changed profile decisions and preserves matching ones", async () => {
    notifyManager.setScheduler((notify) => notify());
    onTestFinished(() => notifyManager.setScheduler(defaultScheduler));
    const shownDigest = "1".repeat(64);
    const refreshedDigest = "2".repeat(64);
    let resolveStopRequest: ((params: unknown) => void) | null = null;
    const stopRequest = new Promise<unknown>((resolve) => {
      resolveStopRequest = resolve;
    });
    const initialProfiles = [
      FOLDER("folder-one", "Work", "offered"),
      FOLDER("folder-two", "Personal", "offered"),
    ];
    const refreshedProfiles = [
      SHARED_FOLDER("folder-one", "Work"),
      FOLDER("folder-two", "Personal", "offered"),
    ];
    const harness = makeHarness(({ method, params }) => {
      if (method === "environment.move.stopPreview")
        return successful(previewWithDigest(initialProfiles, shownDigest));
      if (method === "environment.move.stop") {
        resolveStopRequest?.(params);
        return successful(stopped());
      }
      if (method === "providers.list") return successful(providerList([]));
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    advertiseSheetDigestStopPair(harness.relay);
    const previewKey = hostQueryKeys.method<
      HostRpcRegistry,
      "environment.move.stopPreview"
    >(HOST_ID, "environment.move.stopPreview", {
      profileMode: "keep-personal",
    });
    const shownPreview = queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
      harness.queryClient,
      previewKey,
      (data) => data.sheetDigest === shownDigest,
    );
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );
    await act(async () => {
      await shownPreview;
    });

    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Skip" },
      ),
    );
    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-two")).getByRole(
        "button",
        { name: "Skip" },
      ),
    );

    const refreshedPreview =
      queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
        harness.queryClient,
        previewKey,
        (data) => data.sheetDigest === refreshedDigest,
      );
    await act(async () => {
      harness.queryClient.setQueryData(
        previewKey,
        previewWithDigest(refreshedProfiles, refreshedDigest),
      );
      await refreshedPreview;
    });

    const changedRow = screen.getByTestId("personal-leave-codex-folder-one");
    const matchingRow = screen.getByTestId("personal-leave-codex-folder-two");
    expect
      .soft(within(changedRow).queryByRole("button", { name: "Skip" }))
      .not.toBeNull();
    expect
      .soft(within(matchingRow).getByRole("button", { name: "Undo" }))
      .toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      expect(await stopRequest).toMatchObject({
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "folder-one",
            signIn: { kind: "untouched" },
          },
          {
            providerId: "codex",
            profileId: "folder-two",
            signIn: { kind: "skip" },
          },
        ],
        sheetDigest: refreshedDigest,
      });
    });
  });

  it("retains a matching admission through a refusal refresh without reconciling stale cached profiles", async () => {
    notifyManager.setScheduler((notify) => notify());
    onTestFinished(() => notifyManager.setScheduler(defaultScheduler));
    const initialDigest = "3".repeat(64);
    const staleDigest = "4".repeat(64);
    const freshDigest = "5".repeat(64);
    const profile = FOLDER("folder-one", "Work", "offered");
    const freshReadStarted = eventGate();
    let previews = 0;
    let stops = 0;
    let responseDelayRelay: RemoteHarness["relay"] | null = null;
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview") {
        previews += 1;
        if (previews === 2) {
          if (responseDelayRelay === null)
            throw new Error("expected the relay before the refreshed preview");
          responseDelayRelay.unaryResponseDelayMs = 5000;
          freshReadStarted.resolve();
          return successful(previewWithDigest([profile], freshDigest));
        }
        return successful(previewWithDigest([profile], initialDigest));
      }
      if (method === "providers.list") return successful(providerList([]));
      if (method === "providers.startLogin")
        return successful(started("held-admission", null));
      if (method === "providers.awaitLogin")
        return successful(staged("folder-one"));
      if (method === "providers.cancelLogin")
        return successful({ cancelled: true });
      if (method === "environment.move.stop") {
        stops += 1;
        return stops === 1
          ? failed("E_INVALID_ARGUMENT", "refresh required")
          : successful(stopped());
      }
      return failed("E_UNEXPECTED", "unexpected RPC");
    });
    responseDelayRelay = harness.relay;
    advertiseSheetDigestStopPair(harness.relay);
    cacheProvidersList(harness, []);
    const previewKey = hostQueryKeys.method<
      HostRpcRegistry,
      "environment.move.stopPreview"
    >(HOST_ID, "environment.move.stopPreview", {
      profileMode: "keep-personal",
    });
    const shownPreview = queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
      harness.queryClient,
      previewKey,
      (data) => data.sheetDigest === initialDigest,
    );
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );
    await act(async () => {
      await shownPreview;
    });

    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Sign in" },
      ),
    );
    const signInButton = screen.getByRole("button", { name: "Sign in" });
    const stagedLogin = providerAwaitLoginSettledEvent(harness.queryClient);
    await act(async () => {
      fireEvent.click(signInButton);
      await stagedLogin;
    });
    expect(screen.getByText("Signed in")).toBeTruthy();

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await freshReadStarted.promise;
    });
    const freshPreview = queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
      harness.queryClient,
      previewKey,
      (data) => data.sheetDigest === freshDigest,
    );
    await act(async () => {
      harness.queryClient.setQueryData(
        previewKey,
        previewWithDigest([SHARED_FOLDER("folder-one", "Work")], staleDigest),
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId("stop-sharing-preview-loading")).toBeTruthy();
    expect(
      screen.getByTestId("stop-sharing-confirm").hasAttribute("disabled"),
    ).toBe(true);
    expect(requestCount(harness.relay, "providers.cancelLogin")).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await freshPreview;
    });
    expect(screen.getByTestId("personal-leave-codex-folder-one")).toBeTruthy();
    expect(requestCount(harness.relay, "providers.cancelLogin")).toBe(0);
    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stopComplete;
    });
    expect(screen.getByTestId("stop-complete")).toBeTruthy();
    expect(stopRequests(harness)).toEqual([
      {
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "folder-one",
            signIn: { kind: "signed-in", admissionId: "held-admission" },
          },
        ],
        sheetDigest: initialDigest,
      },
      {
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "folder-one",
            signIn: { kind: "signed-in", admissionId: "held-admission" },
          },
        ],
        sheetDigest: freshDigest,
      },
    ]);
    expect(harness.relay.errors).toEqual([]);
  });

  it("clears a profile Skip when the matching profile label changes in a replacement", async () => {
    notifyManager.setScheduler((notify) => notify());
    onTestFinished(() => notifyManager.setScheduler(defaultScheduler));
    const shownDigest = "6".repeat(64);
    const refreshedDigest = "7".repeat(64);
    let stops = 0;
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(
          previewWithDigest(
            [FOLDER("folder-one", "Work", "offered")],
            shownDigest,
          ),
        );
      if (method === "providers.list") return successful(providerList([]));
      if (method === "environment.move.stop") {
        stops += 1;
        if (stops === 1)
          return successful({
            outcome: "sheet_changed",
            preview: previewWithDigest(
              [FOLDER("folder-one", "Renamed Work", "offered")],
              refreshedDigest,
            ),
          });
        return successful(stopped());
      }
      return failed("E_UNEXPECTED", "unexpected RPC");
    });
    advertiseSheetDigestStopPair(harness.relay);
    const previewKey = hostQueryKeys.method<
      HostRpcRegistry,
      "environment.move.stopPreview"
    >(HOST_ID, "environment.move.stopPreview", {
      profileMode: "keep-personal",
    });
    const shownPreview = queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
      harness.queryClient,
      previewKey,
      (data) => data.sheetDigest === shownDigest,
    );
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );
    await act(async () => {
      await shownPreview;
    });

    const row = screen.getByTestId("personal-leave-codex-folder-one");
    fireEvent.click(within(row).getByRole("button", { name: "Skip" }));
    const changedSheet = moveStopOutcomeEvent(
      harness.queryClient,
      "sheet_changed",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await changedSheet;
    });

    expect(screen.getByText("Renamed Work")).toBeTruthy();
    const refreshedRow = screen.getByTestId("personal-leave-codex-folder-one");
    const skip = within(refreshedRow).getByRole("button", { name: "Skip" });
    expect(skip).toBeTruthy();
    expect(
      within(refreshedRow).queryByRole("button", { name: "Undo" }),
    ).toBeNull();

    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stopComplete;
    });
    expect(stopRequests(harness)).toEqual([
      {
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "folder-one",
            signIn: { kind: "skip" },
          },
        ],
        sheetDigest: shownDigest,
      },
      {
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "folder-one",
            signIn: { kind: "untouched" },
          },
        ],
        sheetDigest: refreshedDigest,
      },
    ]);
    expect(harness.relay.errors).toEqual([]);
  });

  it("clears a stale Remove choice after legacy choices_missing refreshes the same row", async () => {
    notifyManager.setScheduler((notify) => notify());
    onTestFinished(() => notifyManager.setScheduler(defaultScheduler));
    let previews = 0;
    let stops = 0;
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview") {
        previews += 1;
        return successful(
          previewWithChoice(
            null,
            previews === 1
              ? "Old credential detail"
              : "Fresh credential detail",
          ),
        );
      }
      if (method === "providers.list") return successful(providerList([]));
      if (method === "environment.move.stop") {
        stops += 1;
        return successful(
          stops === 1 ? { outcome: "choices_missing" } : stopped(),
        );
      }
      return failed("E_UNEXPECTED", "unexpected RPC");
    });
    advertiseSheetDigestStopPair(harness.relay);
    const previewKey = hostQueryKeys.method<
      HostRpcRegistry,
      "environment.move.stopPreview"
    >(HOST_ID, "environment.move.stopPreview", {
      profileMode: "keep-personal",
    });
    const shownPreview = queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
      harness.queryClient,
      previewKey,
      (data) =>
        data.sheetDigest === null &&
        data.needsChoice[0]?.row.detail === "Old credential detail",
    );
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );
    await act(async () => {
      await shownPreview;
    });

    const remove = screen.getByTestId(
      "stop-sharing-choice-variable-API_TOKEN-remove_from_this_computer",
    );
    fireEvent.click(remove);
    expect(remove.getAttribute("aria-pressed")).toBe("true");
    const choicesMissing = moveStopOutcomeEvent(
      harness.queryClient,
      "choices_missing",
    );
    const freshPreview = queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
      harness.queryClient,
      previewKey,
      (data) =>
        data.sheetDigest === null &&
        data.needsChoice[0]?.row.detail === "Fresh credential detail",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await Promise.all([choicesMissing, freshPreview]);
    });

    expect(screen.getByText("Fresh credential detail")).toBeTruthy();
    const refreshedRemove = screen.getByTestId(
      "stop-sharing-choice-variable-API_TOKEN-remove_from_this_computer",
    );
    expect(refreshedRemove.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByTestId("stop-sharing-confirm").hasAttribute("disabled"),
    ).toBe(true);
    expect(stopRequests(harness)).toEqual([
      {
        choices: [
          {
            kind: "variable",
            key: "API_TOKEN",
            choice: "remove_from_this_computer",
          },
        ],
        profileMode: null,
        profileSignIns: [],
      },
    ]);
    expect(harness.relay.errors).toEqual([]);
  });

  it.each([
    {
      label: "plain",
      profiles: undefined,
      profileMode: null,
    },
    {
      label: "keep-personal",
      profiles: [FOLDER("folder-one", "Work", "offered")],
      profileMode: "keep-personal",
    },
  ] as const)(
    "sends the displayed sheet digest on a $label Stop",
    async ({ profiles, profileMode }) => {
      notifyManager.setScheduler((notify) => notify());
      onTestFinished(() => notifyManager.setScheduler(defaultScheduler));
      const digest = "a".repeat(64);
      const harness = makeHarness(({ method }) => {
        if (method === "environment.move.stopPreview")
          return successful(previewWithDigest(profiles, digest));
        if (method === "environment.move.stop") return successful(stopped());
        if (method === "providers.list") return successful(providerList([]));
        return failed("E_UNEXPECTED", `unexpected method: ${method}`);
      });
      advertiseSheetDigestStopPair(harness.relay);
      const previewKey = hostQueryKeys.method<
        HostRpcRegistry,
        "environment.move.stopPreview"
      >(HOST_ID, "environment.move.stopPreview", {
        profileMode: "keep-personal",
      });
      const shownPreview =
        queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
          harness.queryClient,
          previewKey,
          (data) => data.sheetDigest === digest,
        );
      await renderSession(
        harness.client,
        {
          showListAfterStop: false,
          showToaster: false,
        },
        null,
      );
      await act(async () => {
        await shownPreview;
      });

      if (profileMode === null) {
        expect(screen.getByTestId("stop-sharing-managed-empty")).toBeTruthy();
      } else {
        expect(
          screen.getByTestId("personal-leave-codex-folder-one"),
        ).toBeTruthy();
      }
      const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
      await act(async () => {
        fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
        await stopComplete;
      });
      expect(screen.getByTestId("stop-complete")).toBeTruthy();

      expect(stopRequests(harness)).toEqual([
        {
          choices: [],
          profileMode,
          profileSignIns:
            profileMode === null
              ? []
              : [
                  {
                    providerId: "codex",
                    profileId: "folder-one",
                    signIn: { kind: "untouched" },
                  },
                ],
          sheetDigest: digest,
        },
      ]);
      expect(requestCount(harness.relay, "environment.move.stopPreview")).toBe(
        1,
      );
      expect(harness.relay.errors).toEqual([]);
    },
  );

  it("falls back from null personal profiles to plain Stop with that preview digest", async () => {
    notifyManager.setScheduler((notify) => notify());
    onTestFinished(() => notifyManager.setScheduler(defaultScheduler));
    const digest = "b".repeat(64);
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(previewWithDigest(null, digest));
      if (method === "environment.move.stop") return successful(stopped());
      if (method === "providers.list") return successful(providerList([]));
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    advertiseSheetDigestStopPair(harness.relay);
    const previewKey = hostQueryKeys.method<
      HostRpcRegistry,
      "environment.move.stopPreview"
    >(HOST_ID, "environment.move.stopPreview", {
      profileMode: "keep-personal",
    });
    const shownPreview = queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
      harness.queryClient,
      previewKey,
      (data) => data.sheetDigest === digest,
    );
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );
    await act(async () => {
      await shownPreview;
    });

    expect(screen.getByTestId("stop-sharing-managed-empty")).toBeTruthy();
    expect(requestCount(harness.relay, "environment.move.stopPreview")).toBe(1);
    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stopComplete;
    });
    expect(screen.getByTestId("stop-complete")).toBeTruthy();

    expect(stopRequests(harness)).toEqual([
      {
        choices: [],
        profileMode: null,
        profileSignIns: [],
        sheetDigest: digest,
      },
    ]);
    expect(requestCount(harness.relay, "environment.move.stopPreview")).toBe(1);
    expect(harness.relay.errors).toEqual([]);
  });

  it("replaces the sheet from sheet_changed and confirms again with its returned digest", async () => {
    notifyManager.setScheduler((notify) => notify());
    onTestFinished(() => notifyManager.setScheduler(defaultScheduler));
    const shownDigest = "c".repeat(64);
    const changedDigest = "d".repeat(64);
    let stopAttempts = 0;
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(
          previewWithDigest(
            [FOLDER("folder-one", "Work", "offered")],
            shownDigest,
          ),
        );
      if (method === "providers.list") return successful(providerList([]));
      if (method === "environment.move.stop") {
        stopAttempts += 1;
        if (stopAttempts === 1)
          return successful({
            outcome: "sheet_changed",
            preview: {
              ...previewWithDigest(null, changedDigest),
              managed: [
                {
                  kind: "variable",
                  key: "PLAIN_ONLY",
                  os: "any",
                  label: "PLAIN_ONLY",
                  detail: null,
                },
              ],
            },
          });
        return successful(stopped());
      }
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    advertiseSheetDigestStopPair(harness.relay);
    const previewKey = hostQueryKeys.method<
      HostRpcRegistry,
      "environment.move.stopPreview"
    >(HOST_ID, "environment.move.stopPreview", {
      profileMode: "keep-personal",
    });
    const shownPreview = queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
      harness.queryClient,
      previewKey,
      (data) => data.sheetDigest === shownDigest,
    );
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );
    await act(async () => {
      await shownPreview;
    });

    expect(screen.getByTestId("personal-leave-codex-folder-one")).toBeTruthy();
    const changedSheet = moveStopOutcomeEvent(
      harness.queryClient,
      "sheet_changed",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await changedSheet;
    });
    expect(
      screen.getByTestId("stop-sharing-managed-variable-PLAIN_ONLY"),
    ).toBeTruthy();
    expect(stopRequests(harness)).toHaveLength(1);
    expect(stopRequests(harness)[0]).toMatchObject({
      profileMode: "keep-personal",
      sheetDigest: shownDigest,
    });
    expect(screen.queryByTestId("personal-leave-codex-folder-one")).toBeNull();
    const confirm = screen.getByTestId("stop-sharing-confirm");
    expect(confirm.hasAttribute("disabled")).toBe(false);
    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(confirm);
      await stopComplete;
    });
    expect(screen.getByTestId("stop-complete")).toBeTruthy();

    expect(stopRequests(harness)).toEqual([
      {
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "folder-one",
            signIn: { kind: "untouched" },
          },
        ],
        sheetDigest: shownDigest,
      },
      {
        choices: [],
        profileMode: null,
        profileSignIns: [],
        sheetDigest: changedDigest,
      },
    ]);
    expect(requestCount(harness.relay, "environment.move.stopPreview")).toBe(1);
    expect(harness.relay.errors).toEqual([]);
  });

  it.each([
    ["null personalProfiles", null],
    ["absent personalProfiles", undefined],
  ] as const)(
    "keeps the legacy sheet for %s",
    async (_label, personalProfiles) => {
      const harness = makeHarness(({ method }) => {
        if (method === "environment.move.stopPreview") {
          return successful(preview(personalProfiles));
        }
        if (method === "environment.move.stop") return successful(stopped());
        if (method === "providers.list") return successful(providerList([]));
        return failed("E_UNEXPECTED", `unexpected method: ${method}`);
      });
      await renderSession(
        harness.client,
        {
          showListAfterStop: false,
          showToaster: false,
        },
        null,
      );

      expect(screen.getByTestId("stop-sharing-sheet")).toBeTruthy();
      expect(
        screen.getByRole("heading", {
          name: "Stop using Personal on this computer",
        }),
      ).toBeTruthy();
      expect(
        harness.relay.unaryRequests.find(
          (request) => request.method === "environment.move.stopPreview",
        )?.params,
      ).toEqual({ profileMode: "keep-personal" });
      screen.getByTestId("stop-sharing-managed-empty");
      expect(requestCount(harness.relay, "providers.list")).toBe(0);

      const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
      await act(async () => {
        fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
        await stopComplete;
      });
      const stop = harness.relay.unaryRequests.find(
        (request) => request.method === "environment.move.stop",
      );
      expect(stop?.params).toEqual({
        choices: [],
        profileMode: null,
        profileSignIns: [],
      });
      expect(screen.getByTestId("stop-complete")).toBeTruthy();
      expect(requestCount(harness.relay, "providers.list")).toBe(0);
      expect(harness.relay.errors).toEqual([]);
    },
  );

  it("sends byte-identical legacy requests to a 10.11 computer and never reads providers.list", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview") {
        return successful(preview(null));
      }
      if (method === "environment.move.stop") {
        return successful({ outcome: "stopped" });
      }
      if (method === "providers.list") return successful(providerList([]));
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    setAdvertisedMethodVersion(harness.relay, "environment.move.stopPreview", {
      major: 1,
      minor: 1,
    });
    setAdvertisedMethodVersion(harness.relay, "environment.move.stop", {
      major: 1,
      minor: 0,
    });
    setAdvertisedMethodVersion(harness.relay, "providers.startLogin", {
      major: 1,
      minor: 4,
    });
    setAdvertisedMethodVersion(harness.relay, "providers.awaitLogin", {
      major: 2,
      minor: 3,
    });
    setAdvertisedMethodVersion(harness.relay, "providers.list", {
      major: 10,
      minor: 11,
    });
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );

    expect(screen.getByTestId("stop-sharing-sheet")).toBeTruthy();
    screen.getByTestId("stop-sharing-managed-empty");
    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stopComplete;
    });
    expect(
      harness.relay.unaryRequests
        .filter((request) => request.method.startsWith("environment.move.stop"))
        .map((request) => ({ method: request.method, params: request.params })),
    ).toEqual([
      { method: "environment.move.stopPreview", params: {} },
      { method: "environment.move.stop", params: { choices: [] } },
    ]);
    expect(requestCount(harness.relay, "providers.list")).toBe(0);
    expect(harness.relay.errors).toEqual([]);
  });

  it("keeps Stop open after E_INVALID_ARGUMENT, refreshes the preview, then sends null mode on the same connection", async () => {
    let previews = 0;
    let stops = 0;
    let responseDelayRelay: RemoteHarness["relay"] | null = null;
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview") {
        previews += 1;
        if (previews === 2) {
          if (responseDelayRelay === null) {
            throw new Error("expected the relay before the refreshed preview");
          }
          responseDelayRelay.unaryResponseDelayMs = 5000;
        }
        return successful(
          preview(
            previews === 1 ? [FOLDER("folder-one", "Work", "offered")] : null,
          ),
        );
      }
      if (method === "providers.list") return successful(providerList([]));
      if (method === "environment.move.stop") {
        stops += 1;
        return stops === 1
          ? failed("E_INVALID_ARGUMENT", "legacy request rejected")
          : successful({ outcome: "stopped" });
      }
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    responseDelayRelay = harness.relay;
    const commits: LeaveSheetCommit[] = [];
    await renderSession(
      harness.client,
      { showListAfterStop: false, showToaster: false },
      recordLeaveSheetCommits(harness.queryClient, commits),
    );

    vi.useFakeTimers();
    const refreshedPreview = nextQuerySettlementEvent(
      harness.queryClient,
      hostQueryKeys.method<HostRpcRegistry, "environment.move.stopPreview">(
        HOST_ID,
        "environment.move.stopPreview",
        {
          profileMode: "keep-personal",
        },
      ),
    );
    const stopFailed = nextMutationStatusEvent(
      harness.queryClient,
      environmentMutationKeys.moveStop(),
      "error",
    );
    const refreshRequest = hostRequestEvent(
      harness,
      "environment.move.stopPreview",
      2,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await Promise.all([stopFailed, refreshRequest]);
    });
    expect(screen.getByTestId("stop-sharing-preview-loading")).toBeTruthy();
    const settledRefreshCommits = commits.filter(
      (commit) => commit.mutationStatus === "error",
    );
    expect(settledRefreshCommits.length).toBeGreaterThan(0);
    expect(
      settledRefreshCommits.every(
        (commit) =>
          commit.loading &&
          commit.confirmDisabled &&
          !commit.staleProfileVisible,
      ),
    ).toBe(true);
    expect(
      screen.getByTestId("stop-sharing-confirm").hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    expect(requestCount(harness.relay, "environment.move.stop")).toBe(1);
    expect(screen.getByTestId("stop-sharing-sheet")).toBeTruthy();
    expect(
      harness.relay.unaryRequests
        .filter((request) => request.method === "environment.move.stop")
        .map((request) => request.params),
    ).toEqual([
      {
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "folder-one",
            signIn: { kind: "untouched" },
          },
        ],
      },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await refreshedPreview;
    });
    harness.relay.unaryResponseDelayMs = null;
    expect(screen.getByTestId("stop-sharing-managed-empty")).toBeTruthy();
    expect(
      screen.getByTestId("stop-sharing-confirm").hasAttribute("disabled"),
    ).toBe(false);
    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stopComplete;
    });
    expect(screen.getByText("stop complete")).toBeTruthy();
    expect(
      harness.relay.unaryRequests
        .filter((request) => request.method === "environment.move.stop")
        .map((request) => request.params),
    ).toEqual([
      {
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "folder-one",
            signIn: { kind: "untouched" },
          },
        ],
      },
      { choices: [], profileMode: null, profileSignIns: [] },
    ]);
    const relevant = harness.relay.unaryRequests.filter((request) =>
      ["environment.move.stopPreview", "environment.move.stop"].includes(
        request.method,
      ),
    );
    expect(
      new Set(
        relevant.map(
          (request) =>
            harness.relay.unaryRequestConnectionIds[
              harness.relay.unaryRequests.indexOf(request)
            ],
        ),
      ),
    ).toEqual(new Set([0]));
    expect(harness.relay.openBearers).toHaveLength(1);
    expect(harness.relay.errors).toEqual([]);
  });

  it("shows the failed preview after a refused Stop refresh and sends no second Stop", async () => {
    let previews = 0;
    let responseDelayRelay: RemoteHarness["relay"] | null = null;
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview") {
        previews += 1;
        if (previews === 2) {
          if (responseDelayRelay === null) {
            throw new Error("expected the relay before the refreshed preview");
          }
          responseDelayRelay.unaryResponseDelayMs = 5000;
        }
        return previews === 1
          ? successful(preview([FOLDER("folder-one", "Work", "offered")]))
          : failed("E_UNEXPECTED", "preview unavailable");
      }
      if (method === "providers.list") return successful(providerList([]));
      if (method === "environment.move.stop") {
        return failed("E_INVALID_ARGUMENT", "legacy request rejected");
      }
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    responseDelayRelay = harness.relay;
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );

    screen.getByTestId("personal-leave-codex-folder-one");
    vi.useFakeTimers();
    const refreshedPreview = nextQuerySettlementEvent(
      harness.queryClient,
      hostQueryKeys.method<HostRpcRegistry, "environment.move.stopPreview">(
        HOST_ID,
        "environment.move.stopPreview",
        {
          profileMode: "keep-personal",
        },
      ),
    );
    const stopFailed = nextMutationStatusEvent(
      harness.queryClient,
      environmentMutationKeys.moveStop(),
      "error",
    );
    const refreshRequest = hostRequestEvent(
      harness,
      "environment.move.stopPreview",
      2,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await Promise.all([stopFailed, refreshRequest]);
    });
    expect(screen.getByTestId("stop-sharing-preview-loading")).toBeTruthy();
    expect(
      screen.getByTestId("stop-sharing-confirm").hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    expect(requestCount(harness.relay, "environment.move.stop")).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await refreshedPreview;
    });
    harness.relay.unaryResponseDelayMs = null;
    expect(screen.getByTestId("stop-sharing-preview-failed")).toBeTruthy();
    expect(
      screen.getByTestId("stop-sharing-confirm").hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    expect(requestCount(harness.relay, "environment.move.stop")).toBe(1);
    expect(
      harness.relay.unaryRequests
        .filter((request) => request.method === "environment.move.stop")
        .map((request) => request.params),
    ).toEqual([
      {
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "folder-one",
            signIn: { kind: "untouched" },
          },
        ],
      },
    ]);
    expect(harness.relay.errors).toEqual([]);
  });

  it("stages one folder, skips another, and reads both profiles after Stop through the provider-list consumer", async () => {
    const rows = [
      FOLDER("folder-one", "Work", "offered"),
      FOLDER("folder-two", "Home", "offered"),
    ];
    const shared = providerProfile("shared-account", "Shared account", [
      "folder-one",
      "folder-two",
    ]);
    const finalProfiles = [
      providerProfile("folder-one", "Work", []),
      providerProfile("folder-two", "Home", []),
    ];
    let stopped = false;
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(preview(rows));
      if (method === "providers.list")
        return successful(providerList(stopped ? finalProfiles : [shared]));
      if (method === "providers.startLogin")
        return successful(started("admission-work", null));
      if (method === "providers.awaitLogin")
        return successful(staged("folder-one"));
      if (method === "environment.move.stop") {
        stopped = true;
        return successful({
          outcome: "stopped",
          profileResults: [
            {
              providerId: "codex",
              profileId: "folder-one",
              signIn: "installed",
            },
            { providerId: "codex", profileId: "folder-two", signIn: "skipped" },
          ],
        });
      }
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    );
    const initialList = queryDataEvent<ProvidersList>(
      harness.queryClient,
      listKey,
      (data) =>
        data.providers[0]?.profiles.some(
          (profile) => profile.profileId === "shared-account",
        ) ?? false,
    );
    await renderSession(
      harness.client,
      {
        showListAfterStop: true,
        showToaster: false,
      },
      null,
    );
    await act(async () => {
      await initialList;
    });

    expect(screen.getByTestId("personal-leave-codex-folder-one")).toBeTruthy();
    expect(screen.getByText("Same account as Work")).toBeTruthy();
    expect(screen.getAllByText(GUIDANCE)).toHaveLength(1);
    expect(screen.queryByText(new RegExp(CUT_GUIDANCE_SENTENCE))).toBeNull();
    expect(requestCount(harness.relay, "providers.list")).toBe(1);

    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Sign in" },
      ),
    );
    expect(screen.getByRole("heading", { name: "Add a profile" })).toBeTruthy();
    const loginSettled = providerAwaitLoginSettledEvent(harness.queryClient);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await loginSettled;
    });
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Add a profile" })).toBeNull();

    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-two")).getByRole(
        "button",
        { name: "Skip" },
      ),
    );
    expect(
      screen.getByText("Skipped. Works until Codex asks for a new sign-in."),
    ).toBeTruthy();
    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    const finalList = queryDataEvent<ProvidersList>(
      harness.queryClient,
      listKey,
      (data) =>
        data.providers[0]?.profiles.some(
          (profile) => profile.profileId === "folder-two",
        ) ?? false,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await Promise.all([stopComplete, finalList]);
    });
    expect(screen.getByText("Work, Home")).toBeTruthy();
    const stop = harness.relay.unaryRequests.find(
      (request) => request.method === "environment.move.stop",
    );
    expect(stop?.params).toEqual({
      choices: [],
      profileMode: "keep-personal",
      profileSignIns: [
        {
          providerId: "codex",
          profileId: "folder-one",
          signIn: { kind: "signed-in", admissionId: "admission-work" },
        },
        {
          providerId: "codex",
          profileId: "folder-two",
          signIn: { kind: "skip" },
        },
      ],
    });
    const start = harness.relay.unaryRequests.find(
      (request) => request.method === "providers.startLogin",
    );
    expect(start?.params).toMatchObject({
      providerId: "codex",
      target: { kind: "leave-to-local", profileId: "folder-one" },
    });
    expect(harness.relay.errors).toEqual([]);
  });

  it("treats empty personalProfiles as the new mode and still records a profile-mode Stop", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(preview([]));
      if (method === "providers.list") return successful(providerList([]));
      if (method === "environment.move.stop") return successful(stopped());
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );

    expect(screen.getByTestId("stop-sharing-managed-empty")).toBeTruthy();
    const listRead = queryDataEvent<ProvidersList>(
      harness.queryClient,
      hostQueryKeys.method<HostRpcRegistry, "providers.list">(
        HOST_ID,
        "providers.list",
        { native: null },
      ),
      (data) => data.providers[0]?.profiles.length === 0,
    );
    await act(async () => {
      await listRead;
    });
    expect(requestCount(harness.relay, "providers.list")).toBe(1);
    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stopComplete;
    });
    screen.getByTestId("stop-complete");
    expect(
      harness.relay.unaryRequests.find(
        (request) => request.method === "environment.move.stop",
      )?.params,
    ).toEqual({
      choices: [],
      profileMode: "keep-personal",
      profileSignIns: [],
    });
    expect(harness.relay.errors).toEqual([]);
  });

  it("uses cached provider metadata and leaves an ambiguous alias ungrouped", async () => {
    const rows = [
      FOLDER("folder-one", "Work", "offered"),
      FOLDER("folder-two", "Home", "offered"),
    ];
    const harness = makeHarness(({ method }) =>
      method === "environment.move.stopPreview"
        ? successful(preview(rows))
        : failed("E_UNEXPECTED", `unexpected method: ${method}`),
    );
    cacheProvidersList(harness, [
      providerProfile("account-one", "One", ["folder-one"]),
      providerProfile("account-two", "Two", ["folder-two"]),
      providerProfile("account-three", "Three", ["folder-two"]),
    ]);
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );

    expect(screen.getByTestId("personal-leave-codex-folder-two")).toBeTruthy();
    expect(screen.queryByText("Same account as Work")).toBeNull();
    expect(requestCount(harness.relay, "providers.list")).toBe(0);
    expect(guidanceParagraphs()).toEqual([GUIDANCE]);
  });

  it("states once what Skip asks for, naming no provider and no kept-until-sign-in promise", async () => {
    const rows = [
      folder("codex", "work", "Work", "offered"),
      folder("claude-code", "home", "Home", "offered"),
      folder("codex", "other-work", "Other work", "offered"),
      folder("claude-code", "read-only", "Read-only", "not-needed"),
    ];
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview") {
        return successful(preview(rows));
      }
      if (method === "providers.list") return successful(providerList([]));
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );

    screen.getByTestId("personal-leave-accounts");
    expect(guidanceParagraphs()).toEqual([GUIDANCE]);
    expect(screen.queryByText(new RegExp(CUT_GUIDANCE_SENTENCE))).toBeNull();
    expect(screen.getByText("Keeps working. No sign-in needed.")).toBeTruthy();
  });

  it("keeps mismatch, unproven, refused, and unfinished sign-ins skippable", async () => {
    const rows = [
      FOLDER("mismatch", "Work", "offered"),
      FOLDER("unproven", "Home", "offered"),
      FOLDER("unfinished", "Lab", "offered"),
      FOLDER("removed", "Retired", "offered"),
    ];
    let starts = 0;
    let awaits = 0;
    const outcomes: readonly (ProviderLoginProfileOutcome | null)[] = [
      { kind: "account-mismatch" },
      { kind: "account-unproven" },
      null,
    ];
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(preview(rows));
      if (method === "providers.list") return successful(providerList([]));
      if (method === "providers.startLogin") {
        starts += 1;
        return successful(
          starts === 4
            ? started("admission-removed", "target-removed")
            : started(`admission-${String(starts)}`, null),
        );
      }
      if (method === "providers.awaitLogin") {
        const answer = outcomes[awaits] ?? null;
        awaits += 1;
        return successful(loginAnswer(answer));
      }
      if (method === "providers.cancelLogin")
        return successful({ cancelled: true });
      if (method === "environment.move.stop") return successful(stopped());
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );

    async function startRow(profileId: string): Promise<void> {
      fireEvent.click(
        within(
          screen.getByTestId(`personal-leave-codex-${profileId}`),
        ).getByRole("button", { name: "Sign in" }),
      );
      screen.getByRole("heading", { name: "Add a profile" });
      const loginSettled = mutationSettledCountEvent(
        harness.queryClient,
        providersMutationKeys.awaitLogin(),
        1,
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        await loginSettled;
      });
    }

    screen.getByTestId("personal-leave-codex-mismatch");
    await startRow("mismatch");
    expect(screen.getByText(differentAccountText("Work"))).toBeTruthy();
    await startRow("unproven");
    expect(screen.getByText(SIGN_IN_UNPROVEN_TEXT)).toBeTruthy();
    expect(screen.getByText(profileNotChangedText("Home"))).toBeTruthy();
    await startRow("unfinished");
    expect(
      screen.getByText("Sign-in did not finish. Retry when you are ready."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Add a profile" })).toBeNull();
    await startRow("removed");
    expect(screen.getByText("Was removed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("heading", { name: "Add a profile" })).toBeNull();

    for (const row of rows) {
      fireEvent.click(
        within(
          screen.getByTestId(`personal-leave-codex-${row.profileId}`),
        ).getByRole("button", { name: "Skip" }),
      );
    }
    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stopComplete;
    });
    screen.getByTestId("stop-complete");
    expect(
      harness.relay.unaryRequests.find(
        (request) => request.method === "environment.move.stop",
      )?.params,
    ).toEqual({
      choices: [],
      profileMode: "keep-personal",
      profileSignIns: rows.map((row) => ({
        providerId: "codex",
        profileId: row.profileId,
        signIn: { kind: "skip" },
      })),
    });
    expect(harness.relay.errors).toEqual([]);
  });

  it("releases the held staging handle when the leave sheet is dismissed", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(preview([FOLDER("folder-one", "Work", "offered")]));
      if (method === "providers.list") return successful(providerList([]));
      if (method === "providers.startLogin")
        return successful(started("held-admission", null));
      if (method === "providers.awaitLogin")
        return successful(staged("folder-one"));
      if (method === "providers.cancelLogin")
        return successful({ cancelled: true });
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );

    screen.getByTestId("personal-leave-codex-folder-one");
    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Sign in" },
      ),
    );
    const loginSettled = providerAwaitLoginSettledEvent(harness.queryClient);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await loginSettled;
    });
    expect(screen.getByText("Signed in")).toBeTruthy();
    const cancelled = mutationSettledCountEvent(
      harness.queryClient,
      providersMutationKeys.cancelLogin(),
      1,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-keep"));
      await cancelled;
    });
    expect(
      harness.relay.unaryRequests.find(
        (request) => request.method === "providers.cancelLogin",
      )?.params,
    ).toEqual({
      providerId: "codex",
      profileId: "held-admission",
      holderId: null,
    });
  });

  it.each([
    {
      name: "an own sign-in row, in both sentences",
      row: FOLDER("folder-one", "Work", "offered"),
      toast:
        "The sign-in for Work wasn't kept. It works until Codex asks for a new sign-in.",
    },
    {
      name: "a shared row, in one sentence",
      row: SHARED_FOLDER("folder-one", "Work"),
      toast: "The sign-in for Work wasn't kept.",
    },
  ])(
    "reports when Stop could not keep a staged sign-in of $name",
    async ({ row, toast }) => {
      const harness = makeHarness(({ method }) => {
        if (method === "environment.move.stopPreview")
          return successful(preview([row]));
        if (method === "providers.list") return successful(providerList([]));
        if (method === "providers.startLogin")
          return successful(started("held-admission", null));
        if (method === "providers.awaitLogin")
          return successful(staged("folder-one"));
        if (method === "environment.move.stop")
          return successful({
            outcome: "stopped",
            profileResults: [
              {
                providerId: "codex",
                profileId: "folder-one",
                signIn: "installation-failed",
              },
            ],
          });
        return failed("E_UNEXPECTED", `unexpected method: ${method}`);
      });
      await renderSession(
        harness.client,
        {
          showListAfterStop: false,
          showToaster: true,
        },
        null,
      );

      screen.getByTestId("personal-leave-codex-folder-one");
      fireEvent.click(
        within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
          "button",
          { name: "Sign in" },
        ),
      );
      const loginSettled = providerAwaitLoginSettledEvent(harness.queryClient);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        await loginSettled;
      });
      expect(screen.getByText("Signed in")).toBeTruthy();
      const stoppedEvent = moveStopOutcomeEvent(harness.queryClient, "stopped");
      await act(async () => {
        fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
        await stoppedEvent;
      });
      expect(screen.getByText(toast)).toBeTruthy();
      expect(harness.relay.errors).toEqual([]);
    },
  );
});

describe("provider metadata retry after an initial read failure", () => {
  it("does not poll after the metadata error, then retries only on the explicit button", async () => {
    vi.useFakeTimers();
    let listCalls = 0;
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.move.stopPreview": () =>
          preview([FOLDER("folder-one", "Work", "offered")]),
        "providers.list": () => {
          listCalls += 1;
          if (listCalls === 1) throw new Error("temporary metadata failure");
          return providerList([]);
        },
        "environment.move.stop": () => stopped(),
      },
    });
    recordNegotiatedHostManifest(
      HOST_ID,
      buildConnectionManifest(hostRpcRegistry, SERVES_EVERY_INSTALLED_MAJOR),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: 2, retryDelay: 100 },
        mutations: { retry: false },
      },
    });
    extraQueryClients.push(queryClient);
    const previewSettled = hostQuerySettledEvent(
      queryClient,
      "environment.move.stopPreview",
    );
    mountSession(
      client,
      queryClient,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );
    await act(async () => {
      await previewSettled;
    });
    expect(screen.getByTestId("personal-leave-codex-folder-one")).toBeTruthy();
    const initialListError = hostQueryStatusEvent(
      queryClient,
      "providers.list",
      "error",
    );
    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Sign in" },
      ),
    );
    await act(async () => {
      await initialListError;
    });
    expect(screen.getByText("Couldn't load provider state.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(listCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(listCalls).toBe(1);

    const retriedList = nextQuerySettlementEvent(
      queryClient,
      hostQueryKeys.method<HostRpcRegistry, "providers.list">(
        HOST_ID,
        "providers.list",
        { native: null },
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await retriedList;
    });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(listCalls).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Add a profile" })).toBeNull();
    expect(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Skip" },
      ),
    ).toBeTruthy();
    const stoppedEvent = moveStopOutcomeEvent(queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stoppedEvent;
    });
    expect(screen.queryByTestId("stop-sharing-sheet")).toBeNull();
    expect(listCalls).toBe(2);
  });
});

describe("Skip at Stop sharing removes only a shared account", () => {
  const renderOptions = { showListAfterStop: false, showToaster: false };

  function rowOf(profileId: string): HTMLElement {
    return screen.getByTestId(`personal-leave-codex-${profileId}`);
  }

  it("says a skipped shared row is not kept and an own sign-in row keeps working, and sends skip for both", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(
          preview([
            SHARED_FOLDER("shared-one", "Shared"),
            FOLDER("own-one", "Own", "offered"),
            FOLDER("key-one", "Key", "not-needed"),
          ]),
        );
      if (method === "providers.list") return successful(providerList([]));
      if (method === "environment.move.stop") return successful(stopped());
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    await renderSession(harness.client, renderOptions, null);

    screen.getByTestId("personal-leave-codex-shared-one");
    expect(screen.queryByText(SKIPPED_SHARED)).toBeNull();
    fireEvent.click(
      within(rowOf("shared-one")).getByRole("button", { name: "Skip" }),
    );
    fireEvent.click(
      within(rowOf("own-one")).getByRole("button", { name: "Skip" }),
    );

    expect(within(rowOf("shared-one")).getByText(SKIPPED_SHARED)).toBeTruthy();
    expect(within(rowOf("shared-one")).queryByText(/Works until/)).toBeNull();
    expect(
      within(rowOf("own-one")).getByText(
        "Skipped. Works until Codex asks for a new sign-in.",
      ),
    ).toBeTruthy();
    expect(within(rowOf("own-one")).queryByText(SKIPPED_SHARED)).toBeNull();
    expect(within(rowOf("key-one")).queryByText(SKIPPED_SHARED)).toBeNull();

    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stopComplete;
    });
    screen.getByTestId("stop-complete");
    expect(stopRequests(harness)).toEqual([
      {
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "shared-one",
            signIn: { kind: "skip" },
          },
          {
            providerId: "codex",
            profileId: "own-one",
            signIn: { kind: "skip" },
          },
        ],
      },
    ]);
    expect(harness.relay.errors).toEqual([]);
  });

  it("sends untouched, never skip, for an offered row nobody answered, and again after Undo", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(
          preview([
            SHARED_FOLDER("shared-one", "Shared"),
            SHARED_FOLDER("shared-two", "Second shared"),
            FOLDER("own-one", "Own", "offered"),
          ]),
        );
      if (method === "providers.list") return successful(providerList([]));
      if (method === "environment.move.stop") return successful(stopped());
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    await renderSession(harness.client, renderOptions, null);

    screen.getByTestId("personal-leave-codex-shared-one");
    fireEvent.click(
      within(rowOf("shared-two")).getByRole("button", { name: "Skip" }),
    );
    expect(within(rowOf("shared-two")).getByText(SKIPPED_SHARED)).toBeTruthy();
    fireEvent.click(
      within(rowOf("shared-two")).getByRole("button", { name: "Undo" }),
    );
    expect(screen.queryByText(SKIPPED_SHARED)).toBeNull();

    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stopComplete;
    });
    screen.getByTestId("stop-complete");
    expect(stopRequests(harness)).toEqual([
      {
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: ["shared-one", "shared-two", "own-one"].map(
          (profileId) => ({
            providerId: "codex",
            profileId,
            signIn: { kind: "untouched" },
          }),
        ),
      },
    ]);
    expect(harness.relay.errors).toEqual([]);
  });

  it("gives a host that still serves Preview 1.2 and Stop 1.1 the legacy sheet, whose Skip would remove nothing", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(preview(null));
      if (method === "environment.move.stop") return successful(stopped());
      if (method === "providers.list") return successful(providerList([]));
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    setAdvertisedMethodVersion(harness.relay, "environment.move.stopPreview", {
      major: 1,
      minor: 2,
    });
    setAdvertisedMethodVersion(harness.relay, "environment.move.stop", {
      major: 1,
      minor: 1,
    });
    await renderSession(harness.client, renderOptions, null);

    screen.getByTestId("stop-sharing-managed-empty");
    expect(screen.queryByTestId("personal-leave-accounts")).toBeNull();
    const stopComplete = moveStopOutcomeEvent(harness.queryClient, "stopped");
    await act(async () => {
      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await stopComplete;
    });
    screen.getByTestId("stop-complete");
    expect(
      harness.relay.unaryRequests
        .filter((request) => request.method === "environment.move.stopPreview")
        .map((request) => request.params),
    ).not.toContainEqual({ profileMode: "keep-personal" });
    expect(stopRequests(harness)).toEqual([
      { choices: [], profileMode: null, profileSignIns: [] },
    ]);
    expect(requestCount(harness.relay, "providers.list")).toBe(0);
    expect(harness.relay.errors).toEqual([]);
  });
});

describe("RemoteSession rechecks the leave floors after reconnect", () => {
  it.each([
    {
      label: "the Preview 1.3 floor",
      method: "environment.move.stopPreview",
      version: { major: 1, minor: 2 },
      requirement: {
        method: "environment.move.stopPreview",
        version: { major: 1, minor: 3 },
      },
    },
    {
      label: "the separate targeted Await 2.4 prerequisite",
      method: "providers.awaitLogin",
      version: { major: 2, minor: 3 },
      requirement: {
        method: "providers.awaitLogin",
        version: { major: 2, minor: 4 },
      },
    },
  ] as const)(
    "preflight-refuses the retained keep-mode Preview when $label is withdrawn",
    async ({ method, version, requirement }) => {
      const harness = makeHarness(({ method: requestMethod }) => {
        if (requestMethod === "environment.move.stopPreview")
          return successful(preview([]));
        if (requestMethod === "providers.list")
          return successful(providerList([]));
        return failed("E_UNEXPECTED", `unexpected method: ${requestMethod}`);
      });
      cacheProvidersList(harness, []);
      await renderSession(
        harness.client,
        {
          showListAfterStop: false,
          showToaster: false,
        },
        null,
      );
      screen.getByTestId("stop-sharing-managed-empty");
      const keepPreviewKey = hostQueryKeys.method<
        HostRpcRegistry,
        "environment.move.stopPreview"
      >(HOST_ID, "environment.move.stopPreview", {
        profileMode: "keep-personal",
      });
      expect(harness.queryClient.getQueryData(keepPreviewKey)).toEqual(
        preview([]),
      );
      expect(harness.observedHostRequests).toContainEqual({
        method: "environment.move.stopPreview",
        params: { profileMode: "keep-personal" },
        requiredHostMethodVersion: {
          method: "environment.move.stopPreview",
          version: { major: 1, minor: 3 },
        },
      });

      cleanup();
      await redialAtAdvertisedFloor(harness, method, version);
      const previewCallsBeforeRetry = requestCount(
        harness.relay,
        "environment.move.stopPreview",
      );
      const hostCallsBeforeRetry = harness.observedHostRequests.length;
      await harness.queryClient.refetchQueries({
        queryKey: keepPreviewKey,
        type: "all",
      });
      const refusal = harness.queryClient.getQueryState(keepPreviewKey)?.error;
      expect(refusal).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
      expect(refusal).toMatchObject({ requirement, negotiated: version });
      expect(requestCount(harness.relay, "environment.move.stopPreview")).toBe(
        previewCallsBeforeRetry,
      );
      expect(harness.observedHostRequests).toHaveLength(hostCallsBeforeRetry);
      expect(harness.queryClient.getQueryData(keepPreviewKey)).toEqual(
        preview([]),
      );
    },
  );

  it("refuses Stop below 1.2 on the redialed connection through the real sheet mutation", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview") {
        return successful(preview([]));
      }
      if (method === "environment.move.stop") return successful(stopped());
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    cacheProvidersList(harness, []);
    await renderSession(
      harness.client,
      {
        showListAfterStop: false,
        showToaster: false,
      },
      null,
    );
    screen.getByTestId("stop-sharing-managed-empty");
    harness.armFloorDowngrade("environment.move.stop", {
      major: 1,
      minor: 1,
    });

    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    await expectFloorRefusalAfterReconnect(harness, {
      method: "environment.move.stop",
      version: { major: 1, minor: 2 },
    });
    expect(harness.capturedFloorCalls).toEqual([
      {
        method: "environment.move.stop",
        params: {
          choices: [],
          profileMode: "keep-personal",
          profileSignIns: [],
          sheetDigest: null,
        },
      },
    ]);
    expect(screen.getByTestId("stop-sharing-sheet")).toBeTruthy();
    const legacyPreviewKey = hostQueryKeys.method<
      HostRpcRegistry,
      "environment.move.stopPreview"
    >(HOST_ID, "environment.move.stopPreview", { profileMode: null });
    const legacyPreview = queryDataEvent<EnvironmentMoveStopPreviewResponseV14>(
      harness.queryClient,
      legacyPreviewKey,
      () => true,
    );
    await act(async () => {
      await legacyPreview;
    });
    expect(
      harness.relay.unaryRequests.some(
        (request, index) =>
          harness.relay.unaryRequestConnectionIds[index] === 1 &&
          request.method === "environment.move.stopPreview" &&
          JSON.stringify(request.params) ===
            JSON.stringify({ profileMode: null }),
      ),
    ).toBe(true);
    expect(
      harness.relay.unaryRequests.some(
        (request, index) =>
          harness.relay.unaryRequestConnectionIds[index] === 1 &&
          request.method === "environment.move.stop",
      ),
    ).toBe(false);
  });

  it("refuses targeted Start below 1.5 on the redialed connection through the real Add dialog", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "providers.cancelLogin")
        return successful({ cancelled: true });
      if (method === "providers.list") return successful(providerList([]));
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    const ready = nextAvailabilityRecovered(harness.session);
    harness.session.start();
    await ready;
    mountLeaveTargetAddDialog(harness, "folder-one");
    const addDialog = screen.getByRole("dialog", {
      name: "Add a profile",
    });
    const signIn = within(addDialog).getByRole("button", {
      name: "Sign in",
    });
    harness.armFloorDowngrade("providers.startLogin", {
      major: 1,
      minor: 4,
    });

    fireEvent.click(signIn);
    await expectFloorRefusalAfterReconnect(harness, {
      method: "providers.startLogin",
      version: { major: 1, minor: 5 },
    });
    expect(harness.capturedFloorCalls).toHaveLength(1);
    expect(harness.capturedFloorCalls[0]).toMatchObject({
      method: "providers.startLogin",
      params: {
        target: { kind: "leave-to-local", profileId: "folder-one" },
      },
    });
    expect(
      harness.relay.unaryRequests.some(
        (request, index) =>
          harness.relay.unaryRequestConnectionIds[index] === 1 &&
          request.method === "providers.startLogin",
      ),
    ).toBe(false);
    expect(screen.getByRole("dialog", { name: "Add a profile" })).toBeTruthy();
    expect(requestCount(harness.relay, "providers.list")).toBe(0);
  });

  it("refuses targeted Await below 2.4 on the redialed connection through the real Add dialog", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "providers.startLogin")
        return successful(started("admission-one", null));
      if (method === "providers.awaitLogin")
        return successful(staged("folder-one"));
      if (method === "providers.cancelLogin")
        return successful({ cancelled: true });
      if (method === "providers.list") return successful(providerList([]));
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    const ready = nextAvailabilityRecovered(harness.session);
    harness.session.start();
    await ready;
    mountLeaveTargetAddDialog(harness, "folder-one");
    const addDialog = screen.getByRole("dialog", {
      name: "Add a profile",
    });
    const signIn = within(addDialog).getByRole("button", {
      name: "Sign in",
    });
    harness.armFloorDowngrade("providers.awaitLogin", {
      major: 2,
      minor: 3,
    });

    fireEvent.click(signIn);
    await expectFloorRefusalAfterReconnect(harness, {
      method: "providers.awaitLogin",
      version: { major: 2, minor: 4 },
    });
    expect(harness.capturedFloorCalls).toHaveLength(1);
    expect(harness.capturedFloorCalls[0]?.method).toBe("providers.awaitLogin");
    const startRequest = harness.relay.unaryRequests.find(
      (request) => request.method === "providers.startLogin",
    );
    expect(startRequest?.params).toMatchObject({
      target: { kind: "leave-to-local", profileId: "folder-one" },
    });
    expect(
      harness.relay.unaryRequests.some(
        (request, index) =>
          harness.relay.unaryRequestConnectionIds[index] === 1 &&
          request.method === "providers.awaitLogin",
      ),
    ).toBe(false);
    expect(screen.getByRole("dialog", { name: "Add a profile" })).toBeTruthy();
    expect(requestCount(harness.relay, "providers.list")).toBe(0);
  });

  it("carries a null-outcome reader wait through to a staged leave result", async () => {
    let awaitCalls = 0;
    const waitingForReaders: AwaitLogin = {
      ...loginAnswer(null),
      installation: {
        kind: "waiting-for-readers",
        admissionId: "admission-one",
        count: 2,
      },
    };
    const harness = makeHarness(({ method }) => {
      if (method === "providers.startLogin")
        return successful(started("admission-one", null));
      if (method === "providers.awaitLogin") {
        awaitCalls += 1;
        return successful(
          awaitCalls === 1 ? waitingForReaders : staged("folder-one"),
        );
      }
      if (method === "providers.cancelLogin")
        return successful({ cancelled: true });
      if (method === "providers.list") return successful(providerList([]));
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    const ready = nextAvailabilityRecovered(harness.session);
    harness.session.start();
    await ready;
    mountLeaveTargetAddDialog(harness, "folder-one");
    const addDialog = screen.getByRole("dialog", {
      name: "Add a profile",
    });
    const awaitLoginTwice = mutationSettledCountEvent(
      harness.queryClient,
      providersMutationKeys.awaitLogin(),
      2,
    );
    await act(async () => {
      fireEvent.click(
        within(addDialog).getByRole("button", { name: "Sign in" }),
      );
      await awaitLoginTwice;
    });

    expect(screen.getByText("staged-for-leave")).toBeTruthy();
    expect(awaitCalls).toBe(2);
    expect(requestCount(harness.relay, "providers.list")).toBe(0);
    const providerListKey = hostQueryKeys.method<
      HostRpcRegistry,
      "providers.list"
    >(HOST_ID, "providers.list", { native: null });
    expect(harness.queryClient.getQueryData(providerListKey)).toBeUndefined();
  });
});
