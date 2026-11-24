import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
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
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { hostV115MutationV20Fixtures } from "@traycer/protocol/host/__tests__/__fixtures__/host-v1.1.5-mutation-v20";
import {
  installSignInRequestFetchHarness,
  type SignInRequestFetchHarness,
} from "@traycer-clients/shared/test-fixtures/provider-sign-in-request-test-support";
import type { AuthService } from "@/lib/auth/auth-service";
import {
  commitRender,
  mutationsSettled,
} from "./kept-variable-actions-support";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";
import {
  apiKeyState,
  storedApiKeyState,
} from "./provider-api-key-section-fixture";
import {
  createVerifiedTeamAuthService,
  resetTeamPageHarness,
  teamProviderKeyHttpBoundary,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

const mocks = vi.hoisted(() => ({
  hostClient: vi.fn<() => HostClient<typeof hostRpcRegistry>>(),
  authService: vi.fn<() => AuthService>(),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<typeof hostRpcRegistry> => mocks.hostClient(),
    useAuthService: (): AuthService => mocks.authService(),
  };
});
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));

const API_KEY = "synthetic-provider-key";
const STATE = providerMutationCliStateSchemaV21.parse({
  ...hostV115MutationV20Fixtures.minimalStatesByProviderId.cursor,
  profiles: [],
});
const RECORD_BEGIN = providersBeginApiKeyChangeResponseSchema.parse({
  mode: "record",
  changeToken: "opaque-change-token",
  environmentId: "env-a",
});

interface Rig {
  readonly client: HostClient<typeof hostRpcRegistry>;
  readonly messenger: MockHostMessenger<typeof hostRpcRegistry>;
  readonly release: () => void;
}

const rigs: Rig[] = [];
const queryClients: QueryClient[] = [];
let signInFetch: SignInRequestFetchHarness | null = null;

beforeEach(async () => {
  signInFetch = installSignInRequestFetchHarness();
  const authQueryClient = createAppQueryClient();
  queryClients.push(authQueryClient);
  mocks.authService.mockReturnValue(
    await createVerifiedTeamAuthService(authQueryClient, signInFetch.fetchMock),
  );
  teamProviderKeyHttpBoundary.matchesKey = (key) => key === API_KEY;
  teamProviderKeyHttpBoundary.status = 200;
  teamProviderKeyHttpBoundary.calls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetNegotiatedManifests();
  resetTeamPageHarness();
  signInFetch?.restore();
  signInFetch = null;
  for (const rig of rigs.splice(0)) rig.release();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

function makeRig(): Rig {
  const handlers: MockHandlerMap<typeof hostRpcRegistry> = {
    "providers.beginApiKeyChange": (params) =>
      "intent" in params && params.intent === "save"
        ? providersBeginApiKeyChangeResponseSchema.parse({
            mode: "kept-local",
            changeToken: null,
            environmentId: null,
          })
        : RECORD_BEGIN,
    ...{
      "providers.setKeptApiKey": () =>
        providersSetApiKeyResponseSchema.parse({ state: STATE }),
    },
    "providers.settleApiKeyChange": () =>
      providersSettleApiKeyChangeResponseSchema.parse({
        result: "installed",
        state: STATE,
      }),
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
  recordNegotiatedHostManifest(mockLocalHostEntry.hostId, {
    "providers.beginApiKeyChange": { major: 1, minor: 1 },
    "providers.setKeptApiKey": { major: 1, minor: 0 },
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
  mocks.hostClient.mockReturnValue(
    client.createRequesterForHostId(mockLocalHostEntry.hostId),
  );
  const rig = {
    client,
    messenger,
    release: () => {
      context.release();
      client.dispose();
    },
  };
  rigs.push(rig);
  return rig;
}

function paramsOf(rig: Rig, method: string): unknown[] {
  return rig.messenger.calls
    .filter((call) => call.method === method)
    .map((call) => call.params);
}

function Harness(props: { readonly stored: boolean }): ReactNode {
  const [draft, setDraft] = useState(props.stored ? "" : API_KEY);
  return (
    <ProviderApiKeySection
      state={props.stored ? storedApiKeyState("cursor") : apiKeyState("cursor")}
      draft={draft}
      onDraftChange={setDraft}
      expectedEnvironmentId={null}
      environmentName={null}
    />
  );
}

function renderSettings(stored: boolean): QueryClient {
  const queryClient = createAppQueryClient();
  queryClients.push(queryClient);
  render(<Harness stored={stored} />, {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  return queryClient;
}

function apiKeyDraft(): string {
  const input = screen.getByLabelText("API key");
  if (!(input instanceof HTMLInputElement)) throw new Error("not an input");
  return input.value;
}

/** Clicks the button and returns once the action's mutation ended. */
async function clickAndSettle(
  queryClient: QueryClient,
  name: string,
): Promise<void> {
  const settled = mutationsSettled(queryClient);
  fireEvent.click(screen.getByRole("button", { name }));
  await settled;
  await commitRender();
}

describe("an ordinary Save of a provider key on a computer that keeps its own", () => {
  it("asks begin@1.1 with intent save, sends the key through setKeptApiKey, and makes no broker call or settle", async () => {
    const rig = makeRig();
    const queryClient = renderSettings(false);

    await clickAndSettle(queryClient, "Save");

    expect(apiKeyDraft()).toBe("");
    expect(paramsOf(rig, "providers.beginApiKeyChange")).toEqual([
      { providerId: "cursor", intent: "save" },
    ]);
    expect(paramsOf(rig, "providers.setKeptApiKey")).toEqual([
      { providerId: "cursor", apiKey: API_KEY },
    ]);
    expect(teamProviderKeyHttpBoundary.calls).toHaveLength(0);
    expect(paramsOf(rig, "providers.settleApiKeyChange")).toHaveLength(0);
    expect(paramsOf(rig, "providers.setApiKey")).toHaveLength(0);
  });
});

describe("the key request that keeps today's contract", () => {
  it("sends Clear's begin without an intent, even on begin@1.1", async () => {
    const rig = makeRig();
    const queryClient = renderSettings(true);

    await clickAndSettle(queryClient, "Clear");

    expect(paramsOf(rig, "providers.beginApiKeyChange")).toEqual([
      { providerId: "cursor" },
    ]);
    expect(paramsOf(rig, "providers.settleApiKeyChange")).toHaveLength(1);
    expect(paramsOf(rig, "providers.setKeptApiKey")).toHaveLength(0);
  });
});
