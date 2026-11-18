import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type {
  ProviderCliState,
  ProviderProfile,
  ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import type { SpendScopeKey } from "@traycer/protocol/host/provider-credential-home-schemas";
import type { EnvironmentHostReadResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { ProfileRecordClient } from "@traycer-clients/shared/host-client/profile-record-actions";
import type {
  EnvironmentCloud,
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";

const fixture = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  hostId: "mock-local",
  supportsSignOut: false,
  offersSignIns: false,
  listScope: undefined as ProvidersListResponse["scope"],
  environments: undefined as EnvironmentListResponseV11 | undefined,
  bindingAnswer: "bound" as
    | "bound"
    | "own_settings"
    | "pending"
    | "failed"
    | "cached-bound-error"
    | "empty",
  bindingRefetch: vi.fn(),
  hostBinding: (): EnvironmentHostReadResponseV11 => {
    throw new Error("no host binding answer");
  },
  auth: {
    signOutProfileRecord: vi.fn<ProfileRecordClient["signOutProfileRecord"]>(),
    removeProfileRecord: vi.fn<ProfileRecordClient["removeProfileRecord"]>(),
  },
  supportChecks: [] as Array<{ hostId: string | null; method: string }>,
  openChanges: [] as boolean[],
  authnRequests: [] as Array<{
    method: string;
    url: string;
    capabilities: string | null;
    body: unknown;
  }>,
  authnAnswer: (
    _request: EnvironmentTransportRequest,
  ): EnvironmentTransportAnswer => ({ status: 500, text: null }),
  order: [] as string[],
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => fixture.client,
    useAuthService: () => fixture.auth,
  };
});
vi.mock("@/hooks/environment/use-environment-cloud", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/environment/use-environment-cloud")
    >();
  const cloud: EnvironmentCloud = {
    authnBaseUrl: "https://authn.example.test",
    bearer: { kind: "cloud", getBearerToken: () => "synthetic-person-session" },
    transport: (request) => {
      fixture.authnRequests.push({
        method: request.method,
        url: request.url,
        capabilities:
          "x-traycer-host-capabilities" in request.headers
            ? request.headers["x-traycer-host-capabilities"]
            : null,
        body: request.body,
      });
      fixture.order.push(`authn ${request.method}`);
      return Promise.resolve(fixture.authnAnswer(request));
    },
    onOriginSignIn: () => true,
  };
  return { ...actual, useEnvironmentCloud: () => () => cloud };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) => {
    fixture.supportChecks.push({ hostId, method });
    return fixture.supportsSignOut;
  },
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "environment.host.read" ? true : fixture.supportsSignOut,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => ({ major: 1, minor: 0 }),
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => {
    if (fixture.bindingAnswer === "own_settings")
      return { kind: "own_settings" };
    if (fixture.bindingAnswer === "pending") return { kind: "pending" };
    if (fixture.bindingAnswer === "failed") {
      return { kind: "failed", retry: vi.fn() };
    }
    if (fixture.bindingAnswer === "cached-bound-error") {
      return {
        kind: "binding",
        query: {
          data: { environment: { environmentId: "bound-environment" } },
          isError: true,
          refetch: fixture.bindingRefetch,
        },
      };
    }
    return {
      kind: "binding",
      query: {
        data:
          fixture.bindingAnswer === "bound"
            ? { environment: { environmentId: "bound-environment" } }
            : undefined,
        refetch: fixture.bindingRefetch,
      },
    };
  },
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: fixture.offersSignIns
      ? { offersSignIns: true, scope: fixture.listScope }
      : undefined,
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/bots/use-environment-list-query")
  >()),
  useEnvironmentListQuery: () => ({ data: fixture.environments }),
}));
vi.mock(
  "@/components/settings/personal/personal-page-context",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/personal/personal-page-context")
      >();
    return {
      ...actual,
      usePersonalHostName: () => null,
      usePersonalHostState: () => null,
      usePersonalPageHost: () => ({ hostId: fixture.hostId, client: null }),
    };
  },
);
vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => ({
  useRenameProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-name-profile-record-mutation", () => ({
  useNameProfileRecordForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-account-profile-recolor", () => ({
  useAccountProfileRecolorForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));

import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import {
  profilePersonActionCopy,
  profilePersonActionLabel,
} from "@/components/settings/panels/profile-person-action-copy";
import { useAuthStore } from "@/stores/auth/auth-store";

type CredentialHome = NonNullable<ProviderProfile["credentialHome"]>;

