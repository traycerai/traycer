import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import {
  providersListResponseSchema,
  type ProviderCliState,
  type ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import type {
  ProvidersLinkRequestV12,
  ProvidersLinkResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { ProviderProfileAddFlowHost } from "@/components/providers/provider-profile-add-flow-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  buildEnvironmentClient,
  hostEntryFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";

const CAPTURED_HOST_ID = "host-captured-by-picker";
const DEFAULT_HOST_ID = "host-default-for-renderer";
const CAPTURED_ENVIRONMENT_ID = "environment-captured-by-picker";
const DEFAULT_ENVIRONMENT_ID = "environment-default-for-renderer";
const V12 = { major: 1, minor: 2 } as const;
const MANIFEST: ConnectionManifest = {
  "providers.link": V12,
  "providers.linkComplete": V12,
  "providers.linkCancel": V12,
  "providers.list": { major: 10, minor: 9 },
};

const hostMocks = vi.hoisted(() => ({
  clientById: new Map<string, HostClient<HostRpcRegistry>>(),
  clientIds: [] as (string | null)[],
  directory: [] as HostDirectoryEntry[],
  defaultHostId: null as string | null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    hostMocks.clientIds.push(hostId);
    return hostId === null ? null : (hostMocks.clientById.get(hostId) ?? null);
  },
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: hostMocks.directory }),
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => hostMocks.defaultHostId,
}));

function providerState(): ProviderCliState {
  return {
    providerId: "claude-code",
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
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

interface AddHost {
  readonly client: HostClient<HostRpcRegistry>;
  readonly linkRequests: ProvidersLinkRequestV12[];
  readonly listResponse: ProvidersListResponse;
}

function makeAddHost(hostId: string, environmentId: string): AddHost {
  const linkRequests: ProvidersLinkRequestV12[] = [];
  const listResponse = providersListResponseSchema.parse({
    providers: [providerState()],
    native: null,
  });
  const { client } = buildEnvironmentClient({
    hostId,
    handlers: {
      "providers.list": () => listResponse,
      "environment.host.read": () => ({
        hostId,
        environment: {
          environmentId,
          ownerKind: "user",
          ownerId: "owner-test",
          roomId: `room-${hostId}`,
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
          linkId: `link-${hostId}`,
          environmentProfileId: `environment-profile-${hostId}`,
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
    },
  });
  recordNegotiatedHostManifest(hostId, MANIFEST);
  return { client, linkRequests, listResponse };
}

afterEach(() => {
  cleanup();
  useProviderProfileAddFlowStore.getState().close();
  hostMocks.clientById.clear();
  hostMocks.clientIds.length = 0;
  hostMocks.directory = [];
  hostMocks.defaultHostId = null;
  resetNegotiatedManifests();
});

describe("ProviderProfileAddFlowHost", () => {
  it("uses the picker-captured host environment when it opens profile creation", async () => {
    const captured = makeAddHost(CAPTURED_HOST_ID, CAPTURED_ENVIRONMENT_ID);
    const defaultHost = makeAddHost(DEFAULT_HOST_ID, DEFAULT_ENVIRONMENT_ID);
    hostMocks.clientById.set(CAPTURED_HOST_ID, captured.client);
    hostMocks.clientById.set(DEFAULT_HOST_ID, defaultHost.client);
    hostMocks.directory = [
      hostEntryFixture(CAPTURED_HOST_ID),
      hostEntryFixture(DEFAULT_HOST_ID),
    ];
    hostMocks.defaultHostId = DEFAULT_HOST_ID;
    useProviderProfileAddFlowStore
      .getState()
      .openForHarness("claude", CAPTURED_HOST_ID, () => undefined);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProviderProfileAddFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in" }),
    );

    await waitFor(() => expect(captured.linkRequests).toHaveLength(1));
    expect(captured.linkRequests[0]).toEqual({
      providerId: "claude-code",
      profileId: null,
      environmentId: CAPTURED_ENVIRONMENT_ID,
      createProfile: { label: "New profile", shareSkillsAndPlugins: true },
      replaceAccount: false,
    });
    expect(defaultHost.linkRequests).toEqual([]);
    expect(hostMocks.clientIds).toContain(CAPTURED_HOST_ID);
    expect(hostMocks.clientIds).not.toContain(null);
  });
});
