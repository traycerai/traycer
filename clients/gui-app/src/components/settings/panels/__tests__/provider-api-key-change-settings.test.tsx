import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  cleanup,
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import type { ExternalToast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  providerMutationCliStateSchemaV21,
  providersBeginApiKeyChangeResponseSchema,
  providersSetApiKeyResponseSchema,
  providersSettleApiKeyChangeResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  HostClient,
  type IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { hostV115MutationV20Fixtures } from "@traycer/protocol/host/__tests__/__fixtures__/host-v1.1.5-mutation-v20";
import type { AuthService } from "@/lib/auth/auth-service";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { hostQueryKeys } from "@/lib/query-keys";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";
import {
  apiKeyState,
  storedApiKeyState,
} from "./provider-api-key-section-fixture";
import { takeProviderApiKeyInput } from "@/hooks/providers/provider-api-key-input";
import { useProvidersSetApiKey } from "@/hooks/providers/use-providers-set-api-key-mutation";
import {
  createVerifiedTeamAuthService,
  resetTeamPageHarness,
  teamProviderKeyHttpBoundary,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  installSignInRequestFetchHarness,
  type SignInRequestFetchHarness,
} from "@traycer-clients/shared/test-fixtures/provider-sign-in-request-test-support";

type ToastErrorCall = (
  message: ReactNode,
  options: ExternalToast | undefined,
) => string;

const mocks = vi.hoisted(() => ({
  hostClient: vi.fn<() => HostClient<typeof hostRpcRegistry>>(),
  authService: vi.fn<() => AuthService>(),
  openLink: vi.fn(),
  toastError: vi.fn<ToastErrorCall>(),
  analyticsTrack: vi.fn(),
  analyticsIdentify: vi.fn(),
  analyticsReset: vi.fn(),
  mobileApp: false,
  mobilePlatform: "ios" as "ios" | "android" | null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<typeof hostRpcRegistry> => mocks.hostClient(),
    useAuthService: (): AuthService => mocks.authService(),
  };
});

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));

vi.mock("@/lib/mobile-app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile-app")>();
  return {
    ...actual,
    isMobileApp: () => mocks.mobileApp,
    getMobileAppPlatform: () => mocks.mobilePlatform,
  };
});

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: { ...actual.toast, error: mocks.toastError },
  };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    Analytics: {
      getInstance: () => ({
        track: mocks.analyticsTrack,
        identify: mocks.analyticsIdentify,
        reset: mocks.analyticsReset,
      }),
    },
  };
});

const API_KEY = "synthetic-provider-key";
const ENVIRONMENT_ID = "env-a";
const EXPECTED_ENVIRONMENT_ID = "env-expected";
const STATE = providerMutationCliStateSchemaV21.parse({
  ...hostV115MutationV20Fixtures.minimalStatesByProviderId.codex,
  profiles: [],
});
const BEGIN_RESPONSE = providersBeginApiKeyChangeResponseSchema.parse({
  mode: "record",
  changeToken: "opaque-change-token",
  environmentId: ENVIRONMENT_ID,
});

interface Rig {
  readonly client: HostClient<typeof hostRpcRegistry>;
  readonly context: RequestContext;
  readonly messenger: MockHostMessenger<typeof hostRpcRegistry>;
}

interface MutationObserverReference {
  readonly options: unknown;
}

const rigs: Rig[] = [];
const queryClients: QueryClient[] = [];
const mutationCacheUnsubscribers: Array<() => void> = [];
let authQueryClient: QueryClient | null = null;
let activeSignInFetch: SignInRequestFetchHarness | null = null;

beforeEach(async () => {
  activeSignInFetch = installSignInRequestFetchHarness();
  authQueryClient = createAppQueryClient();
  queryClients.push(authQueryClient);
  const signInFetch = activeSignInFetch;
  const authService = await createVerifiedTeamAuthService(
    authQueryClient,
    signInFetch.fetchMock,
  );
  mocks.authService.mockReturnValue(authService);
  teamProviderKeyHttpBoundary.matchesKey = (key) => key === API_KEY;
  teamProviderKeyHttpBoundary.status = 200;
  teamProviderKeyHttpBoundary.calls.length = 0;
});