function credentialHome(
  custodyClass: CredentialHome["custodyClass"],
): CredentialHome {
  return {
    homeAddress: "synthetic-home",
    bindingVersion: 1,
    materialRevision: 1,
    custodyVersion: 1,
    custodyClass,
    environmentPresence: null,
    handoffEnvironmentId: null,
    materialFingerprint: "synthetic-material",
    observation: null,
    materialMatchesBinding: "yes",
  };
}

function unmappedBrokeredProfile(
  credentialIdentity: ProviderProfile["credentialIdentity"],
): ProviderProfile {
  return {
    ...profile(
      { kind: "admitted", bindingVersion: 7 },
      {
        ...credentialHome("brokered"),
        environmentPresence: {
          scope: "environment",
          environmentId: "env-a",
          state: "admitted",
          retainedReason: null,
          cause: null,
        },
      },
    ),
    environmentProfileId: ENTRY_PROFILE_ID,
    credentialIdentity,
  };
}

const SPEND_SCOPE_KEY: SpendScopeKey = {
  providerId: "claude-code",
  accountId: "synthetic-account",
  organizationId: null,
};

const SPEND_SCOPED_IDENTITY: ProviderProfile["credentialIdentity"] = {
  kind: "spend-scoped",
  spendScopeKey: SPEND_SCOPE_KEY,
  provenance: "synthetic",
};

const ENTRY_PROFILE_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ITEMS_URL =
  "https://authn.example.test/api/v3/environments/env-a/items?kind=managed_profile";
const CONNECTIONS_URL =
  "https://authn.example.test/api/v3/environments/env-a/secrets/harness-connections";
const CONNECTION_URL = `https://authn.example.test/api/v3/environments/env-a/secrets/harness-connections/${ENTRY_PROFILE_ID}`;
const MEMBER_PROFILE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function hostBinding(
  environmentId: string,
  sharingGeneration: number | null,
): EnvironmentHostReadResponseV11 {
  return {
    hostId: "mock-local",
    environment: {
      environmentId,
      ownerKind: "organization",
      ownerId: "synthetic-team",
      roomId: `room-${environmentId}`,
      label: "Synthetic team",
    },
    explicit: true,
    enrolledByUserId: null,
    canUnbind: true,
    sharingGeneration,
  };
}

function json(status: number, body: unknown): EnvironmentTransportAnswer {
  return { status, text: JSON.stringify(body) };
}

/** authn's family for the row; `member` adds a folded member to its entry. */
interface ModelledFamily {
  bindingVersion: number;
  spendScopeKey: SpendScopeKey | null;
  connection: "connected" | "pending" | null;
  connectionKind: string;
  signedOutByPerson: boolean;
  member: boolean;
}

function readsIdentity(request: EnvironmentTransportRequest): boolean {
  return (
    "x-traycer-host-capabilities" in request.headers &&
    request.headers["x-traycer-host-capabilities"]
      .split(",")
      .includes("managed_profile_identity")
  );
}

function itemValue(
  family: ModelledFamily,
  identity: boolean,
  mergedInto: string | null,
) {
  const released = {
    name: "Work account",
    color: null,
    harnessId: "claude",
    accountIdentity: null,
    needsLink: family.connection !== "connected",
    enabled: true,
  };
  if (!identity) return released;
  return {
    ...released,
    bindingVersion: family.bindingVersion,
    custodyVersion: family.bindingVersion,
    ...(family.spendScopeKey === null
      ? {}
      : { spendScopeKey: family.spendScopeKey }),
    ...(family.signedOutByPerson
      ? { custodianSignOutCause: "signed-out-by-person" }
      : {}),
    ...(mergedInto === null ? {} : { mergedInto }),
  };
}

function itemRow(
  family: ModelledFamily,
  identity: boolean,
  profileId: string,
  mergedInto: string | null,
) {
  return {
    kind: "managed_profile",
    key: `claude:${profileId}`,
    os: "any",
    value: itemValue(family, identity, mergedInto),
    revision: family.bindingVersion,
    updatedAt: 1,
    writtenBy: { source: "live", hostId: null, hostName: null },
  };
}

function itemsAnswer(
  family: ModelledFamily,
  request: EnvironmentTransportRequest,
): EnvironmentTransportAnswer {
  const identity = readsIdentity(request);
  const entry = itemRow(family, identity, ENTRY_PROFILE_ID, null);
  return json(200, {
    items:
      family.member && identity
        ? [
            entry,
            itemRow(family, identity, MEMBER_PROFILE_ID, ENTRY_PROFILE_ID),
          ]
        : [entry],
  });
}

