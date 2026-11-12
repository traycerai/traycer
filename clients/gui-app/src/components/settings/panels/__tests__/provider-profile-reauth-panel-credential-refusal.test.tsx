import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMBIENT_PROFILE_ID_SENTINEL } from "@traycer/protocol/host/agent/shared";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type {
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
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
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
const clientRef = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));
const routingPlan = vi.hoisted((): { current: HostRpcTierPlan | null } => ({
  current: null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useOptionalHostClient: () => clientRef.current };
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
  useHostCredentialRefusal: () => mocks.credentialRefusal,
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
const ROUTE_MANIFEST: ConnectionManifest = {
  "providers.link": V12,
  "providers.linkComplete": V12,
  "providers.linkCancel": { major: 1, minor: 0 },
  "providers.list": { major: 10, minor: 9 },
  "environment.host.read": { major: 1, minor: 0 },
  "environment.status": { major: 1, minor: 2 },
  "environment.list": { major: 1, minor: 1 },
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

function renderPanel(onCancel: () => void) {
  const profile = managedProfile();
  return render(
    <TooltipProvider>
      <ProviderProfileReauthPanel
        state={codexState(profile)}
        profile={profile}
        replaceAccount={false}
        isLocalHost
        onSameAccountReconnected={null}
        onCancel={onCancel}
        onDone={() => undefined}
      />
    </TooltipProvider>,
  );
}

function buildRouteClient(
  linkRequests: ProvidersLinkRequestV12[],
  route: RouteFixture,
  manifest: ConnectionManifest,
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
  recordNegotiatedHostManifest(HOST_ID, manifest);
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
        profileId: profile.profileId,
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

  it("shows Back for an environment-routed credential refusal and returns to the edit form", async () => {
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
      ROUTE_MANIFEST,
    );
    renderRoutedPanel(managedProfile(), false, client, onCancel);

    expect(await screen.findByTestId("credential-refusal")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
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

describe("<ProviderProfileReauthPanel /> on a host that takes no credentials", () => {
  it("starts no sign-in on mount, shows the refusal and a Back button that cancels", () => {
    mocks.credentialRefusal = REFUSAL;
    const onCancel = vi.fn();
    renderPanel(onCancel);

    expect(mocks.startLoginAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId("credential-refusal").textContent).toBe(REFUSAL);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mocks.startLoginAsync).not.toHaveBeenCalled();
  });

  it("control: on a host that takes sign-ins the panel starts the sign-in on mount and shows no refusal", () => {
    renderPanel(vi.fn());

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
