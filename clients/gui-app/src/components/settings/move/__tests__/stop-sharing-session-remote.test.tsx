import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  EnvironmentMoveStopPreviewResponseV12,
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
import { hostQueryKeys } from "@/lib/query-keys";

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
});

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
  return Object.fromEntries(
    Object.entries(manifest).map(([method, version]) => [
      method,
      { major: version.major, minor: version.minor },
    ]),
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
    bearer: () => lease,
    auth: null,
    sessionGrant: null,
    clock: null,
    rpcRegistry: hostRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `leave-${String((nextRequestId += 1))}`,
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
    livenessProbe: null,
    mintMemberCredential: null,
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
    relay.dropCurrentConnection();
    return true;
  };
  const messenger: IHostMessenger<HostRpcRegistry> = {
    async request<Method extends HostMethod>(
      method: Method,
      params: RequestOfMethod<HostRpcRegistry, Method>,
      options: HostRequestOptions,
    ): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
      observedHostRequests.push({
        method,
        params,
        requiredHostMethodVersion: options.requiredHostMethodVersion,
      });
      const downgraded = applyFloorDowngrade(method, params, options);
      if (downgraded) {
        await vi.waitFor(() => {
          expect(relay.openBearers).toHaveLength(2);
          expect(session.isReady()).toBe(true);
        });
      }
      try {
        return await remoteMessenger.request(method, params, options);
      } catch (error: unknown) {
        if (downgraded) capturedFloorErrors.push(error);
        throw error;
      }
    },
    async requestWithResponseTimeout<Method extends HostMethod>(
      method: Method,
      params: RequestOfMethod<HostRpcRegistry, Method>,
      responseTimeoutMs: number,
      options: HostRequestOptions,
    ): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
      observedHostRequests.push({
        method,
        params,
        requiredHostMethodVersion: options.requiredHostMethodVersion,
      });
      const downgraded = applyFloorDowngrade(method, params, options);
      if (downgraded) {
        await vi.waitFor(() => {
          expect(relay.openBearers).toHaveLength(2);
          expect(session.isReady()).toBe(true);
        });
      }
      try {
        return await remoteMessenger.requestWithResponseTimeout(
          method,
          params,
          responseTimeoutMs,
          options,
        );
      } catch (error: unknown) {
        if (downgraded) capturedFloorErrors.push(error);
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
): EnvironmentMoveStopPreviewResponseV12 {
  const base = { managed: [], needsChoice: [] };
  return profiles === undefined
    ? base
    : { ...base, personalProfiles: profiles === null ? null : [...profiles] };
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

async function renderSession(
  client: HostClient<HostRpcRegistry>,
  options: {
    readonly showListAfterStop: boolean;
    readonly showToaster: boolean;
  },
): Promise<void> {
  const harness = harnesses.find((harness) => harness.client === client);
  if (harness === undefined) throw new Error("expected a test query client");
  harness.session.start();
  await vi.waitFor(() => expect(harness.session.isReady()).toBe(true));
  mountSession(client, harness.queryClient, options);
}

async function redialAtAdvertisedFloor(
  harness: RemoteHarness,
  method: HostMethod,
  version: HostVersion,
): Promise<void> {
  setAdvertisedMethodVersion(harness.relay, method, version);
  harness.relay.dropCurrentConnection();
  await vi.waitFor(() => expect(harness.relay.openBearers).toHaveLength(2));
  await vi.waitFor(() => expect(harness.session.isReady()).toBe(true));
}

function mountSession(
  client: HostClient<HostRpcRegistry>,
  queryClient: QueryClient,
  options: {
    readonly showListAfterStop: boolean;
    readonly showToaster: boolean;
  },
): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SessionView
        client={client}
        showListAfterStop={options.showListAfterStop}
        showToaster={options.showToaster}
      />
    </QueryClientProvider>,
  );
}

