import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMBIENT_PROFILE_ID_SENTINEL } from "@traycer/protocol/host/agent/shared";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
  ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import type {
  ProvidersLinkCompleteRequestV11,
  ProvidersLinkCompleteResponseV12,
  ProvidersLinkRequestV12,
  ProvidersLinkResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  createHostRpcTierPlan,
  NO_POOL_HOST_RPC_TIER_PLAN,
  type HostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  HostRpcError,
  type RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
  recordNegotiatedHostMethods,
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  hostEntryFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";
import { ProviderProfileScopedSection } from "@/components/settings/panels/provider-profile-scoped-section";
import { createCallEvents } from "@/components/providers/__tests__/environment-sign-in-call-events";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The reauth panel starts a sign-in on mount (a deep link, "Sign in", "Switch
 * account" all land here). On a host that takes no credentials it must start
 * nothing, say why, and offer the way back.
 */

const mocks = vi.hoisted(() => ({
  startLoginAsync: vi.fn(),
  awaitLoginMutate: vi.fn(),
  cancelLoginMutate: vi.fn(),
  /** What `useHostCredentialRefusal` answers; `null` is a host that takes sign-ins. */
  credentialRefusal: null as string | null,
}));
const refusalHosts = vi.hoisted((): { ids: Array<string | null> } => ({
  ids: [],
}));
const clientRef = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));
const routingPlan = vi.hoisted((): { current: HostRpcTierPlan | null } => ({
  current: null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<HostRpcRegistry> => {
      const client = clientRef.current;
      if (client === null) {
        throw new Error("Expected a host client.");
      }
      return client;
    },
    useOptionalHostClient: () => clientRef.current,
  };
});
vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    return {
      ...actual,
      readProcessHostRpcTierPlan: (): HostRpcTierPlan =>
        routingPlan.current ?? actual.NO_POOL_HOST_RPC_TIER_PLAN,
    };
  },
);

vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: (hostId: string | null) => {
    refusalHosts.ids.push(hostId);
    return mocks.credentialRefusal;
  },
}));
vi.mock("@/hooks/providers/use-providers-login-ownership", () => ({
  useProvidersLoginOwnership: () => false,
}));
vi.mock("@/hooks/providers/use-providers-start-login-mutation", () => ({
  useProvidersStartLogin: () => ({
    mutateAsync: (variables: unknown) => {
      mocks.startLoginAsync(variables);
      return new Promise<never>(() => undefined);
    },
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-providers-await-login-mutation", () => ({
  useHostScopedProvidersAwaitLogin: () => ({
    mutate: mocks.awaitLoginMutate,
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-providers-cancel-login-mutation", () => ({
  useProvidersCancelLogin: () => ({
    mutate: mocks.cancelLoginMutate,
    mutateAsync: () => Promise.resolve({ cancelled: true }),
    isPending: false,
  }),
}));
vi.mock("@/hooks/providers/use-providers-submit-login-code-mutation", () => ({
  useProvidersSubmitLoginCode: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    data: undefined,
    error: null,
    reset: vi.fn(),
  }),
}));
vi.mock("@/hooks/providers/use-providers-touch-login-mutation", () => ({
  useProvidersTouchLogin: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  useProvidersEnsurePack: () => ({
    mutate: vi.fn(),
    mutateAsync: () => Promise.resolve({}),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));

import { ProviderProfileReauthPanel } from "@/components/settings/panels/provider-profile-reauth-panel";

const REFUSAL = "Sandboxes don't take sign-ins";
const HOST_ID = "host-reauth-route";
const ENVIRONMENT_ID = "environment-reauth-route";
const V12 = { major: 1, minor: 2 } as const;
const LOCAL_SIGN_IN_MANIFEST: ConnectionManifest = {
  "providers.link": { major: 1, minor: 1 },
  "providers.linkComplete": { major: 1, minor: 1 },
};
const ROUTE_MANIFEST: ConnectionManifest = {
  "providers.link": V12,
  "providers.linkComplete": V12,
  "providers.linkCancel": { major: 1, minor: 0 },
  "providers.list": { major: 10, minor: 9 },
  "environment.host.read": { major: 1, minor: 0 },
  "environment.status": { major: 1, minor: 2 },
  "environment.list": { major: 1, minor: 1 },
};
const ROUTE_WITH_PROFILE_RENAME_MANIFEST: ConnectionManifest = {
  ...ROUTE_MANIFEST,
  "providers.setEnabled": { major: 2, minor: 1 },
};
const POOL_BINDING_READ_MANIFEST: ConnectionManifest = {
  "environment.binding.read": { major: 1, minor: 0 },
  "environment.list": { major: 1, minor: 1 },
};
const POOL_LIST_ONLY_MANIFEST: ConnectionManifest = {
  "environment.list": { major: 1, minor: 1 },
};
const routeReadMethods: string[] = [];

interface RouteFixture {
  readonly status: EnvironmentStatusResponseV12;
  readonly bindingOwnerKind: "user" | "organization";
  readonly effectiveRole: "owner" | "admin" | "editor" | "viewer";
}

interface PoolRouteFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly readMethods: string[];
  readonly statusRead: Promise<void>;
}

function managedProfile(): ProviderProfile {
  return {
    profileId: "profile-managed",
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Work account",
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: null, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function codexState(profile: ProviderProfile): ProviderCliState {
  return {
    providerId: "codex",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: {
      oauthArgs: ["auth", "login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
      remoteSafe: null,
      selfOpensBrowser: null,
    },
    availabilityPending: false,
    profiles: [profile],
  };
}

function buildRouteClient(
  linkRequests: ProvidersLinkRequestV12[],
  route: RouteFixture,
  manifest: ConnectionManifest | null,
): HostClient<HostRpcRegistry> {
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.host.read": () => {
        routeReadMethods.push("environment.host.read");
        return {
          hostId: HOST_ID,
          environment: {
            environmentId: ENVIRONMENT_ID,
            ownerKind: route.bindingOwnerKind,
            ownerId:
              route.bindingOwnerKind === "user" ? "owner-test" : "team-test",
            roomId: "room-test",
            label: route.bindingOwnerKind === "user" ? "Personal" : "Acme",
          },
          explicit: true,
          enrolledByUserId: null,
          canUnbind: false,
          sharingGeneration: null,
        };
      },
      "environment.status": () => {
        routeReadMethods.push("environment.status");
        return route.status;
      },
      "environment.list": () => {
        routeReadMethods.push("environment.list");
        return {
          environments: [
            {
              environmentId: ENVIRONMENT_ID,
              ownerKind: route.bindingOwnerKind,
              ownerId:
                route.bindingOwnerKind === "user" ? "owner-test" : "team-test",
              roomId: "room-test",
              label: route.bindingOwnerKind === "user" ? "Personal" : "Acme",
              effectiveRole: route.effectiveRole,
              kind: route.bindingOwnerKind === "user" ? "personal" : "team",
              hostCount: 1,
              providerHandle:
                route.bindingOwnerKind === "user" ? null : "handle-acme",
            },
          ],
        };
      },
      "providers.link": (request) => {
        linkRequests.push(request);
        const response: ProvidersLinkResponseV12 = {
          linkId: "link-reauth-route",
          environmentProfileId: "environment-profile-reauth-route",
          prompt: {
            kind: "sign_in_url",
            url: "https://auth.example.test/sign-in",
            codePrompt: "One-time code",
          },
        };
        return response;
      },
      "providers.linkComplete": () => ({
        state: "pending",
        code: null,
        account: null,
        expectedAccount: null,
        environmentProfileId: null,
        profileId: null,
      }),
      "providers.linkCancel": () => ({}),
      "providers.list": () => ({ providers: [], native: null }),
    },
  });
  if (manifest !== null) recordNegotiatedHostManifest(HOST_ID, manifest);
  return client;
}

function buildPoolRouteClient(
  linkRequests: ProvidersLinkRequestV12[],
  route: RouteFixture,
  poolManifest: ConnectionManifest | null,
  bindingRead: () => EnvironmentHostBinding,
): PoolRouteFixture {
  const targetEntry = hostEntryFixture(HOST_ID);
  const readMethods: string[] = [];
  const statusRead = Promise.withResolvers<void>();
  let requestSequence = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestSequence += 1;
      return `req-profile-route-${String(requestSequence)}`;
    },
    handlers: {
      "environment.status": () => {
        readMethods.push("environment.status");
        statusRead.resolve();
        return route.status;
      },
      "environment.binding.read": () => {
        readMethods.push("environment.binding.read");
        return bindingRead();
      },
      "environment.list": () => {
        readMethods.push("environment.list");
        return {
          environments: [
            {
              environmentId: ENVIRONMENT_ID,
              ownerKind: route.bindingOwnerKind,
              ownerId:
                route.bindingOwnerKind === "user" ? "owner-test" : "team-test",
              roomId: "room-test",
              label: route.bindingOwnerKind === "user" ? "Personal" : "Acme",
              effectiveRole: route.effectiveRole,
              kind: route.bindingOwnerKind === "user" ? "personal" : "team",
              hostCount: 1,
              providerHandle:
                route.bindingOwnerKind === "user" ? null : "handle-acme",
            },
          ],
        };
      },
      "providers.link": (request) => {
        linkRequests.push(request);
        return {
          linkId: "link-profile-pool-route",
          environmentProfileId: "environment-profile-pool-route",
          prompt: {
            kind: "sign_in_url",
            url: "https://auth.example.test/sign-in",
            codePrompt: "One-time code",
          },
        };
      },
    },
  });
  const plan = createHostRpcTierPlan(poolEntry);
  routingPlan.current = plan;
  if (plan.pool?.hostId !== POOL_HOST_ID) {
    throw new Error("Expected the server-pool routing plan in this fixture.");
  }
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) => {
      if (hostId === HOST_ID) return targetEntry;
      return hostId === POOL_HOST_ID ? poolEntry : null;
    },
    messenger,
    routing: { plan, selectedHostId: () => null },
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  recordNegotiatedHostManifest(HOST_ID, ROUTE_MANIFEST);
  if (poolManifest !== null) {
    recordNegotiatedHostManifest(POOL_HOST_ID, poolManifest);
  }
  return {
    client: spine.createRequester(targetEntry),
    messenger,
    readMethods,
    statusRead: statusRead.promise,
  };
}