function makeRig(
  result:
    | "installed"
    | "unchanged"
    | "kept-local"
    | "refused"
    | "dropped"
    | "unavailable",
  beginError: HostRpcError | null,
  settleError: HostRpcError | null,
): Rig {
  const handlers: MockHandlerMap<typeof hostRpcRegistry> = {
    "providers.beginApiKeyChange": () => {
      if (beginError !== null) throw beginError;
      return BEGIN_RESPONSE;
    },
    "providers.settleApiKeyChange": () => {
      if (settleError !== null) throw settleError;
      return providersSettleApiKeyChangeResponseSchema.parse({
        result,
        state: STATE,
      });
    },
    "providers.setApiKey": () =>
      providersSetApiKeyResponseSchema.parse({ state: STATE }),
    "providers.clearApiKey": () =>
      providersSetApiKeyResponseSchema.parse({ state: STATE }),
  };
  const messenger = new MockHostMessenger({
    registry: hostRpcRegistry,
    handlers,
    requestId: () => "request-synthetic",
  });
  const directory = new Map([[mockLocalHostEntry.hostId, mockLocalHostEntry]]);
  const invalidator: IHostQueryInvalidator = {
    invalidateHostScope: () => undefined,
  };
  const client = new HostClient({
    registry: hostRpcRegistry,
    messenger,
    invalidator,
    requestCoordinator: null,
    findHostById: (hostId) => directory.get(hostId) ?? null,
  });
  const context = createRequestContext({
    identity: identityFromAuthenticatedUser(
      createAuthenticatedUserFixture(undefined),
    ),
    bearerToken: "synthetic-session-token",
    origin: "test",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized: true,
  });
  client.setRequestContext(context);
  const requester = client.createRequesterForHostId(mockLocalHostEntry.hostId);
  mocks.hostClient.mockReturnValue(requester);
  const rig = { client, context, messenger };
  rigs.push(rig);
  return rig;
}

function hasProviderKeyRequest(
  action: "set" | "clear",
  keyMatches: boolean | null,
): boolean {
  const request = teamProviderKeyHttpBoundary.calls.at(0);
  return (
    teamProviderKeyHttpBoundary.calls.length === 1 &&
    request !== undefined &&
    request.action === action &&
    request.routeMatches &&
    request.authorized &&
    request.keyMatches === keyMatches
  );
}

function retainedObjectContainsKey(value: unknown): boolean {
  const seen = new WeakSet<object>();
  function contains(current: unknown): boolean {
    if (typeof current === "string") return current.includes(API_KEY);
    if (typeof current !== "object" || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    let values: readonly unknown[] = [];
    if (Array.isArray(current)) values = current;
    else if (isRecord(current)) values = Object.values(current);
    return values.some(contains);
  }
  return contains(value);
}

function keyInputReader(input: { current: string | null }): () => string {
  return () => takeProviderApiKeyInput(input);
}

function clearKeyInput(input: { current: string | null }): () => void {
  return () => {
    input.current = null;
  };
}

function captureMutationObservers(
  queryClient: QueryClient,
): MutationObserverReference[] {
  const observers: MutationObserverReference[] = [];
  const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === "observerAdded") observers.push(event.observer);
  });
  mutationCacheUnsubscribers.push(unsubscribe);
  return observers;
}

function mutationCacheContainsKey(
  queryClient: QueryClient,
  observers: readonly MutationObserverReference[],
): boolean {
  const mutations = queryClient.getMutationCache().getAll();
  return (
    mutations.some(
      (mutation) =>
        retainedObjectContainsKey(mutation.state) ||
        retainedObjectContainsKey(mutation.options.meta),
    ) ||
    observers.some((observer) => retainedObjectContainsKey(observer.options))
  );
}

function mutationStatesContainKey(queryClient: QueryClient): boolean {
  return queryClient
    .getMutationCache()
    .getAll()
    .some((mutation) => retainedObjectContainsKey(mutation.state));
}

function hostMethodCalls(rig: Rig, method: string): number {
  return rig.messenger.calls.filter((call) => call.method === method).length;
}

function expectRetainedMutationSurfacesClear(
  queryClient: QueryClient,
  observers: readonly MutationObserverReference[],
  hookResult: unknown,
): void {
  const mutations = queryClient.getMutationCache().getAll();
  expect(
    mutations.length > 0 &&
      observers.length > 0 &&
      !mutationCacheContainsKey(queryClient, observers) &&
      !retainedObjectContainsKey(hookResult),
  ).toBe(true);
}