function connectionsAnswer(family: ModelledFamily): EnvironmentTransportAnswer {
  const connection = family.connection;
  return json(200, {
    connections: [
      {
        profileId:
          connection === null
            ? "1e2d3c4b-5a69-4788-9a0b-c1d2e3f4a5b6"
            : ENTRY_PROFILE_ID,
        harnessId: "claude",
        bindingVersion: connection === null ? null : family.bindingVersion,
        kind: family.connectionKind,
        status: connection ?? "absent",
        linkedBy: null,
      },
    ],
  });
}

function disconnectAnswer(
  family: ModelledFamily,
  request: EnvironmentTransportRequest,
): EnvironmentTransportAnswer {
  const expected =
    typeof request.body === "object" &&
    request.body !== null &&
    "expectedBindingVersion" in request.body
      ? request.body.expectedBindingVersion
      : null;
  if (expected !== family.bindingVersion)
    return json(409, {
      code: "binding-changed",
      message: "The provider connection changed. Refresh and try again.",
    });
  const deleted = family.connection !== null;
  family.bindingVersion += 1;
  family.connection = null;
  family.signedOutByPerson = true;
  return json(200, { disconnected: deleted });
}

/** Mirrors authn in the internal repository: managed-profile-projection.ts, harness-binding-cas.ts, harness-connections.ts, families.ts. */
function modelAuthn(
  family: ModelledFamily,
): (request: EnvironmentTransportRequest) => EnvironmentTransportAnswer {
  return (request) => {
    if (request.method === "GET" && request.url === ITEMS_URL)
      return itemsAnswer(family, request);
    if (request.method === "GET" && request.url === CONNECTIONS_URL)
      return connectionsAnswer(family);
    if (request.method === "DELETE" && request.url === CONNECTION_URL)
      return disconnectAnswer(family, request);
    return json(404, { code: "not_found" });
  };
}

function liveFamily(spendScopeKey: SpendScopeKey | null): ModelledFamily {
  return {
    bindingVersion: 4812,
    spendScopeKey,
    connection: "connected",
    connectionKind: spendScopeKey === null ? "setup_token" : "oauth",
    signedOutByPerson: false,
    member: false,
  };
}

const ITEMS_READ = {
  method: "GET",
  url: ITEMS_URL,
  capabilities: "managed_profile_identity",
  body: null,
};

const CONNECTIONS_READ = {
  method: "GET",
  url: CONNECTIONS_URL,
  capabilities: null,
  body: null,
};

const SETUP_TOKEN_IDENTITY: ProviderProfile["credentialIdentity"] = {
  kind: "unidentified",
  provenance: "synthetic",
  reason: "setup-token",
};

function disconnectAt(version: number) {
  return {
    method: "DELETE",
    url: CONNECTION_URL,
    capabilities: null,
    body: { expectedBindingVersion: version },
  };
}

function profile(
  presence: ProviderProfile["presence"],
  home: CredentialHome | undefined,
): ProviderProfile {
  const base: ProviderProfile = {
    profileId: "profile-work",
    kind: "managed",
    authType: "oauth",
    label: "Work account",
    enabled: true,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: null, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
    credentialHome: home,
  };
  return presence === undefined ? base : { ...base, presence };
}

function providerState(current: ProviderProfile): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [current],
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  };
}

function renderDialog(current: ProviderProfile) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileEditDialog
          state={providerState(current)}
          profile={current}
          profiles={[current]}
          canOauth={false}
          oauthUnavailableHint={null}
          startInReauth={false}
          isLocalHost
          open
          onOpenChange={(nextOpen) => {
            fixture.openChanges.push(nextOpen);
          }}
          remainingProfilesAfterRemoval={[]}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function installSignOutClient() {
  let requestId = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestId += 1;
      return `req-sign-out-${String(requestId)}`;
    },
    handlers: { "providers.signOutProfile": () => ({ signedOut: true }) },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "synthetic-sign-out-test",
    }),
  );
  fixture.client = spine.createRequester(mockLocalHostEntry);
  return messenger;
}

/** The real Sonner store: `toastFromHostError` is not mocked in this suite. */
function storedToastTitles(): unknown[] {
  return toast
    .getToasts()
    .flatMap((entry) => ("title" in entry ? [entry.title] : []));
}

