import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AMBIENT_PROFILE_ID_SENTINEL } from "@traycer/protocol/host/agent/shared";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type {
  ProvidersLinkRequestV12,
  ProvidersLinkResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@/lib/host";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";

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

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useOptionalHostClient: () => clientRef.current };
});

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
  "providers.linkCancel": V12,
  "providers.list": { major: 10, minor: 9 },
  "environment.host.read": { major: 1, minor: 0 },
};

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
): HostClient<HostRpcRegistry> {
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
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
  recordNegotiatedHostManifest(HOST_ID, ROUTE_MANIFEST);
  return client;
}

function renderRoutedPanel(
  profile: ProviderProfile,
  replaceAccount: boolean,
  client: HostClient<HostRpcRegistry>,
  onCancel: () => void,
): void {
  clientRef.current = client;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.credentialRefusal = null;
  clientRef.current = null;
  resetNegotiatedManifests();
});

describe("managed profile reauth routing", () => {
  it("routes ordinary sign-in through @1.2 without replacing the account", async () => {
    const profile = managedProfile();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const client = buildRouteClient(linkRequests);
    renderRoutedPanel(profile, false, client, () => undefined);

    await screen.findByLabelText("One-time code");
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

  it("shows the account-change warning before a Switch account request", async () => {
    const profile = managedProfile();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const client = buildRouteClient(linkRequests);
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

  it("keeps a managed profile on the legacy sign-in flow at @1.1", () => {
    const profile = managedProfile();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const client = buildRouteClient(linkRequests);
    recordNegotiatedHostManifest(HOST_ID, {
      ...ROUTE_MANIFEST,
      "providers.link": { major: 1, minor: 1 },
    });
    clientRef.current = client;
    renderRoutedPanel(profile, false, client, vi.fn());

    expect(mocks.startLoginAsync).toHaveBeenCalledTimes(1);
    expect(mocks.startLoginAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        profileId: profile.profileId,
      }),
    );
    expect(linkRequests).toEqual([]);
  });

  it("keeps an ambient profile on the local flow even when @1.2 is available", () => {
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const profile = ambientProfile();
    const client = buildRouteClient(linkRequests);
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