function mountLeaveTargetAddDialog(
  harness: RemoteHarness,
  profileId: string,
): void {
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
  await vi.waitFor(() => expect(harness.capturedFloorErrors).toHaveLength(1));
  await vi.waitFor(() => expect(harness.session.isReady()).toBe(true));
  expect(harness.capturedFloorErrors[0]).toBeInstanceOf(
    HostMethodVersionUnsatisfiedError,
  );
  expect(harness.relay.openBearers).toHaveLength(2);
  expect(harness.capturedFloorRequirements).toEqual([requirement]);
  expect(harness.relay.errors).toEqual([]);
}

describe("StopSharingSession over the real remote session", () => {
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
      await renderSession(harness.client, {
        showListAfterStop: false,
        showToaster: false,
      });

      expect(await screen.findByTestId("stop-sharing-sheet")).toBeTruthy();
      expect(
        screen.getByRole("heading", {
          name: "Stop using Personal on this computer",
        }),
      ).toBeTruthy();
      await waitFor(() => {
        expect(
          harness.relay.unaryRequests.find(
            (request) => request.method === "environment.move.stopPreview",
          )?.params,
        ).toEqual({ profileMode: "keep-personal" });
      });
      await screen.findByTestId("stop-sharing-managed-empty");
      expect(requestCount(harness.relay, "providers.list")).toBe(0);

      fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
      await waitFor(() =>
        expect(requestCount(harness.relay, "environment.move.stop")).toBe(1),
      );
      const stop = harness.relay.unaryRequests.find(
        (request) => request.method === "environment.move.stop",
      );
      expect(stop?.params).toEqual({
        choices: [],
        profileMode: null,
        profileSignIns: [],
      });
      expect(await screen.findByTestId("stop-complete")).toBeTruthy();
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
    await renderSession(harness.client, {
      showListAfterStop: false,
      showToaster: false,
    });

    expect(await screen.findByTestId("stop-sharing-sheet")).toBeTruthy();
    await screen.findByTestId("stop-sharing-managed-empty");
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    await waitFor(() =>
      expect(requestCount(harness.relay, "environment.move.stop")).toBe(1),
    );
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
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview") {
        previews += 1;
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
    await renderSession(harness.client, {
      showListAfterStop: false,
      showToaster: false,
    });

    await vi.waitFor(() =>
      expect(
        screen.getByTestId("personal-leave-codex-folder-one"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    await waitFor(() =>
      expect(requestCount(harness.relay, "environment.move.stop")).toBe(1),
    );
    await waitFor(() =>
      expect(requestCount(harness.relay, "environment.move.stopPreview")).toBe(
        2,
      ),
    );
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
            signIn: { kind: "skip" },
          },
        ],
      },
    ]);
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    await screen.findByText("stop complete");
    await waitFor(() =>
      expect(requestCount(harness.relay, "environment.move.stop")).toBe(2),
    );
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
            signIn: { kind: "skip" },
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
    await renderSession(harness.client, {
      showListAfterStop: true,
      showToaster: false,
    });

    expect(
      await screen.findByTestId("personal-leave-codex-folder-one"),
    ).toBeTruthy();
    expect(await screen.findByText("Same account as Work")).toBeTruthy();
    expect(
      screen.getByText(
        "Sign in to each account you want to keep using on this computer, or skip it. A skipped account keeps working until Codex asks for a new sign-in.",
      ),
    ).toBeTruthy();
    expect(requestCount(harness.relay, "providers.list")).toBe(1);

    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Sign in" },
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Add a profile" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Signed in")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Add a profile" })).toBeNull();

    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-two")).getByRole(
        "button",
        { name: "Skip" },
      ),
    );
    expect(
      await screen.findByText(
        "Skipped. Works until Codex asks for a new sign-in.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));

    expect(await screen.findByText("Work, Home")).toBeTruthy();
    await waitFor(() =>
      expect(requestCount(harness.relay, "providers.list")).toBe(2),
    );
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
    await renderSession(harness.client, {
      showListAfterStop: false,
      showToaster: false,
    });

    expect(
      await screen.findByTestId("stop-sharing-managed-empty"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(requestCount(harness.relay, "providers.list")).toBe(1),
    );
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    await screen.findByTestId("stop-complete");
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
    await renderSession(harness.client, {
      showListAfterStop: false,
      showToaster: false,
    });

    expect(
      await screen.findByTestId("personal-leave-codex-folder-two"),
    ).toBeTruthy();
    expect(screen.queryByText("Same account as Work")).toBeNull();
    expect(requestCount(harness.relay, "providers.list")).toBe(0);
    const guidance = Array.from(
      screen.getByTestId("personal-leave-accounts").querySelectorAll("p"),
    )
      .map((paragraph) => paragraph.textContent)
      .filter((text) => text.startsWith("Sign in to each account"));
    expect(guidance).toEqual([
      "Sign in to each account you want to keep using on this computer, or skip it. A skipped account keeps working until Codex asks for a new sign-in.",
    ]);
  });

  it("shows one guidance paragraph per offered provider in first-row order", async () => {
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
    await renderSession(harness.client, {
      showListAfterStop: false,
      showToaster: false,
    });

    await screen.findByTestId("personal-leave-accounts");
    const guidance = Array.from(
      screen.getByTestId("personal-leave-accounts").querySelectorAll("p"),
    )
      .map((paragraph) => paragraph.textContent)
      .filter((text) => text.startsWith("Sign in to each account"));
    expect(guidance).toEqual([
      "Sign in to each account you want to keep using on this computer, or skip it. A skipped account keeps working until Codex asks for a new sign-in.",
      "Sign in to each account you want to keep using on this computer, or skip it. A skipped account keeps working until Claude Code asks for a new sign-in.",
    ]);
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
    await renderSession(harness.client, {
      showListAfterStop: false,
      showToaster: false,
    });

    async function startRow(profileId: string): Promise<void> {
      fireEvent.click(
        within(
          screen.getByTestId(`personal-leave-codex-${profileId}`),
        ).getByRole("button", { name: "Sign in" }),
      );
      await screen.findByRole("heading", { name: "Add a profile" });
      fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    }

    await screen.findByTestId("personal-leave-codex-mismatch");
    await startRow("mismatch");
    expect(await screen.findByText(differentAccountText("Work"))).toBeTruthy();
    await startRow("unproven");
    expect(await screen.findByText(SIGN_IN_UNPROVEN_TEXT)).toBeTruthy();
    expect(screen.getByText(profileNotChangedText("Home"))).toBeTruthy();
    await startRow("unfinished");
    expect(
      await screen.findByText(
        "Sign-in did not finish. Retry when you are ready.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Add a profile" }),
      ).toBeNull(),
    );
    await startRow("removed");
    expect(await screen.findByText("Was removed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Add a profile" }),
      ).toBeNull(),
    );

    for (const row of rows) {
      fireEvent.click(
        within(
          screen.getByTestId(`personal-leave-codex-${row.profileId}`),
        ).getByRole("button", { name: "Skip" }),
      );
    }
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    await screen.findByTestId("stop-complete");
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
    await renderSession(harness.client, {
      showListAfterStop: false,
      showToaster: false,
    });

    await screen.findByTestId("personal-leave-codex-folder-one");
    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Sign in" },
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Signed in")).toBeTruthy();
    fireEvent.click(screen.getByTestId("stop-sharing-keep"));

    await waitFor(() =>
      expect(requestCount(harness.relay, "providers.cancelLogin")).toBe(1),
    );
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

  it("reports when Stop could not keep a staged sign-in", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview")
        return successful(preview([FOLDER("folder-one", "Work", "offered")]));
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
    await renderSession(harness.client, {
      showListAfterStop: false,
      showToaster: true,
    });

    await screen.findByTestId("personal-leave-codex-folder-one");
    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Sign in" },
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Signed in")).toBeTruthy();
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));

    expect(
      await screen.findByText(
        "The sign-in for Work wasn't kept. It works until Codex asks for a new sign-in.",
      ),
    ).toBeTruthy();
    expect(harness.relay.errors).toEqual([]);
  });
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
    mountSession(client, queryClient, {
      showListAfterStop: false,
      showToaster: false,
    });

    await vi.waitFor(() =>
      expect(
        screen.getByTestId("personal-leave-codex-folder-one"),
      ).toBeTruthy(),
    );
    fireEvent.click(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Sign in" },
      ),
    );
    await vi.waitFor(() =>
      expect(screen.getByText("Couldn't load provider state.")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(listCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(listCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy(),
    );
    expect(listCalls).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Add a profile" }),
      ).toBeNull(),
    );
    expect(
      within(screen.getByTestId("personal-leave-codex-folder-one")).getByRole(
        "button",
        { name: "Skip" },
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    await vi.waitFor(() =>
      expect(screen.queryByTestId("stop-sharing-sheet")).toBeNull(),
    );
    expect(listCalls).toBe(2);
  });
});