describe("<ProfileEditDialog /> sign-out gate", () => {
  beforeEach(() => {
    fixture.client = null;
    fixture.supportsSignOut = false;
    fixture.supportChecks = [];
    fixture.openChanges = [];
    fixture.authnRequests = [];
    fixture.order = [];
    fixture.authnAnswer = () => ({ status: 500, text: null });
    fixture.offersSignIns = false;
    fixture.listScope = undefined;
    fixture.environments = undefined;
    fixture.bindingAnswer = "bound";
    fixture.bindingRefetch.mockReset();
    fixture.auth.signOutProfileRecord.mockReset().mockResolvedValue({
      kind: "ok",
      profileId: "profile-work",
      harnessId: "claude-code",
      recordRevision: "record-rev-1",
    });
    fixture.auth.removeProfileRecord.mockReset().mockResolvedValue({
      kind: "ok",
      profileId: "profile-work",
      harnessId: "claude-code",
      recordRevision: "record-rev-1",
    });
  });

  afterEach(() => {
    cleanup();
    toast.dismiss();
    fixture.client = null;
  });

  it("hides sign out when the host has not negotiated the method", () => {
    renderDialog(
      profile(
        { kind: "admitted", bindingVersion: 1 },
        credentialHome("self-sufficient"),
      ),
    );

    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(fixture.supportChecks).toContainEqual({
      hostId: fixture.hostId,
      method: "providers.signOutProfile",
    });
  });

  it("hides sign out for an admitted profile without credential home", () => {
    fixture.supportsSignOut = true;
    renderDialog(profile({ kind: "admitted", bindingVersion: 1 }, undefined));

    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Sign out on every host" }),
    ).toBeNull();
  });

  it.each(["unknown", "transitional"] as const)(
    "hides sign out for an admitted profile with %s custody",
    (custodyClass) => {
      fixture.supportsSignOut = true;
      renderDialog(
        profile(
          { kind: "admitted", bindingVersion: 1 },
          credentialHome(custodyClass),
        ),
      );

      expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Sign out on every host" }),
      ).toBeNull();
      expect(fixture.supportChecks).toContainEqual({
        hostId: fixture.hostId,
        method: "providers.signOutProfile",
      });
    },
  );

  it("hides sign out for a managed profile without admitted presence", () => {
    fixture.supportsSignOut = true;
    renderDialog(
      profile({ kind: "no-home" }, credentialHome("self-sufficient")),
    );
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("dispatches one sign-out RPC when an admitted profile's control is clicked once", async () => {
    fixture.supportsSignOut = true;
    const messenger = installSignOutClient();
    renderDialog(
      profile(
        { kind: "admitted", bindingVersion: 1 },
        credentialHome("self-sufficient"),
      ),
    );

    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(signOut.closest('[data-slot="dialog-footer"]')).not.toBeNull();

    act(() => {
      fireEvent.click(signOut);
    });

    await waitFor(() => expect(messenger.calls).toHaveLength(1));
    expect(
      messenger.calls.map(({ method, params }) => ({ method, params })),
    ).toEqual([
      {
        method: "providers.signOutProfile",
        params: { providerId: "claude-code", profileId: "profile-work" },
      },
    ]);
  });
  it("words an environment account with no record as a record's Sign out and waits for confirmation", async () => {
    fixture.supportsSignOut = true;
    const messenger = installSignOutClient();
    renderDialog(
      profile(
        { kind: "admitted", bindingVersion: 1 },
        credentialHome("brokered"),
      ),
    );
    const copy = profilePersonActionCopy(
      "sign-out",
      "record",
      "Work account",
      null,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: profilePersonActionLabel("sign-out", "record"),
      }),
    );
    expect(messenger.calls).toEqual([]);
    expect(screen.getByText(copy.title)).toBeTruthy();
    expect(screen.getByText(copy.description)).toBeTruthy();
    expect(screen.getByTestId("confirm-action").textContent).toBe(
      copy.actionLabel,
    );
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => expect(messenger.calls).toHaveLength(1));
    expect(messenger.calls[0]?.params).toEqual({
      providerId: "claude-code",
      profileId: "profile-work",
    });
    expect(fixture.authnRequests).toEqual([]);
  });

  it("offers the record action without local credentials or legacy host support", async () => {
    fixture.supportsSignOut = false;
    fixture.offersSignIns = true;
    const messenger = installSignOutClient();
    const mirrorProfile = { ...profile(undefined, undefined), aliases: [] };
    renderDialog(mirrorProfile);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByTestId("confirm-action")).toBeTruthy();
    expect(
      screen.getByText("Sign out of Work account in this environment?"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Running work finishes first. The account stays in the list and needs a sign-in.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Sign out on every host" }),
    ).toBeNull();
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() =>
      expect(fixture.auth.signOutProfileRecord).toHaveBeenCalledTimes(1),
    );
    expect(fixture.auth.signOutProfileRecord).toHaveBeenCalledWith(
      "bound-environment",
      "claude-code",
      "profile-work",
      null,
    );
    expect(messenger.calls).toEqual([]);
    expect(fixture.bindingRefetch).not.toHaveBeenCalled();
    await waitFor(() => expect(fixture.openChanges).toEqual([false]));
  });

  it.each(["own_settings", "pending", "failed", "empty"] as const)(
    "fails closed with existing copy when the record binding is %s",
    async (bindingAnswer) => {
      fixture.offersSignIns = true;
      fixture.bindingAnswer = bindingAnswer;
      const messenger = installSignOutClient();
      renderDialog({ ...profile(undefined, undefined), aliases: [] });

      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      fireEvent.click(screen.getByTestId("confirm-action"));

      await waitFor(() =>
        expect(storedToastTitles()).toContain("Couldn't sign out."),
      );
      expect(fixture.auth.signOutProfileRecord).not.toHaveBeenCalled();
      expect(fixture.bindingRefetch).not.toHaveBeenCalled();
      expect(messenger.calls).toEqual([]);
      expect(fixture.openChanges).toEqual([]);
    },
  );

  it("fails closed when a cached binding is present but its query failed", async () => {
    fixture.offersSignIns = true;
    fixture.bindingAnswer = "cached-bound-error";
    const messenger = installSignOutClient();
    renderDialog({ ...profile(undefined, undefined), aliases: [] });

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() =>
      expect(storedToastTitles()).toContain("Couldn't sign out."),
    );
    expect(fixture.auth.signOutProfileRecord).not.toHaveBeenCalled();
    expect(fixture.auth.removeProfileRecord).not.toHaveBeenCalled();
    expect(fixture.bindingRefetch).not.toHaveBeenCalled();
    expect(messenger.calls).toEqual([]);
    expect(fixture.openChanges).toEqual([]);
  });

  it("tells the person to refresh when the connection changed, and leaves the retry to them", async () => {
    fixture.supportsSignOut = true;
    const messenger = installSignOutClient();
    messenger.setHandlers({
      "providers.signOutProfile": () => {
        throw new HostRpcError({
          code: "binding-changed",
          message: "The account changed.",
          requestId: "req-sign-out-stale",
          method: "providers.signOutProfile",
          fatalDetails: null,
        });
      },
    });
    renderDialog(
      profile(
        { kind: "admitted", bindingVersion: 1 },
        credentialHome("self-sufficient"),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() =>
      expect(
        messenger.phases.some(
          (event) =>
            event.kind === "response" &&
            event.error?.code === "binding-changed",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(storedToastTitles()).toContain(
        "This connection changed. Refresh and try again.",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Sign out" })
          .disabled,
      ).toBe(false),
    );
    expect(messenger.calls).toHaveLength(1);
    expect(fixture.openChanges).toEqual([]);

    messenger.setHandlers({
      "providers.signOutProfile": () => ({ signedOut: true }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(fixture.openChanges).toEqual([false]));
    expect(messenger.calls).toHaveLength(2);
  });

  describe("an unmapped brokered row", () => {
    beforeEach(() => {
      fixture.supportsSignOut = true;
      fixture.hostBinding = () => hostBinding("env-a", 3);
      useAuthStore.setState({ status: "signed-in" });
    });

    afterEach(() => {
      useAuthStore.setState({ status: "signed-out" });
    });

    function installOrderedSignOutClient() {
      const messenger = installSignOutClient();
      messenger.setHandlers({
        "environment.host.read": () => fixture.hostBinding(),
        "providers.signOutProfile": () => {
          fixture.order.push("host signOutProfile");
          return { signedOut: true };
        },
      });
      return messenger;
    }

    function signOuts(messenger: MockHostMessenger<HostRpcRegistry>) {
      return messenger.calls.filter(
        (call) => call.method === "providers.signOutProfile",
      );
    }

    function confirmSignOut(): void {
      fireEvent.click(
        screen.getByRole("button", {
          name: profilePersonActionLabel("sign-out", "record"),
        }),
      );
      fireEvent.click(screen.getByTestId("confirm-action"));
    }

    function failingHostThenSucceeding() {
      const messenger = installOrderedSignOutClient();
      messenger.setHandlers({
        "environment.host.read": () => fixture.hostBinding(),
        "providers.signOutProfile": () => {
          fixture.order.push("host signOutProfile");
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "synthetic host failure",
            requestId: "req-sign-out-host-failure",
            method: "providers.signOutProfile",
            fatalDetails: null,
          });
        },
      });
      return messenger;
    }

    it("disconnects at authn at the entry's binding version, then signs out on the host", async () => {
      fixture.authnAnswer = modelAuthn(liveFamily(SPEND_SCOPE_KEY));
      installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() => expect(fixture.openChanges).toEqual([false]));
      expect(fixture.authnRequests).toEqual([ITEMS_READ, disconnectAt(4812)]);
      expect(fixture.order).toEqual([
        "authn GET",
        "authn DELETE",
        "host signOutProfile",
      ]);
    });

    it("disconnects a Claude setup token on an entry that holds no account", async () => {
      fixture.authnAnswer = modelAuthn(liveFamily(null));
      installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SETUP_TOKEN_IDENTITY));

      confirmSignOut();

      await waitFor(() => expect(fixture.openChanges).toEqual([false]));
      expect(fixture.authnRequests).toEqual([
        ITEMS_READ,
        CONNECTIONS_READ,
        disconnectAt(4812),
      ]);
      expect(fixture.order).toEqual([
        "authn GET",
        "authn GET",
        "authn DELETE",
        "host signOutProfile",
      ]);
    });

    it("changes nothing for a setup-token row whose entry's connection is not a setup token", async () => {
      fixture.authnAnswer = modelAuthn({
        ...liveFamily(null),
        connectionKind: "oauth",
      });
      const messenger = installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SETUP_TOKEN_IDENTITY));

      confirmSignOut();

      await waitFor(() =>
        expect(storedToastTitles()).toContain(
          "This connection changed. Refresh and try again.",
        ),
      );
      expect(fixture.authnRequests).toEqual([ITEMS_READ, CONNECTIONS_READ]);
      expect(signOuts(messenger)).toEqual([]);
      expect(fixture.openChanges).toEqual([]);
    });

    it("changes nothing when the entry is bound to another account", async () => {
      fixture.authnAnswer = modelAuthn(
        liveFamily({
          ...SPEND_SCOPE_KEY,
          accountId: "synthetic-other-account",
        }),
      );
      const messenger = installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() =>
        expect(storedToastTitles()).toContain(
          "This connection changed. Refresh and try again.",
        ),
      );
      expect(fixture.authnRequests).toEqual([ITEMS_READ]);
      expect(signOuts(messenger)).toEqual([]);
      expect(fixture.openChanges).toEqual([]);
    });

    it("changes nothing when the disconnect fails", async () => {
      const authn = modelAuthn(liveFamily(SPEND_SCOPE_KEY));
      fixture.authnAnswer = (request) =>
        request.method === "DELETE"
          ? json(400, { code: "synthetic-refusal" })
          : authn(request);
      const messenger = installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() =>
        expect(storedToastTitles()).toContain("Couldn't sign out."),
      );
      expect(fixture.authnRequests).toEqual([ITEMS_READ, disconnectAt(4812)]);
      expect(signOuts(messenger)).toEqual([]);
      expect(fixture.openChanges).toEqual([]);
    });

    it("signs out on the host when authn holds the entry but no connection", async () => {
      fixture.authnAnswer = modelAuthn({
        ...liveFamily(SPEND_SCOPE_KEY),
        connection: null,
      });
      installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() => expect(fixture.openChanges).toEqual([false]));
      expect(fixture.authnRequests).toEqual([ITEMS_READ, disconnectAt(4812)]);
      expect(fixture.order).toEqual([
        "authn GET",
        "authn DELETE",
        "host signOutProfile",
      ]);
    });

    it("disconnects the entry a folded member's row was folded into", async () => {
      fixture.authnAnswer = modelAuthn({
        ...liveFamily(SPEND_SCOPE_KEY),
        member: true,
      });
      installOrderedSignOutClient();
      renderDialog({
        ...unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY),
        environmentProfileId: MEMBER_PROFILE_ID,
      });

      confirmSignOut();

      await waitFor(() => expect(fixture.openChanges).toEqual([false]));
      expect(fixture.authnRequests).toEqual([ITEMS_READ, disconnectAt(4812)]);
      expect(fixture.order).toEqual([
        "authn GET",
        "authn DELETE",
        "host signOutProfile",
      ]);
    });

    it("cancels a pending reconnect of an entry the person already signed out", async () => {
      const family: ModelledFamily = {
        ...liveFamily(SPEND_SCOPE_KEY),
        connection: "pending",
        signedOutByPerson: true,
      };
      fixture.authnAnswer = modelAuthn(family);
      installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() => expect(fixture.openChanges).toEqual([false]));
      expect(fixture.authnRequests).toEqual([ITEMS_READ, disconnectAt(4812)]);
      expect(family.connection).toBeNull();
      expect(fixture.order).toEqual([
        "authn GET",
        "authn DELETE",
        "host signOutProfile",
      ]);
    });

    it.each([
      [
        "is not bound at a sharing generation",
        () => hostBinding("env-a", null),
      ],
      [
        "is bound to another environment",
        () => hostBinding("bound-environment", 3),
      ],
      [
        "does not answer its binding",
        (): EnvironmentHostReadResponseV11 => {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "synthetic binding failure",
            requestId: "req-binding-failure",
            method: "environment.host.read",
            fatalDetails: null,
          });
        },
      ],
    ])("changes nothing when this computer %s", async (_state, binding) => {
      fixture.hostBinding = binding;
      fixture.authnAnswer = modelAuthn(liveFamily(SPEND_SCOPE_KEY));
      const messenger = installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() =>
        expect(storedToastTitles()).toContain(
          "This connection changed. Refresh and try again.",
        ),
      );
      expect(fixture.authnRequests).toEqual([]);
      expect(signOuts(messenger)).toEqual([]);
      expect(fixture.openChanges).toEqual([]);
    });

    it("changes nothing when this computer's binding moves after a setup token's connection read", async () => {
      const answers = [
        hostBinding("env-a", 3),
        hostBinding("env-a", 3),
        hostBinding("env-b", 4),
      ];
      fixture.hostBinding = () => answers.shift() ?? hostBinding("env-b", 4);
      fixture.authnAnswer = modelAuthn(liveFamily(null));
      const messenger = installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SETUP_TOKEN_IDENTITY));

      confirmSignOut();

      await waitFor(() =>
        expect(storedToastTitles()).toContain(
          "This connection changed. Refresh and try again.",
        ),
      );
      expect(fixture.authnRequests).toEqual([ITEMS_READ, CONNECTIONS_READ]);
      expect(signOuts(messenger)).toEqual([]);
      expect(fixture.openChanges).toEqual([]);
    });

    it("changes nothing when this computer's binding moves during the sign-out", async () => {
      const answers = [hostBinding("env-a", 3), hostBinding("env-b", 4)];
      fixture.hostBinding = () => answers.shift() ?? hostBinding("env-b", 4);
      fixture.authnAnswer = modelAuthn(liveFamily(SPEND_SCOPE_KEY));
      const messenger = installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() =>
        expect(storedToastTitles()).toContain(
          "This connection changed. Refresh and try again.",
        ),
      );
      expect(fixture.authnRequests).toEqual([ITEMS_READ]);
      expect(signOuts(messenger)).toEqual([]);
      expect(fixture.openChanges).toEqual([]);
    });

    it("signs out on the host when the disconnect finds no family", async () => {
      const authn = modelAuthn(liveFamily(SPEND_SCOPE_KEY));
      fixture.authnAnswer = (request) =>
        request.method === "DELETE"
          ? json(404, {
              code: "harness_profile_unknown",
              message: "the environment has no owning managed profile",
            })
          : authn(request);
      installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() => expect(fixture.openChanges).toEqual([false]));
      expect(fixture.authnRequests).toEqual([ITEMS_READ, disconnectAt(4812)]);
      expect(fixture.order).toEqual([
        "authn GET",
        "authn DELETE",
        "host signOutProfile",
      ]);
    });

    it("changes nothing when the entry moves between the read and the disconnect", async () => {
      const family = liveFamily(SPEND_SCOPE_KEY);
      const authn = modelAuthn(family);
      fixture.authnAnswer = (request) => {
        if (request.method === "DELETE") family.bindingVersion += 1;
        return authn(request);
      };
      const messenger = installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() =>
        expect(storedToastTitles()).toContain("Couldn't sign out."),
      );
      expect(fixture.authnRequests).toEqual([ITEMS_READ, disconnectAt(4812)]);
      expect(family.connection).toBe("connected");
      expect(signOuts(messenger)).toEqual([]);
      expect(fixture.openChanges).toEqual([]);
    });

    it("completes on a second Sign out when the host failed after the disconnect landed", async () => {
      fixture.authnAnswer = modelAuthn(liveFamily(SPEND_SCOPE_KEY));
      const messenger = failingHostThenSucceeding();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() =>
        expect(storedToastTitles()).toContain("Couldn't sign out."),
      );
      expect(fixture.openChanges).toEqual([]);
      await waitFor(() =>
        expect(
          screen.getByTestId<HTMLButtonElement>("confirm-action").disabled,
        ).toBe(false),
      );

      messenger.setHandlers({
        "environment.host.read": () => fixture.hostBinding(),
        "providers.signOutProfile": () => {
          fixture.order.push("host signOutProfile");
          return { signedOut: true };
        },
      });
      fireEvent.click(screen.getByTestId("confirm-action"));

      await waitFor(() => expect(fixture.openChanges).toEqual([false]));
      expect(fixture.authnRequests).toEqual([
        ITEMS_READ,
        disconnectAt(4812),
        ITEMS_READ,
        disconnectAt(4813),
      ]);
      expect(fixture.order).toEqual([
        "authn GET",
        "authn DELETE",
        "host signOutProfile",
        "authn GET",
        "authn DELETE",
        "host signOutProfile",
      ]);
    });
  });
});

