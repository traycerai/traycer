import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { SpendScopeKey } from "@traycer/protocol/host/provider-credential-home-schemas";
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
  bindingAnswer: "bound" as
    | "bound"
    | "own_settings"
    | "pending"
    | "failed"
    | "cached-bound-error"
    | "empty",
  bindingRefetch: vi.fn(),
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
    data: fixture.offersSignIns ? { offersSignIns: true } : undefined,
  }),
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

/** A brokered row admitted in an environment that is not a record. */
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
const CONNECTION_URL = `https://authn.example.test/api/v3/environments/env-a/secrets/harness-connections/${ENTRY_PROFILE_ID}`;

function json(status: number, body: unknown): EnvironmentTransportAnswer {
  return { status, text: JSON.stringify(body) };
}

/** authn's `managed_profile` item for the row's entry, and its connection rows. */
interface ModelledEntry {
  bindingVersion: number;
  spendScopeKey: SpendScopeKey | null;
  connected: boolean;
  signedOutByPerson: boolean;
  mergedInto: string | null;
}

/**
 * authn's routes for one entry, as the final tree serves them. The items GET
 * strips the binding fields unless the reader names `managed_profile_identity`
 * (managed-profile-projection.ts:11-26). A DELETE whose version is not the
 * item's is 409 `binding-changed` (harness-binding-cas.ts:71-93); one that
 * matches deletes the connection rows, re-puts the item at a new version with
 * `custodianSignOutCause` (harness-connections.ts:2700-2745, families.ts:563)
 * and answers whether a row was deleted (:2842-2910).
 */
function modelAuthn(
  entry: ModelledEntry,
): (request: EnvironmentTransportRequest) => EnvironmentTransportAnswer {
  let revision = entry.bindingVersion;
  return (request) => {
    if (request.method === "GET" && request.url === ITEMS_URL) {
      const identity =
        "x-traycer-host-capabilities" in request.headers &&
        request.headers["x-traycer-host-capabilities"]
          .split(",")
          .includes("managed_profile_identity");
      if (!identity && entry.mergedInto !== null)
        return json(200, { items: [] });
      const released = {
        name: "Work account",
        color: null,
        harnessId: "claude",
        accountIdentity: null,
        needsLink: !entry.connected,
        enabled: true,
      };
      const value = identity
        ? {
            ...released,
            bindingVersion: entry.bindingVersion,
            custodyVersion: 1,
            ...(entry.spendScopeKey === null
              ? {}
              : { spendScopeKey: entry.spendScopeKey }),
            ...(entry.signedOutByPerson
              ? { custodianSignOutCause: "signed-out-by-person" }
              : {}),
            ...(entry.mergedInto === null
              ? {}
              : { mergedInto: entry.mergedInto }),
          }
        : released;
      return json(200, {
        items: [
          {
            kind: "managed_profile",
            key: `claude:${ENTRY_PROFILE_ID}`,
            os: "any",
            value,
            revision,
            updatedAt: 1,
            writtenBy: { source: "broker", hostId: null, hostName: null },
          },
        ],
      });
    }
    if (request.method === "DELETE" && request.url === CONNECTION_URL) {
      const expected =
        typeof request.body === "object" &&
        request.body !== null &&
        "expectedBindingVersion" in request.body
          ? request.body.expectedBindingVersion
          : null;
      if (expected !== entry.bindingVersion)
        return json(409, {
          code: "binding-changed",
          message: "The provider connection changed. Refresh and try again.",
        });
      const deleted = entry.connected;
      revision += 1;
      entry.bindingVersion = revision;
      entry.connected = false;
      entry.signedOutByPerson = true;
      return json(200, { disconnected: deleted });
    }
    return json(404, { code: "not_found" });
  };
}

function liveEntry(spendScopeKey: SpendScopeKey | null): ModelledEntry {
  return {
    bindingVersion: 4812,
    spendScopeKey,
    connected: true,
    signedOutByPerson: false,
    mergedInto: null,
  };
}