interface MutationReaderReplayProof {
  readonly queryClient: QueryClient;
  readonly rig: Rig;
  readonly input: { current: string | null };
  readonly observers: readonly MutationObserverReference[];
  readonly hookResult: unknown;
}

async function expectRetainedMutationReaderSpent(
  proof: MutationReaderReplayProof,
): Promise<void> {
  const { queryClient, rig, input, observers, hookResult } = proof;
  const retainedMutation = queryClient.getMutationCache().getAll().at(-1);
  if (retainedMutation === undefined)
    throw new Error("Provider key mutation was not retained");
  const mutationFn = retainedMutation.options.mutationFn;
  if (mutationFn === undefined)
    throw new Error("Provider key mutation has no mutation function");
  const beginCount = hostMethodCalls(rig, "providers.beginApiKeyChange");
  const httpCount = teamProviderKeyHttpBoundary.calls.length;
  let inputUnavailable = false;
  try {
    await mutationFn(
      { providerId: "cursor" },
      {
        client: queryClient,
        meta: retainedMutation.options.meta,
        mutationKey: retainedMutation.options.mutationKey ?? [],
      },
    );
  } catch (error) {
    inputUnavailable =
      error instanceof Error &&
      error.message === "Provider key input is unavailable";
  }
  expect(
    inputUnavailable &&
      input.current === null &&
      hostMethodCalls(rig, "providers.beginApiKeyChange") === beginCount &&
      teamProviderKeyHttpBoundary.calls.length === httpCount &&
      teamProviderKeyHttpBoundary.calls.every(
        (call) => call.keyMatches === true,
      ) &&
      !mutationCacheContainsKey(queryClient, observers) &&
      !retainedObjectContainsKey(hookResult),
  ).toBe(true);
}

