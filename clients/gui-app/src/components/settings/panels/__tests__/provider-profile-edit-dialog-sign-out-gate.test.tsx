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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  supportChecks: [] as Array<{ hostId: string | null; method: string }>,
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

function profile(presence: ProviderProfile["presence"]): ProviderProfile {
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
          onOpenChange={() => undefined}
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

describe("<ProfileEditDialog /> sign-out gate", () => {
  beforeEach(() => {
    fixture.client = null;
    fixture.supportsSignOut = false;
    fixture.supportChecks = [];
  });

  afterEach(() => {
    cleanup();
    fixture.client = null;
  });

  it("hides sign out when the host has not negotiated the method", () => {
    renderDialog(profile({ kind: "admitted", bindingVersion: 1 }));

    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(fixture.supportChecks).toContainEqual({
      hostId: fixture.hostId,
      method: "providers.signOutProfile",
    });
  });

  it("hides sign out for a managed profile without an admitted home", () => {
    fixture.supportsSignOut = true;
    renderDialog(profile({ kind: "no-home" }));

    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("dispatches one sign-out RPC when an admitted profile's control is clicked once", async () => {
    fixture.supportsSignOut = true;
    const messenger = installSignOutClient();
    renderDialog(profile({ kind: "admitted", bindingVersion: 1 }));

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
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
});
