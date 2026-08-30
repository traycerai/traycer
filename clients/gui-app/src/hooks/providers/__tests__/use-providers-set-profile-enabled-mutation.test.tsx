import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderCliState,
  type ProviderProfile,
  type ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys";
import { createAppQueryClient } from "@/lib/query-client";
import {
  useProviderProfileEnablementPending,
  useProvidersSetProfileEnabledForClient,
} from "@/hooks/providers/use-providers-set-profile-enabled-mutation";

const HOST_A: HostDirectoryEntry = {
  hostId: "host-A",
  label: "Host A",
  kind: "local",
  websocketUrl: "ws://host-a.invalid",
  version: "test",
  transportDialability: "dialable",
};

const HOST_B: HostDirectoryEntry = {
  ...HOST_A,
  hostId: "host-B",
  label: "Host B",
};

function findTestHost(hostId: string): HostDirectoryEntry | null {
  if (hostId === HOST_A.hostId) return HOST_A;
  if (hostId === HOST_B.hostId) return HOST_B;
  return null;
}

function profile(enabled: boolean): ProviderProfile {
  return {
    profileId: "work",
    kind: "managed",
    authType: "oauth",
    label: "Work",
    enabled,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: {
      email: "work@example.test",
      tier: "Pro",
      accountUuid: "account-work",
    },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

function providerState(enabled: boolean): ProviderCliState {
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
    profiles: [profile(enabled)],
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
  };
}

function providersList(enabled: boolean): ProvidersListResponse {
  return { providers: [providerState(enabled)], native: null };
}

function providersListWithPersonalProfile(
  enabled: boolean,
): ProvidersListResponse {
  const current = providersList(enabled);
  return {
    ...current,
    providers: current.providers.map((provider) => ({
      ...provider,
      profiles: [
        ...provider.profiles,
        { ...profile(false), profileId: "personal", label: "Personal" },
      ],
    })),
  };
}

function profileEnabled(
  response: ProvidersListResponse | undefined,
  profileId: string,
): boolean | undefined {
  return response?.providers
    .flatMap((provider) => provider.profiles)
    .find((candidate) => candidate.profileId === profileId)?.enabled;
}

function wrapperFor(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("useProvidersSetProfileEnabledForClient host-scoped mutation", () => {
  afterEach(() => cleanup());

  it("optimistically updates and rolls back only the captured host's exact list key while pending is shared", async () => {
    const queryClient = createAppQueryClient();
    let rejectRequest: (error: Error) => void = () => undefined;
    const pendingRequest = new Promise<{
      profileId: string;
      enabled: boolean;
    }>((_resolve, reject) => {
      rejectRequest = (error) => reject(error);
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: findTestHost,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-profile-enabled",
        handlers: {
          "providers.setProfileEnabled": () => pendingRequest,
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-profile-enabled",
      }),
    );
    const clientA = spine.createRequester(HOST_A);
    const wrapper = wrapperFor(queryClient);
    const exactA = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_A.hostId,
      "providers.list",
      { native: null },
    );
    const otherA = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_A.hostId,
      "providers.list",
      { native: null, forceAuthRefresh: true },
    );
    const exactB = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_B.hostId,
      "providers.list",
      { native: null },
    );
    const snapshotA = providersListWithPersonalProfile(false);
    const snapshotB = providersListWithPersonalProfile(false);
    const otherSnapshotA = providersListWithPersonalProfile(false);
    queryClient.setQueryData(exactA, snapshotA);
    queryClient.setQueryData(otherA, otherSnapshotA);
    queryClient.setQueryData(exactB, snapshotB);

    const mutation = renderHook(
      () => useProvidersSetProfileEnabledForClient(clientA, "claude-code"),
      { wrapper },
    );
    const pending = renderHook(
      () => useProviderProfileEnablementPending(clientA, "claude-code"),
      { wrapper },
    );

    act(() => {
      mutation.result.current.mutate({
        providerId: "claude-code",
        profileId: "work",
        enabled: true,
      });
    });

    await waitFor(() => expect(pending.result.current("work")).toBe(true));
    expect(pending.result.current("personal")).toBe(false);
    expect(queryClient.getQueryData(exactA)).toEqual(
      providersListWithPersonalProfile(true),
    );
    expect(queryClient.getQueryData(otherA)).toEqual(otherSnapshotA);
    expect(queryClient.getQueryData(exactB)).toEqual(snapshotB);

    act(() => rejectRequest(new Error("profile write rejected")));

    await waitFor(() => expect(mutation.result.current.isError).toBe(true));
    expect(queryClient.getQueryData(exactA)).toEqual(snapshotA);
    expect(queryClient.getQueryData(otherA)).toEqual(otherSnapshotA);
    expect(queryClient.getQueryData(exactB)).toEqual(snapshotB);
    await waitFor(() => {
      expect(pending.result.current("work")).toBe(false);
      expect(pending.result.current("personal")).toBe(false);
    });
  });

  it("rolls back only the failed profile across overlapping optimistic enables", async () => {
    const queryClient = createAppQueryClient();
    let rejectA: (error: Error) => void = () => undefined;
    let rejectB: (error: Error) => void = () => undefined;
    const pendingA = new Promise<{
      profileId: string;
      enabled: boolean;
    }>((_resolve, reject) => {
      rejectA = reject;
    });
    const pendingB = new Promise<{
      profileId: string;
      enabled: boolean;
    }>((_resolve, reject) => {
      rejectB = reject;
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: findTestHost,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-profile-enabled-overlap",
        handlers: {
          "providers.setProfileEnabled": (variables) => {
            if (variables.profileId === "work") return pendingA;
            return pendingB;
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-profile-enabled-overlap",
      }),
    );
    const clientA = spine.createRequester(HOST_A);
    const wrapper = wrapperFor(queryClient);
    const exactA = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_A.hostId,
      "providers.list",
      { native: null },
    );
    queryClient.setQueryData(exactA, providersListWithPersonalProfile(false));

    const mutation = renderHook(
      () => useProvidersSetProfileEnabledForClient(clientA, "claude-code"),
      { wrapper },
    );
    const pending = renderHook(
      () => useProviderProfileEnablementPending(clientA, "claude-code"),
      { wrapper },
    );

    act(() => {
      mutation.result.current.mutate({
        providerId: "claude-code",
        profileId: "work",
        enabled: true,
      });
    });
    await waitFor(() => expect(pending.result.current("work")).toBe(true));
    expect(profileEnabled(queryClient.getQueryData(exactA), "work")).toBe(true);

    act(() => {
      mutation.result.current.mutate({
        providerId: "claude-code",
        profileId: "personal",
        enabled: true,
      });
    });
    await waitFor(() => expect(pending.result.current("personal")).toBe(true));
    expect(profileEnabled(queryClient.getQueryData(exactA), "work")).toBe(true);
    expect(profileEnabled(queryClient.getQueryData(exactA), "personal")).toBe(
      true,
    );

    act(() => rejectA(new Error("profile A write rejected")));
    await waitFor(() => expect(pending.result.current("work")).toBe(false));

    // The captured-host refetch confirms A is still disabled while B's
    // optimistic write remains pending.
    queryClient.setQueryData<ProvidersListResponse>(exactA, (current) => {
      if (current === undefined) return current;
      return {
        ...current,
        providers: current.providers.map((provider) => ({
          ...provider,
          profiles: provider.profiles.map((profile) =>
            profile.profileId === "work"
              ? { ...profile, enabled: false }
              : profile,
          ),
        })),
      };
    });
    expect(profileEnabled(queryClient.getQueryData(exactA), "work")).toBe(
      false,
    );
    expect(profileEnabled(queryClient.getQueryData(exactA), "personal")).toBe(
      true,
    );

    act(() => rejectB(new Error("profile B write rejected")));
    await waitFor(() => expect(pending.result.current("personal")).toBe(false));

    // B's rollback must not replay its snapshot of A's speculative enable;
    // the disabled row remains closed to selection/send gates.
    expect(profileEnabled(queryClient.getQueryData(exactA), "work")).toBe(
      false,
    );
    expect(profileEnabled(queryClient.getQueryData(exactA), "personal")).toBe(
      false,
    );
  });
});