function withQueryClient(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function SettingsHarness(props: {
  readonly stored: boolean;
  readonly expectedEnvironmentId: string | null;
  readonly environmentName: string | null;
}): ReactNode {
  const [draft, setDraft] = useState(props.stored ? "" : API_KEY);
  return (
    <ProviderApiKeySection
      state={props.stored ? storedApiKeyState("cursor") : apiKeyState("cursor")}
      draft={draft}
      onDraftChange={setDraft}
      expectedEnvironmentId={props.expectedEnvironmentId}
      environmentName={props.environmentName}
    />
  );
}

function renderSettings(
  stored: boolean,
  expectedEnvironmentId: string | null,
  environmentName: string | null,
): QueryClient {
  const queryClient = createAppQueryClient();
  queryClients.push(queryClient);
  render(
    <SettingsHarness
      stored={stored}
      expectedEnvironmentId={expectedEnvironmentId}
      environmentName={environmentName}
    />,
    {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  return queryClient;
}

function apiKeyDraft(): string {
  const input = screen.getByLabelText("API key");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("API key field was not an input");
  }
  return input.value;
}

function updateRequiredError(): HostRpcError {
  return new HostRpcError({
    code: "update-required",
    message: "Update required",
    requestId: "request-synthetic",
    method: "providers.beginApiKeyChange",
    fatalDetails: null,
  });
}

function settleRequiredError(): HostRpcError {
  return new HostRpcError({
    code: "update-required",
    message: "Update required",
    requestId: "request-synthetic",
    method: "providers.settleApiKeyChange",
    fatalDetails: null,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  __resetAppLocalNotificationsStoreForTests();
  mocks.mobileApp = false;
  mocks.mobilePlatform = "ios";
  resetTeamPageHarness();
  activeSignInFetch?.restore();
  activeSignInFetch = null;
  authQueryClient = null;
  for (const unsubscribe of mutationCacheUnsubscribers.splice(0)) unsubscribe();
  for (const rig of rigs.splice(0)) {
    rig.context.release();
    rig.client.dispose();
  }
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("provider API-key change Settings flow", () => {
  it.each([
    {
      name: "HTTP accepted and settlement installed",
      httpStatus: 200,
      expectedStatus: "success",
      rejectsSettlement: false,
      settleCalls: 1,
    },
    {
      name: "HTTP refused",
      httpStatus: 403,
      expectedStatus: "error",
      rejectsSettlement: false,
      settleCalls: 0,
    },
    {
      name: "HTTP accepted and settlement rejected",
      httpStatus: 200,
      expectedStatus: "error",
      rejectsSettlement: true,
      settleCalls: 1,
    },
  ] as const)(
    "retains no key after $name",
    async ({ httpStatus, expectedStatus, rejectsSettlement, settleCalls }) => {
      const rig = makeRig(
        "installed",
        null,
        rejectsSettlement ? settleRequiredError() : null,
      );
      const queryClient = authQueryClient;
      if (queryClient === null) throw new Error("Query client was not created");
      teamProviderKeyHttpBoundary.status = httpStatus;
      const input: { current: string | null } = { current: API_KEY };
      const observers = captureMutationObservers(queryClient);
      const { result } = renderHook(
        () =>
          useProvidersSetApiKey(
            null,
            keyInputReader(input),
            clearKeyInput(input),
          ),
        { wrapper: withQueryClient(queryClient) },
      );

      act(() => result.current.mutate({ providerId: "cursor" }));

      await waitFor(() => expect(result.current.status).toBe(expectedStatus));
      expectRetainedMutationSurfacesClear(
        queryClient,
        observers,
        result.current,
      );
      expect(
        hasProviderKeyRequest("set", true) &&
          hostMethodCalls(rig, "providers.beginApiKeyChange") === 1 &&
          hostMethodCalls(rig, "providers.settleApiKeyChange") ===
            settleCalls &&
          input.current === null,
      ).toBe(true);
      await expectRetainedMutationReaderSpent({
        queryClient,
        rig,
        input,
        observers,
        hookResult: result.current,
      });
    },
  );

  it("keeps a failed draft and creates a fresh authenticated request on repress", async () => {
    makeRig("installed", null, null);
    teamProviderKeyHttpBoundary.status = 403;
    const queryClient = renderSettings(false, ENVIRONMENT_ID, "Personal");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(apiKeyDraft() === API_KEY).toBe(true);
      expect(teamProviderKeyHttpBoundary.calls.length).toBe(1);
    });
    const failedMutations = queryClient.getMutationCache().getAll();
    const failedMutation = failedMutations.at(-1);
    if (failedMutation === undefined)
      throw new Error("Failed provider key mutation was not retained");
    expect(
      failedMutations.length > 0 &&
        !mutationStatesContainKey(queryClient) &&
        !retainedObjectContainsKey(failedMutation.state),
    ).toBe(true);

    teamProviderKeyHttpBoundary.status = 200;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiKeyDraft()).toBe(""));
    expect(
      teamProviderKeyHttpBoundary.calls.length === 2 &&
        teamProviderKeyHttpBoundary.calls.every(
          (call) => call.action === "set" && call.keyMatches === true,
        ),
    ).toBe(true);
  });

  it.each(["installed", "unchanged"] as const)(
    "keeps %s silent and clears the submitted draft",
    async (result) => {
      makeRig(result, null, null);
      mocks.mobileApp = false;
      renderSettings(false, ENVIRONMENT_ID, "Personal");

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(apiKeyDraft()).toBe(""));
      expect(mocks.toastError).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["kept-local", "The API key was saved, but this computer is not using it."],
    ["refused", "The API key was saved, but this computer is not using it."],
    ["dropped", "The API key was saved, but this computer is not using it."],
    [
      "unavailable",
      "The API key was saved, but this computer may not be using it.",
    ],
  ] as const)(
    "shows the set notice for %s and clears the draft",
    async (result, message) => {
      makeRig(result, null, null);
      mocks.mobileApp = false;
      renderSettings(false, ENVIRONMENT_ID, "Personal");

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(apiKeyDraft()).toBe(""));
      expect(
        mocks.toastError.mock.calls.some(([shown]) => shown === message),
      ).toBe(true);
    },
  );

  it.each([
    [
      "kept-local",
      "The API key was removed, but this computer was not changed.",
    ],
    ["refused", "The API key was removed, but this computer was not changed."],
    ["dropped", "The API key was removed, but this computer was not changed."],
    [
      "unavailable",
      "The API key was removed, but this computer may not have changed.",
    ],
  ] as const)("shows the clear notice for %s", async (result, message) => {
    makeRig(result, null, null);
    mocks.mobileApp = false;
    renderSettings(true, ENVIRONMENT_ID, "Personal");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(
        mocks.toastError.mock.calls.some(([shown]) => shown === message),
      ).toBe(true),
    );
  });

  it("keeps a forbidden draft intact and leaves the established permission copy visible", async () => {
    const forbidden = new HostRpcError({
      code: "FORBIDDEN",
      message: "Host refused request",
      requestId: "request-synthetic",
      method: "providers.beginApiKeyChange",
      fatalDetails: null,
    });
    makeRig("installed", forbidden, null);
    mocks.mobileApp = false;
    renderSettings(false, ENVIRONMENT_ID, "Personal");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.toastError.mock.calls.length > 0).toBe(true),
    );
    expect(apiKeyDraft() === API_KEY).toBe(true);
    expect(
      mocks.toastError.mock.calls.some(
        ([shown]) => shown === "You don't have permission to do that.",
      ),
    ).toBe(true);
  });

  it("keeps the draft on environment drift and invalidates the host list and status", async () => {
    const rig = makeRig("installed", null, null);
    const queryClient = renderSettings(false, EXPECTED_ENVIRONMENT_ID, "Team");
    const hostId = mockLocalHostEntry.hostId;
    const plan = readProcessHostRpcTierPlan();
    const providersListKey = hostQueryKeys.methodScope(
      hostRpcServingTierHostId("providers.list", hostId, plan, null),
      "providers.list",
    );
    const environmentStatusKey = hostQueryKeys.methodScope(
      hostRpcServingTierHostId("environment.status", hostId, plan, null),
      "environment.status",
    );
    queryClient.setQueryData(providersListKey, { seeded: true });
    queryClient.setQueryData(environmentStatusKey, { seeded: true });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const providersList = queryClient.getQueryState(providersListKey);
      const environmentStatus = queryClient.getQueryState(environmentStatusKey);
      expect(
        providersList !== undefined &&
          providersList.isInvalidated &&
          environmentStatus !== undefined &&
          environmentStatus.isInvalidated,
      ).toBe(true);
    });
    expect(apiKeyDraft() === API_KEY).toBe(true);
    expect(teamProviderKeyHttpBoundary.calls.length === 0).toBe(true);
    expect(
      rig.messenger.calls.map((call) => call.method).join(",") ===
        "providers.beginApiKeyChange",
    ).toBe(true);
  });

  it("offers the desktop app release action for update-required", async () => {
    makeRig("installed", updateRequiredError(), null);
    mocks.mobileApp = false;
    renderSettings(false, ENVIRONMENT_ID, "Personal");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.toastError.mock.calls.length > 0).toBe(true),
    );
    const toastCall = mocks.toastError.mock.calls.at(0);
    if (toastCall === undefined)
      throw new Error("Expected desktop update notice");
    const options = isRecord(toastCall[1]) ? toastCall[1] : null;
    const actionValue = options === null ? undefined : options.action;
    const action = isRecord(actionValue) ? actionValue : null;
    const onClick = action === null ? undefined : action.onClick;
    expect(
      toastCall[0] === "Your app is too old" &&
        action !== null &&
        action.label === "Update the app" &&
        typeof onClick === "function",
    ).toBe(true);
    if (typeof onClick === "function") Reflect.apply(onClick, undefined, []);
    expect(mocks.openLink.mock.calls.length === 1).toBe(true);
  });

  it.each([
    [
      "ios",
      "Update the Traycer app in TestFlight or the App Store, then reopen it.",
    ],
    ["android", "Update the Traycer app in Google Play, then reopen it."],
  ] as const)(
    "shows the %s store instruction without an action",
    async (platform, note) => {
      makeRig("installed", updateRequiredError(), null);
      mocks.mobileApp = true;
      mocks.mobilePlatform = platform;
      renderSettings(false, ENVIRONMENT_ID, "Personal");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(mocks.toastError.mock.calls.length > 0).toBe(true),
      );
      const toastCall = mocks.toastError.mock.calls.at(0);
      if (toastCall === undefined)
        throw new Error("Expected mobile update notice");
      const options = isRecord(toastCall[1]) ? toastCall[1] : null;
      expect(
        toastCall[0] === "Your app is too old" &&
          options !== null &&
          options.description === note &&
          !Object.hasOwn(options, "action"),
      ).toBe(true);
    },
  );
});
