import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
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
  supportChecks: [] as Array<{ hostId: string | null; method: string }>,
  openChanges: [] as boolean[],
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => fixture.client };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) => {
    fixture.supportChecks.push({ hostId, method });
    return fixture.supportsSignOut;
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
vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => ({
  useRecolorProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));

import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";

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
    fixture.offersSignIns = false;
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
  });

  it("offers the broker action for a mirror row even when this computer has no credential home", async () => {
    fixture.supportsSignOut = true;
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

    await waitFor(() => expect(messenger.calls).toHaveLength(1));
    expect(messenger.calls[0]?.params).toEqual({
      providerId: "claude-code",
      profileId: "profile-work",
    });
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
});