function renderRoutedPanel(
  profile: ProviderProfile,
  replaceAccount: boolean,
  client: HostClient<HostRpcRegistry>,
  onCancel: () => void,
) {
  clientRef.current = client;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProviderProfileReauthPanel
          state={codexState(profile)}
          profile={profile}
          replaceAccount={replaceAccount}
          isLocalHost
          onSameAccountReconnected={null}
          onCancel={onCancel}
          onDone={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function ambientProfile(): ProviderProfile {
  const profile = managedProfile();
  return {
    ...profile,
    profileId: AMBIENT_PROFILE_ID_SENTINEL,
    kind: "ambient",
    label: "Terminal account",
  };
}

beforeEach(() => {
  routeReadMethods.length = 0;
  refusalHosts.ids.length = 0;
  routingPlan.current = NO_POOL_HOST_RPC_TIER_PLAN;
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: "test-viewer",
      userName: "Test Viewer",
      email: "viewer@example.test",
    },
    contextMetadata: { userId: "test-viewer", username: "test-viewer" },
    signingInAttempt: null,
    signedOutCause: null,
    hostRefusedHeldBearer: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.credentialRefusal = null;
  clientRef.current = null;
  routingPlan.current = null;
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    signingInAttempt: null,
    signedOutCause: "retired",
    hostRefusedHeldBearer: false,
  });
});