describe("RemoteSession rechecks the leave floors after reconnect", () => {
  it.each([
    {
      label: "the Preview 1.2 floor",
      method: "environment.move.stopPreview",
      version: { major: 1, minor: 1 },
      requirement: {
        method: "environment.move.stopPreview",
        version: { major: 1, minor: 2 },
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
      await renderSession(harness.client, {
        showListAfterStop: false,
        showToaster: false,
      });
      await screen.findByTestId("stop-sharing-managed-empty");
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
          version: { major: 1, minor: 2 },
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

  it("refuses Stop below 1.1 on the redialed connection through the real sheet mutation", async () => {
    const harness = makeHarness(({ method }) => {
      if (method === "environment.move.stopPreview") {
        return successful(preview([]));
      }
      if (method === "environment.move.stop") return successful(stopped());
      return failed("E_UNEXPECTED", `unexpected method: ${method}`);
    });
    cacheProvidersList(harness, []);
    await renderSession(harness.client, {
      showListAfterStop: false,
      showToaster: false,
    });
    await screen.findByTestId("stop-sharing-managed-empty");
    harness.armFloorDowngrade("environment.move.stop", {
      major: 1,
      minor: 0,
    });

    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));
    await expectFloorRefusalAfterReconnect(harness, {
      method: "environment.move.stop",
      version: { major: 1, minor: 1 },
    });
    expect(harness.capturedFloorCalls).toEqual([
      {
        method: "environment.move.stop",
        params: {
          choices: [],
          profileMode: "keep-personal",
          profileSignIns: [],
        },
      },
    ]);
    expect(screen.getByTestId("stop-sharing-sheet")).toBeTruthy();
    await vi.waitFor(() =>
      expect(
        harness.relay.unaryRequests.some(
          (request, index) =>
            harness.relay.unaryRequestConnectionIds[index] === 1 &&
            request.method === "environment.move.stopPreview" &&
            JSON.stringify(request.params) ===
              JSON.stringify({ profileMode: null }),
        ),
      ).toBe(true),
    );
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
    harness.session.start();
    await vi.waitFor(() => expect(harness.session.isReady()).toBe(true));
    mountLeaveTargetAddDialog(harness, "folder-one");
    const addDialog = await screen.findByRole("dialog", {
      name: "Add a profile",
    });
    const signIn = await within(addDialog).findByRole("button", {
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
    harness.session.start();
    await vi.waitFor(() => expect(harness.session.isReady()).toBe(true));
    mountLeaveTargetAddDialog(harness, "folder-one");
    const addDialog = await screen.findByRole("dialog", {
      name: "Add a profile",
    });
    const signIn = await within(addDialog).findByRole("button", {
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
    harness.session.start();
    await vi.waitFor(() => expect(harness.session.isReady()).toBe(true));
    mountLeaveTargetAddDialog(harness, "folder-one");
    const addDialog = await screen.findByRole("dialog", {
      name: "Add a profile",
    });
    fireEvent.click(
      await within(addDialog).findByRole("button", { name: "Sign in" }),
    );

    expect(await screen.findByText("staged-for-leave")).toBeTruthy();
    expect(awaitCalls).toBe(2);
    expect(requestCount(harness.relay, "providers.list")).toBe(0);
    const providerListKey = hostQueryKeys.method<
      HostRpcRegistry,
      "providers.list"
    >(HOST_ID, "providers.list", { native: null });
    expect(harness.queryClient.getQueryData(providerListKey)).toBeUndefined();
  });
});