type EnvironmentPresence = CredentialHome["environmentPresence"];

function environmentRow(
  environmentId: string,
  ownerKind: "user" | "organization",
  label: string,
): EnvironmentListResponseV11["environments"][number] {
  return {
    environmentId,
    ownerKind,
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label,
    effectiveRole: ownerKind === "user" ? "owner" : "admin",
    kind: ownerKind === "user" ? "personal" : "team",
    hostCount: 1,
    providerHandle: null,
  };
}

function namingPresence(environmentId: string): EnvironmentPresence {
  return {
    scope: "environment",
    environmentId,
    state: "admitted",
    retainedReason: null,
    cause: null,
  };
}

function recordRowWithFolder(presence: EnvironmentPresence): ProviderProfile {
  return {
    ...profile(undefined, {
      ...credentialHome("self-sufficient"),
      environmentPresence: presence,
    }),
    aliases: [],
  };
}

const RECORD_ROW_WITHOUT_FOLDER: ProviderProfile = {
  ...profile(undefined, undefined),
  aliases: [],
};

describe("<ProfileEditDialog /> record sign-out and remove name the environment", () => {
  beforeEach(() => {
    fixture.client = null;
    fixture.offersSignIns = true;
    fixture.listScope = undefined;
    fixture.environments = undefined;
    fixture.bindingAnswer = "bound";
  });

  afterEach(() => {
    cleanup();
    fixture.client = null;
  });

  it.each([
    {
      name: "a team the row's presence names",
      row: recordRowWithFolder(namingPresence("env-team")),
      scope: undefined,
      environmentName: "Acme",
    },
    {
      name: "Personal when the row's presence names the person's own environment",
      row: recordRowWithFolder(namingPresence("env-personal")),
      scope: undefined,
      environmentName: "Personal",
    },
    {
      name: "Personal for a record row with a folder here whose presence names none",
      row: recordRowWithFolder(null),
      scope: "personal" as const,
      environmentName: "Personal",
    },
    {
      name: "Personal for a record row with a folder here that signed out locally",
      row: recordRowWithFolder({
        scope: "local",
        state: "absent",
        retainedReason: null,
        cause: "signed-out-by-person",
      }),
      scope: "personal" as const,
      environmentName: "Personal",
    },
    {
      name: "Personal for a record row with no folder here on a Personal computer",
      row: RECORD_ROW_WITHOUT_FOLDER,
      scope: "personal" as const,
      environmentName: "Personal",
    },
    {
      name: "the fallback for a record row with no folder here on a team computer",
      row: RECORD_ROW_WITHOUT_FOLDER,
      scope: null,
      environmentName: "this environment",
    },
  ])("titles Sign out with $name", ({ row, scope, environmentName }) => {
    fixture.listScope = scope;
    fixture.environments = {
      environments: [
        environmentRow("env-personal", "user", "Personal"),
        environmentRow("env-team", "organization", "Acme"),
      ],
    };
    renderDialog(row);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(screen.getByText(/^Sign out of Work account in /).textContent).toBe(
      `Sign out of Work account in ${environmentName}?`,
    );
  });

  it("keeps the fallback for an environment the list cannot name, even on Personal", () => {
    fixture.listScope = "personal";
    fixture.environments = undefined;
    renderDialog(recordRowWithFolder(namingPresence("env-team")));

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(screen.getByText(/^Sign out of Work account in /).textContent).toBe(
      "Sign out of Work account in this environment?",
    );
  });

  it("names the same environment in the Remove body", () => {
    fixture.listScope = "personal";
    renderDialog(RECORD_ROW_WITHOUT_FOLDER);

    fireEvent.click(screen.getByRole("button", { name: "Remove profile" }));

    expect(
      screen.getByText(/^Remove Work account from every list in /).textContent,
    ).toContain("every list in Personal.");
  });
});