describe("managed profile reauth routing", () => {
  it("routes ordinary sign-in through @1.2 without replacing the account", async () => {
    const profile: ProviderProfile = {
      ...managedProfile(),
      environmentProfileId: "environment-profile-managed",
    };
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const client = buildRouteClient(
      linkRequests,
      {
        status: environmentStatusFixture({}),
        bindingOwnerKind: "user",
        effectiveRole: "owner",
      },
      ROUTE_MANIFEST,
    );
    const signedInAuth = useAuthStore.getState().profile;
    renderRoutedPanel(profile, false, client, () => undefined);

    await screen.findByLabelText("One-time code");
    expect(routeReadMethods).toEqual([
      "environment.status",
      "environment.host.read",
    ]);
    expect(linkRequests).toEqual([
      {
        providerId: "codex",
        profileId: "environment-profile-managed",
        environmentId: ENVIRONMENT_ID,
        createProfile: null,
        replaceAccount: false,
      },
    ]);
    expect(useAuthStore.getState().profile).toBe(signedInAuth);
  });

  it("shows the account-change warning before a Switch account request", async () => {
    const profile = managedProfile();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const client = buildRouteClient(
      linkRequests,
      {
        status: environmentStatusFixture({}),
        bindingOwnerKind: "user",
        effectiveRole: "owner",
      },
      ROUTE_MANIFEST,
    );
    renderRoutedPanel(profile, true, client, () => undefined);

    expect(
      await screen.findByText(
        "This changes the account on this profile everywhere it is used.",
      ),
    ).toBeTruthy();
    expect(linkRequests).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));

    await screen.findByLabelText("One-time code");
    expect(linkRequests).toEqual([
      {
        providerId: "codex",
        profileId: profile.profileId,
        environmentId: ENVIRONMENT_ID,
        createProfile: null,
        replaceAccount: true,
      },
    ]);
  });

  it.each([
    {
      olderMethod: "providers.link",
      manifest: {
        ...ROUTE_MANIFEST,
        "providers.link": { major: 1, minor: 1 },
      },
    },
    {
      olderMethod: "providers.linkComplete",
      manifest: {
        ...ROUTE_MANIFEST,
        "providers.linkComplete": { major: 1, minor: 1 },
      },
    },
  ])(
    "keeps the signed-in account and uses legacy sign-in when $olderMethod is old",
    ({ manifest }) => {
      const profile = managedProfile();
      const linkRequests: ProvidersLinkRequestV12[] = [];
      const client = buildRouteClient(
        linkRequests,
        {
          status: environmentStatusFixture({}),
          bindingOwnerKind: "user",
          effectiveRole: "owner",
        },
        manifest,
      );
      const signedInAuth = useAuthStore.getState().profile;
      renderRoutedPanel(profile, false, client, vi.fn());

      expect(mocks.startLoginAsync).toHaveBeenCalledTimes(1);
      expect(mocks.startLoginAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "codex",
          profileId: profile.profileId,
        }),
      );
      expect(linkRequests).toEqual([]);
      expect(useAuthStore.getState().profile).toBe(signedInAuth);
    },
  );

  it("shows the selected-host refusal before unknown versions can start sign-in", async () => {
    mocks.credentialRefusal = REFUSAL;
    const onCancel = vi.fn();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const client = buildRouteClient(
      linkRequests,
      {
        status: environmentStatusFixture({}),
        bindingOwnerKind: "user",
        effectiveRole: "owner",
      },
      null,
    );
    renderRoutedPanel(managedProfile(), false, client, onCancel);

    expect(await screen.findByTestId("credential-refusal")).toBeTruthy();
    expect(getNegotiatedHostMethods(HOST_ID)).toBeNull();
    expect(refusalHosts.ids).toContain(HOST_ID);
    expect(routeReadMethods).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(linkRequests).toEqual([]);
    expect(mocks.startLoginAsync).not.toHaveBeenCalled();
  });

  it("waits through name-only negotiation, then routes a supported environment", async () => {
    const profile = managedProfile();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const client = buildRouteClient(
      linkRequests,
      {
        status: environmentStatusFixture({
          principal: { kind: "team", teamName: "Acme" },
        }),
        bindingOwnerKind: "organization",
        effectiveRole: "editor",
      },
      null,
    );
    const rendered = renderRoutedPanel(profile, false, client, vi.fn());

    expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy();
    expect(
      rendered.container.querySelectorAll('span[aria-hidden="true"]'),
    ).toHaveLength(1);
    expect(routeReadMethods).toEqual([]);
    expect(linkRequests).toEqual([]);
    expect(mocks.startLoginAsync).not.toHaveBeenCalled();

    act(() => {
      recordNegotiatedHostMethods(HOST_ID, [
        "providers.link",
        "providers.linkComplete",
        "environment.status",
        "environment.host.read",
        "environment.list",
      ]);
    });
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(routeReadMethods).toEqual([]);
    expect(linkRequests).toEqual([]);
    expect(mocks.startLoginAsync).not.toHaveBeenCalled();

    act(() => recordNegotiatedHostManifest(HOST_ID, ROUTE_MANIFEST));
    await screen.findByLabelText("One-time code");

    expect(routeReadMethods).toEqual([
      "environment.status",
      "environment.host.read",
      "environment.list",
    ]);
    expect(linkRequests).toEqual([
      {
        providerId: "codex",
        profileId: profile.profileId,
        environmentId: ENVIRONMENT_ID,
        createProfile: null,
        replaceAccount: false,
      },
    ]);
    expect(mocks.startLoginAsync).not.toHaveBeenCalled();
  });

  it("does not start sign-in when Back closes before the first manifest", async () => {
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const onCancel = vi.fn();
    const client = buildRouteClient(
      linkRequests,
      {
        status: environmentStatusFixture({}),
        bindingOwnerKind: "user",
        effectiveRole: "owner",
      },
      null,
    );
    const rendered = renderRoutedPanel(
      managedProfile(),
      false,
      client,
      onCancel,
    );

    await screen.findByRole("button", { name: "Back" });
    expect(routeReadMethods).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    rendered.unmount();

    act(() => recordNegotiatedHostManifest(HOST_ID, ROUTE_MANIFEST));

    expect(routeReadMethods).toEqual([]);
    expect(linkRequests).toEqual([]);
    expect(mocks.startLoginAsync).not.toHaveBeenCalled();
  });

  it("keeps an ambient profile on the local flow even when @1.2 is available", () => {
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const profile = ambientProfile();
    const client = buildRouteClient(
      linkRequests,
      {
        status: environmentStatusFixture({}),
        bindingOwnerKind: "user",
        effectiveRole: "owner",
      },
      ROUTE_MANIFEST,
    );
    renderRoutedPanel(profile, false, client, vi.fn());

    expect(mocks.startLoginAsync).toHaveBeenCalledTimes(1);
    expect(mocks.startLoginAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        profileId: AMBIENT_PROFILE_ID_SENTINEL,
      }),
    );
    expect(linkRequests).toEqual([]);
  });

  it("uses the local flow when environment.status has no principal despite a Personal binding", async () => {
    const profile = managedProfile();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const client = buildRouteClient(
      linkRequests,
      {
        status: environmentStatusFixture({ principal: null }),
        bindingOwnerKind: "user",
        effectiveRole: "owner",
      },
      ROUTE_MANIFEST,
    );
    renderRoutedPanel(profile, false, client, vi.fn());

    await screen.findByText("Opening the sign-in page…");
    expect(mocks.startLoginAsync).toHaveBeenCalledTimes(1);
    expect(mocks.startLoginAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        profileId: profile.profileId,
      }),
    );
    expect(linkRequests).toEqual([]);
  });

  it("shows the teammate guidance without sign-in for a viewer and starts the named team for an editor", async () => {
    const profile = managedProfile();
    const viewerRequests: ProvidersLinkRequestV12[] = [];
    const viewerClient = buildRouteClient(
      viewerRequests,
      {
        status: environmentStatusFixture({
          principal: { kind: "team", teamName: "Acme" },
        }),
        bindingOwnerKind: "organization",
        effectiveRole: "viewer",
      },
      ROUTE_MANIFEST,
    );
    renderRoutedPanel(profile, false, viewerClient, vi.fn());

    expect(
      await screen.findByText("Ask a teammate to sign in on Providers."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(viewerRequests).toEqual([]);
    expect(mocks.startLoginAsync).not.toHaveBeenCalled();

    cleanup();
    const editorRequests: ProvidersLinkRequestV12[] = [];
    const editorClient = buildRouteClient(
      editorRequests,
      {
        status: environmentStatusFixture({
          principal: { kind: "team", teamName: "Acme" },
        }),
        bindingOwnerKind: "organization",
        effectiveRole: "editor",
      },
      ROUTE_MANIFEST,
    );
    renderRoutedPanel(profile, false, editorClient, vi.fn());

    await screen.findByLabelText("One-time code");
    expect(editorRequests).toEqual([
      {
        providerId: "codex",
        profileId: profile.profileId,
        environmentId: ENVIRONMENT_ID,
        createProfile: null,
        replaceAccount: false,
      },
    ]);
  });
});