const ITEMS_READ = {
  method: "GET",
  url: ITEMS_URL,
  capabilities: "managed_profile_identity",
  body: null,
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
  it("names the account-wide effect and waits for confirmation before signing out", async () => {
    fixture.supportsSignOut = true;
    const messenger = installSignOutClient();
    renderDialog(
      profile(
        { kind: "admitted", bindingVersion: 1 },
        credentialHome("brokered"),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out on every host" }),
    );
    expect(messenger.calls).toEqual([]);
    expect(
      screen.getByText("Sign this account out on every host?"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "You’ll need to sign in again to use this account on any host.",
      ),
    ).toBeTruthy();
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
        "Running work finishes first. The account stays in the list and needs a sign-in. This does not reach a computer that already left or has not updated, or a separate Terminal login.",
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
      useAuthStore.setState({ status: "signed-in" });
    });

    afterEach(() => {
      useAuthStore.setState({ status: "signed-out" });
    });

    function installOrderedSignOutClient() {
      const messenger = installSignOutClient();
      messenger.setHandlers({
        "providers.signOutProfile": () => {
          fixture.order.push("host signOutProfile");
          return { signedOut: true };
        },
      });
      return messenger;
    }

    function confirmSignOut(): void {
      fireEvent.click(
        screen.getByRole("button", { name: "Sign out on every host" }),
      );
      fireEvent.click(screen.getByTestId("confirm-action"));
    }

    function failingHostThenSucceeding() {
      const messenger = installOrderedSignOutClient();
      messenger.setHandlers({
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
      fixture.authnAnswer = modelAuthn(liveEntry(SPEND_SCOPE_KEY));
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
      fixture.authnAnswer = modelAuthn(liveEntry(null));
      installOrderedSignOutClient();
      renderDialog(
        unmappedBrokeredProfile({
          kind: "unidentified",
          provenance: "synthetic",
          reason: "setup-token",
        }),
      );

      confirmSignOut();

      await waitFor(() => expect(fixture.openChanges).toEqual([false]));
      expect(fixture.authnRequests).toEqual([ITEMS_READ, disconnectAt(4812)]);
      expect(fixture.order).toEqual([
        "authn GET",
        "authn DELETE",
        "host signOutProfile",
      ]);
    });

    it("changes nothing when the entry is bound to another account", async () => {
      fixture.authnAnswer = modelAuthn(
        liveEntry({ ...SPEND_SCOPE_KEY, accountId: "synthetic-other-account" }),
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
      expect(messenger.calls).toEqual([]);
      expect(fixture.openChanges).toEqual([]);
    });

    it("changes nothing when the disconnect fails", async () => {
      const authn = modelAuthn(liveEntry(SPEND_SCOPE_KEY));
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
      expect(messenger.calls).toEqual([]);
      expect(fixture.openChanges).toEqual([]);
    });

    it("signs out on the host when authn holds the entry but no connection", async () => {
      fixture.authnAnswer = modelAuthn({
        ...liveEntry(SPEND_SCOPE_KEY),
        connected: false,
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

    it("signs out on the host when the entry was folded into another", async () => {
      fixture.authnAnswer = modelAuthn({
        ...liveEntry(SPEND_SCOPE_KEY),
        mergedInto: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      });
      installOrderedSignOutClient();
      renderDialog(unmappedBrokeredProfile(SPEND_SCOPED_IDENTITY));

      confirmSignOut();

      await waitFor(() => expect(fixture.openChanges).toEqual([false]));
      expect(fixture.authnRequests).toEqual([ITEMS_READ]);
      expect(fixture.order).toEqual(["authn GET", "host signOutProfile"]);
    });

    it("completes on a second Sign out when the host failed after the disconnect landed", async () => {
      fixture.authnAnswer = modelAuthn(liveEntry(SPEND_SCOPE_KEY));
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
      ]);
      expect(fixture.order).toEqual([
        "authn GET",
        "authn DELETE",
        "host signOutProfile",
        "authn GET",
        "host signOutProfile",
      ]);
    });
  });
});