describe("a local profile promoted to an environment alias during reauth", () => {
  it("keeps the active attempt on its entry row and captures the alias on a fresh switch", async () => {
    const environmentProfileId = "environment-profile-reauth-alias";
    const firstLinkId = "link-reauth-alias-first";
    const secondLinkId = "link-reauth-alias-second";
    const firstDeviceCode = "FIRST-DEVICE-CODE";
    const secondDeviceCode = "SECOND-DEVICE-CODE";
    const draftLabel = "Draft profile name";
    const initialProfile: ProviderProfile = {
      ...managedProfile(),
      presence: { kind: "admitted", bindingVersion: 1 },
    };
    const aliasedProfile: ProviderProfile = {
      ...initialProfile,
      environmentProfileId,
    };
    const placeholderProfile: ProviderProfile = {
      ...managedProfile(),
      profileId: environmentProfileId,
      environmentProfileId,
      auth: {
        status: "unknown",
        badgeText: null,
        label: null,
        detail: null,
      },
      presence: { kind: "no-home" },
    };
    const admittedProfile: ProviderProfile = {
      ...managedProfile(),
      profileId: "profile-admitted-after-reauth",
      environmentProfileId,
      presence: { kind: "admitted", bindingVersion: 1 },
    };
    const installedProfile: ProviderProfile = {
      ...admittedProfile,
      auth: { ...admittedProfile.auth, status: "authenticated" },
    };
    const unrelatedProfile: ProviderProfile = {
      ...managedProfile(),
      profileId: "profile-unrelated",
      presence: { kind: "admitted", bindingVersion: 1 },
    };
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const completeRequests: ProvidersLinkCompleteRequestV11[] = [];
    const profileSaveRequests: RequestOfMethod<
      HostRpcRegistry,
      "providers.setEnabled"
    >[] = [];
    const cancelledLinkIds: string[] = [];
    const linkEvents = createCallEvents();
    const completeEvents = createCallEvents();
    const cancelEvents = createCallEvents();
    const inventoryEvents = createCallEvents();
    const profileSaveEvents = createCallEvents();
    const pollIntervals = createCallEvents();
    const firstLinkResponse = Promise.withResolvers<ProvidersLinkResponseV12>();
    const firstCompleteResponse =
      Promise.withResolvers<ProvidersLinkCompleteResponseV12>();
    const inventoryResponse = Promise.withResolvers<ProvidersListResponse>();
    const secondLinkResponse =
      Promise.withResolvers<ProvidersLinkResponseV12>();
    let inventoryReads = 0;
    const initialInventory: ProvidersListResponse = {
      providers: [],
      native: null,
      scope: "personal",
      onHostOnly: [
        { providerId: "codex", profileId: initialProfile.profileId },
      ],
    };
    const installedInventory: ProvidersListResponse = {
      providers: [codexState(installedProfile)],
      native: null,
      scope: "personal",
      onHostOnly: [],
    };
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => environmentStatusFixture({}),
        "environment.host.read": () => ({
          hostId: HOST_ID,
          environment: {
            environmentId: ENVIRONMENT_ID,
            ownerKind: "user",
            ownerId: "owner-test",
            roomId: "room-test",
            label: "Personal",
          },
          explicit: true,
          enrolledByUserId: null,
          canUnbind: false,
          sharingGeneration: null,
        }),
        "environment.list": () => ({
          environments: [
            {
              environmentId: ENVIRONMENT_ID,
              ownerKind: "user",
              ownerId: "owner-test",
              roomId: "room-test",
              label: "Personal",
              effectiveRole: "owner",
              kind: "personal",
              hostCount: 1,
              providerHandle: null,
            },
          ],
        }),
        "providers.link": (request) => {
          linkRequests.push(request);
          linkEvents.emit();
          if (linkRequests.length === 1) return firstLinkResponse.promise;
          if (linkRequests.length === 2) return secondLinkResponse.promise;
          throw new Error("Unexpected extra environment sign-in request.");
        },
        "providers.linkComplete": (request) => {
          completeRequests.push(request);
          completeEvents.emit();
          return firstCompleteResponse.promise;
        },
        "providers.linkCancel": (request) => {
          cancelledLinkIds.push(request.linkId);
          cancelEvents.emit();
          return {};
        },
        "providers.list": () => {
          inventoryReads += 1;
          inventoryEvents.emit();
          if (inventoryReads === 1) return initialInventory;
          if (inventoryReads === 2) return inventoryResponse.promise;
          if (inventoryReads === 3) return installedInventory;
          throw new Error("Unexpected extra provider inventory read.");
        },
        "providers.setEnabled": (request) => {
          profileSaveRequests.push(request);
          profileSaveEvents.emit();
          return { state: codexState(installedProfile) };
        },
      },
    });
    clientRef.current = client;
    recordNegotiatedHostManifest(HOST_ID, ROUTE_WITH_PROFILE_RENAME_MANIFEST);
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: HOST_ID, hostName: "Studio" },
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const sectionForState = (state: ProviderCliState) => (
      <PersonalPageContext.Provider
        value={{
          section: "providers",
          pick: { kind: "personal" },
          state: { kind: "ready", status: environmentStatusFixture({}) },
          line: null,
          hostName: "Studio",
          localOverrides: [],
          hostId: HOST_ID,
          client,
          notices: [],
          review: [],
        }}
      >
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ProviderProfileScopedSection
              state={state}
              hostId={HOST_ID}
              isSelectedHostLocal
              canAddProfile
              credentialRefusal={null}
              onOpenCliSettings={() => undefined}
              startInReauth={false}
              failedAttempt={null}
              onAddProfile={() => undefined}
              onDismissFailedAttempt={() => undefined}
              selectedProfileId={initialProfile.profileId}
              onSelectedProfileIdChange={() => undefined}
              profileEnablementAvailable={false}
              profileEnablementPending={() => false}
              onSetProfileEnabled={() => undefined}
            />
          </TooltipProvider>
        </QueryClientProvider>
      </PersonalPageContext.Provider>
    );
    const rendered = render(sectionForState(codexState(initialProfile)));

    await waitFor(() => {
      const providersListQuery = queryClient
        .getQueryCache()
        .findAll()
        .find((query) => query.queryKey.includes("providers.list"));
      expect(providersListQuery?.state.status).toBe("success");
      expect(providersListQuery?.state.data).toMatchObject(initialInventory);
    });
    expect(screen.queryByText("On Studio only.")).toBeNull();
    expect(screen.queryByText("Not on your other computers yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
    const initialNameInput = screen.getByLabelText("Profile name");
    if (!(initialNameInput instanceof HTMLInputElement)) {
      throw new Error("Expected the profile name input.");
    }
    fireEvent.change(initialNameInput, { target: { value: draftLabel } });
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect(
      await screen.findByText(
        "This changes the account on this profile everywhere it is used.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await linkEvents.waitFor(1);
    expect(linkRequests[0]).toEqual({
      providerId: "codex",
      profileId: initialProfile.profileId,
      environmentId: ENVIRONMENT_ID,
      createProfile: null,
      replaceAccount: true,
    });

    rendered.rerender(sectionForState(codexState(aliasedProfile)));
    expect(screen.getByText("Waiting for sign-in…")).toBeTruthy();
    const nameInputAfterAlias = screen.getByLabelText("Profile name");
    if (!(nameInputAfterAlias instanceof HTMLInputElement)) {
      throw new Error("Expected the profile name input after alias promotion.");
    }
    expect(nameInputAfterAlias.value).toBe(draftLabel);

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const intervalWindow: Pick<Window, "setInterval"> = window;
    const realSetInterval = intervalWindow.setInterval.bind(intervalWindow);
    const intervalSpy = vi
      .spyOn(intervalWindow, "setInterval")
      .mockImplementation((handler, timeout) => {
        const intervalId = realSetInterval(handler, timeout);
        if (timeout === 2_000) pollIntervals.emit();
        return intervalId;
      });
    try {
      await act(async () => {
        firstLinkResponse.resolve({
          linkId: firstLinkId,
          environmentProfileId,
          prompt: {
            kind: "device_code",
            verificationUrl: "https://auth.example.test/device",
            userCode: firstDeviceCode,
            expiresAt: Date.now() + 60_000,
          },
        });
        await firstLinkResponse.promise;
      });
      expect(await screen.findByText(firstDeviceCode)).toBeTruthy();
      await pollIntervals.waitFor(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await completeEvents.waitFor(1);

      rendered.rerender(sectionForState(codexState(placeholderProfile)));
      expect(screen.getByText(firstDeviceCode)).toBeTruthy();
      expect(linkRequests).toEqual([
        {
          providerId: "codex",
          profileId: initialProfile.profileId,
          environmentId: ENVIRONMENT_ID,
          createProfile: null,
          replaceAccount: true,
        },
      ]);
      expect(completeRequests).toEqual([
        {
          linkId: firstLinkId,
          code: null,
          environmentId: ENVIRONMENT_ID,
        },
      ]);
      expect(cancelledLinkIds).toEqual([]);
      expect(mocks.startLoginAsync).not.toHaveBeenCalled();

      await act(async () => {
        firstCompleteResponse.resolve({
          state: "linked",
          code: null,
          account: null,
          expectedAccount: null,
          environmentProfileId,
          profileId: admittedProfile.profileId,
        });
        await firstCompleteResponse.promise;
      });
      await inventoryEvents.waitFor(2);
      await act(async () => {
        inventoryResponse.resolve(installedInventory);
        await inventoryResponse.promise;
      });
      rendered.rerender(
        sectionForState({
          ...codexState(installedProfile),
          profiles: [unrelatedProfile, installedProfile],
        }),
      );
      await waitFor(() => {
        const returnedNameInput = screen.getByLabelText("Profile name");
        if (!(returnedNameInput instanceof HTMLInputElement)) {
          throw new Error("Expected the profile name input after completion.");
        }
        expect(returnedNameInput.disabled).toBe(false);
        expect(returnedNameInput.value).toBe(draftLabel);
      });
      expect(inventoryReads).toBe(2);

      expect(linkRequests).toEqual([
        {
          providerId: "codex",
          profileId: initialProfile.profileId,
          environmentId: ENVIRONMENT_ID,
          createProfile: null,
          replaceAccount: true,
        },
      ]);
      expect(completeRequests).toEqual([
        {
          linkId: firstLinkId,
          code: null,
          environmentId: ENVIRONMENT_ID,
        },
      ]);
      expect(cancelledLinkIds).toEqual([]);
      expect(mocks.startLoginAsync).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await profileSaveEvents.waitFor(1);
      await screen.findByRole("button", { name: "Manage profile" });
      expect(profileSaveRequests).toEqual([
        {
          providerId: "codex",
          enabled: true,
          profileAction: {
            type: "rename",
            profileId: admittedProfile.profileId,
            label: draftLabel,
          },
        },
      ]);
      await inventoryEvents.waitFor(3);

      fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
      await screen.findByLabelText("Profile name");
      fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
      expect(
        await screen.findByText(
          "This changes the account on this profile everywhere it is used.",
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
      await linkEvents.waitFor(2);
      expect(linkRequests).toEqual([
        {
          providerId: "codex",
          profileId: initialProfile.profileId,
          environmentId: ENVIRONMENT_ID,
          createProfile: null,
          replaceAccount: true,
        },
        {
          providerId: "codex",
          profileId: environmentProfileId,
          environmentId: ENVIRONMENT_ID,
          createProfile: null,
          replaceAccount: true,
        },
      ]);

      const pendingSignIn = screen
        .getByText("Waiting for sign-in…")
        .closest('[aria-live="polite"]');
      if (!(pendingSignIn instanceof HTMLElement)) {
        throw new Error("Expected the active sign-in status region.");
      }
      fireEvent.click(
        within(pendingSignIn).getByRole("button", { name: "Close" }),
      );
      await act(async () => {
        secondLinkResponse.resolve({
          linkId: secondLinkId,
          environmentProfileId,
          prompt: {
            kind: "device_code",
            verificationUrl: "https://auth.example.test/device",
            userCode: secondDeviceCode,
            expiresAt: Date.now() + 60_000,
          },
        });
        await secondLinkResponse.promise;
      });
      await cancelEvents.waitFor(1);
      expect(cancelledLinkIds).toEqual([secondLinkId]);
    } finally {
      intervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("<ProviderProfileReauthPanel /> on a host that takes no credentials", () => {
  it("starts no sign-in on mount, shows the refusal and a Back button that cancels", () => {
    mocks.credentialRefusal = REFUSAL;
    const onCancel = vi.fn();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const client = buildRouteClient(
      linkRequests,
      {
        status: environmentStatusFixture({}),
        bindingOwnerKind: "user",
        effectiveRole: "owner",
      },
      LOCAL_SIGN_IN_MANIFEST,
    );
    renderRoutedPanel(managedProfile(), false, client, onCancel);

    expect(mocks.startLoginAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId("credential-refusal").textContent).toBe(REFUSAL);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mocks.startLoginAsync).not.toHaveBeenCalled();
    expect(linkRequests).toEqual([]);
  });

  it("control: on a host that takes sign-ins the panel starts the sign-in on mount and shows no refusal", () => {
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const client = buildRouteClient(
      linkRequests,
      {
        status: environmentStatusFixture({}),
        bindingOwnerKind: "user",
        effectiveRole: "owner",
      },
      LOCAL_SIGN_IN_MANIFEST,
    );
    renderRoutedPanel(managedProfile(), false, client, vi.fn());

    expect(mocks.startLoginAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("credential-refusal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});

const POOL_ROUTE: RouteFixture = {
  status: environmentStatusFixture({}),
  bindingOwnerKind: "user",
  effectiveRole: "owner",
};

const POOL_BINDING: EnvironmentHostBinding = {
  hostId: HOST_ID,
  environment: {
    environmentId: ENVIRONMENT_ID,
    ownerKind: "user",
    ownerId: "owner-test",
    roomId: "room-test",
    label: "Personal",
  },
  explicit: true,
  enrolledByUserId: null,
  canUnbind: false,
};

describe("managed profile routing reads in a pool build", () => {
  it("keeps an unknown pool binding-read capability in the reading state", async () => {
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const fixture = buildPoolRouteClient(
      linkRequests,
      POOL_ROUTE,
      null,
      () => POOL_BINDING,
    );
    const rendered = renderRoutedPanel(
      managedProfile(),
      false,
      fixture.client,
      vi.fn(),
    );

    await act(async () => {
      await fixture.statusRead;
    });

    expect(getNegotiatedHostMethods(POOL_HOST_ID)).toBeNull();
    const spinnerElements = rendered.container.querySelectorAll(
      'span[aria-hidden="true"]',
    );
    expect(spinnerElements).toHaveLength(1);
    const spinner = spinnerElements.item(0);
    if (!(spinner instanceof HTMLSpanElement)) {
      throw new Error("Expected the routed waiting spinner to be a span.");
    }
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.textContent.trim()).toBeTruthy();
    expect(fixture.readMethods).toEqual(["environment.status"]);
    expect(
      fixture.messenger.calls.map((call) => [
        call.method,
        call.authority.endpoint.hostId,
      ]),
    ).toEqual([["environment.status", HOST_ID]]);
    expect(linkRequests).toEqual([]);
    expect(mocks.startLoginAsync).not.toHaveBeenCalled();
  });

  it("routes a supported pool binding read at v1.0 and skips the user inventory read", async () => {
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const profile = managedProfile();
    const fixture = buildPoolRouteClient(
      linkRequests,
      POOL_ROUTE,
      POOL_BINDING_READ_MANIFEST,
      () => POOL_BINDING,
    );
    renderRoutedPanel(profile, false, fixture.client, vi.fn());

    await screen.findByLabelText("One-time code");

    expect(
      getNegotiatedHostMethodVersion(POOL_HOST_ID, "environment.binding.read"),
    ).toEqual({ major: 1, minor: 0 });
    expect(fixture.readMethods).toEqual([
      "environment.status",
      "environment.binding.read",
    ]);
    const statusCall = fixture.messenger.calls.find(
      (call) => call.method === "environment.status",
    );
    const bindingCall = fixture.messenger.calls.find(
      (call) => call.method === "environment.binding.read",
    );
    expect(statusCall?.authority.endpoint.hostId).toBe(HOST_ID);
    expect(bindingCall?.authority.endpoint.hostId).toBe(POOL_HOST_ID);
    expect(bindingCall?.params).toEqual({ hostId: HOST_ID });
    expect(
      fixture.messenger.calls.filter(
        (call) => call.method === "environment.list",
      ),
    ).toHaveLength(0);
    expect(linkRequests).toEqual([
      {
        providerId: "codex",
        profileId: profile.profileId,
        environmentId: ENVIRONMENT_ID,
        createProfile: null,
        replaceAccount: false,
      },
    ]);
  });

  it("uses local sign-in when the pool has no binding-read method", async () => {
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const fixture = buildPoolRouteClient(
      linkRequests,
      POOL_ROUTE,
      POOL_LIST_ONLY_MANIFEST,
      () => POOL_BINDING,
    );
    renderRoutedPanel(managedProfile(), false, fixture.client, vi.fn());

    await screen.findByText("Opening the sign-in page…");

    expect(fixture.readMethods).toEqual(["environment.status"]);
    expect(fixture.messenger.calls.map((call) => call.method)).toEqual([
      "environment.status",
    ]);
    expect(mocks.startLoginAsync).toHaveBeenCalledTimes(1);
    expect(linkRequests).toEqual([]);
  });

  it("shows retry for a refused pool binding read and resumes on the next read", async () => {
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const profile = managedProfile();
    const bindingResponses: Array<EnvironmentHostBinding | HostRpcError> = [
      new HostRpcError({
        code: "FORBIDDEN",
        message: "The binding read was refused.",
        requestId: "req-binding-refusal",
        method: "environment.binding.read",
        fatalDetails: null,
      }),
      POOL_BINDING,
    ];
    const fixture = buildPoolRouteClient(
      linkRequests,
      POOL_ROUTE,
      POOL_BINDING_READ_MANIFEST,
      () => {
        const response = bindingResponses.shift();
        if (response instanceof HostRpcError) throw response;
        if (response === undefined) {
          throw new Error("No binding response remains in the fixture.");
        }
        return response;
      },
    );
    renderRoutedPanel(profile, false, fixture.client, vi.fn());

    await screen.findByText(
      "Couldn't read where this profile will be available.",
    );
    const firstBindingCall = fixture.messenger.calls.find(
      (call) => call.method === "environment.binding.read",
    );
    expect(firstBindingCall?.authority.endpoint.hostId).toBe(POOL_HOST_ID);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByLabelText("One-time code");

    expect(fixture.readMethods).toEqual([
      "environment.status",
      "environment.binding.read",
      "environment.binding.read",
    ]);
    const bindingCalls = fixture.messenger.calls.filter(
      (call) => call.method === "environment.binding.read",
    );
    expect(bindingCalls).toHaveLength(2);
    expect(bindingCalls.map((call) => call.authority.endpoint.hostId)).toEqual([
      POOL_HOST_ID,
      POOL_HOST_ID,
    ]);
    expect(linkRequests).toEqual([
      {
        providerId: "codex",
        profileId: profile.profileId,
        environmentId: ENVIRONMENT_ID,
        createProfile: null,
        replaceAccount: false,
      },
    ]);
  });
});
