import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import {
  providersStartLoginResponseSchemaV13,
  providersListResponseSchema,
  type ProviderCliState,
  type ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
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
  environmentStatusFixture,
  hostEntryFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";

const CAPTURED_HOST_ID = "host-captured-by-picker";
const DEFAULT_HOST_ID = "host-default-for-renderer";
const CAPTURED_ENVIRONMENT_ID = "environment-captured-by-picker";
const DEFAULT_ENVIRONMENT_ID = "environment-default-for-renderer";
const V12 = { major: 1, minor: 2 } as const;
const MANIFEST: ConnectionManifest = {
  "providers.link": V12,
  "providers.linkComplete": V12,
  "providers.linkCancel": { major: 1, minor: 0 },
  "providers.list": { major: 10, minor: 9 },
  "environment.status": { major: 1, minor: 2 },
  "environment.list": { major: 1, minor: 1 },
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
  readonly startRequests: unknown[];
  readonly bindingReads: number[];
}

interface AddHostOptions {
  readonly hostId: string;
  readonly environmentId: string;
  readonly status: EnvironmentStatusResponseV12;
  readonly bindingOwnerKind: "user" | "organization";
  readonly effectiveRole: "owner" | "admin" | "editor" | "viewer";
}

function makeAddHost(options: AddHostOptions): AddHost {
  const linkRequests: ProvidersLinkRequestV12[] = [];
  const startRequests: unknown[] = [];
  const bindingReads: number[] = [];
  const listResponse = providersListResponseSchema.parse({
    providers: [providerState()],
    native: null,
  });
  const { client } = buildEnvironmentClient({
    hostId: options.hostId,
    handlers: {
      "providers.list": () => listResponse,
      "environment.status": () => options.status,
      "environment.host.read": () => {
        bindingReads.push(bindingReads.length + 1);
        return {
          hostId: options.hostId,
          environment: {
            environmentId: options.environmentId,
            ownerKind: options.bindingOwnerKind,
            ownerId:
              options.bindingOwnerKind === "user" ? "owner-test" : "team-test",
            roomId: `room-${options.hostId}`,
            label: options.bindingOwnerKind === "user" ? "Personal" : "Acme",
          },
          explicit: true,
          enrolledByUserId: null,
          canUnbind: false,
          sharingGeneration: null,
        };
      },
      "environment.list": () => ({
        environments: [
          {
            environmentId: options.environmentId,
            ownerKind: options.bindingOwnerKind,
            ownerId:
              options.bindingOwnerKind === "user" ? "owner-test" : "team-test",
            roomId: `room-${options.hostId}`,
            label: options.bindingOwnerKind === "user" ? "Personal" : "Acme",
            effectiveRole: options.effectiveRole,
            kind: options.bindingOwnerKind === "user" ? "personal" : "team",
            hostCount: 1,
            providerHandle:
              options.bindingOwnerKind === "user" ? null : "handle-acme",
          },
        ],
      }),
      "providers.link": (request) => {
        linkRequests.push(request);
        const response: ProvidersLinkResponseV12 = {
          linkId: `link-${options.hostId}`,
          environmentProfileId: `environment-profile-${options.hostId}`,
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
      "providers.startLogin": (request) => {
        startRequests.push(request);
        return providersStartLoginResponseSchemaV13.parse({
          url: null,
          started: false,
          profileId: null,
          userCode: null,
          failure: null,
          pending: null,
          pack: null,
        });
      },
    },
  });
  recordNegotiatedHostManifest(options.hostId, MANIFEST);
  return { client, linkRequests, listResponse, startRequests, bindingReads };
}

afterEach(() => {
  cleanup();
  useProviderProfileAddFlowStore.getState().close();
  hostMocks.clientById.clear();
  hostMocks.clientIds.length = 0;
  hostMocks.directory = [];
  hostMocks.defaultHostId = null;
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    signingInAttempt: null,
    signedOutCause: "retired",
    hostRefusedHeldBearer: false,
  });
  resetNegotiatedManifests();
});

describe("ProviderProfileAddFlowHost", () => {
  it("uses the picker-captured host environment when it opens profile creation", async () => {
    const captured = makeAddHost({
      hostId: CAPTURED_HOST_ID,
      environmentId: CAPTURED_ENVIRONMENT_ID,
      status: environmentStatusFixture({}),
      bindingOwnerKind: "user",
      effectiveRole: "owner",
    });
    const defaultHost = makeAddHost({
      hostId: DEFAULT_HOST_ID,
      environmentId: DEFAULT_ENVIRONMENT_ID,
      status: environmentStatusFixture({}),
      bindingOwnerKind: "user",
      effectiveRole: "owner",
    });
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

  it("keeps a captured Personal binding local when environment.status has no principal", async () => {
    const captured = makeAddHost({
      hostId: CAPTURED_HOST_ID,
      environmentId: CAPTURED_ENVIRONMENT_ID,
      status: environmentStatusFixture({ principal: null }),
      bindingOwnerKind: "user",
      effectiveRole: "owner",
    });
    hostMocks.clientById.set(CAPTURED_HOST_ID, captured.client);
    hostMocks.directory = [hostEntryFixture(CAPTURED_HOST_ID)];
    hostMocks.defaultHostId = CAPTURED_HOST_ID;
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

    await waitFor(() => expect(captured.startRequests).toHaveLength(1));
    expect(captured.linkRequests).toEqual([]);
    expect(captured.bindingReads).toEqual([]);
  });

  it("refuses a viewer's team sign-in and lets an editor start it in the bound environment", async () => {
    const viewerHost = makeAddHost({
      hostId: CAPTURED_HOST_ID,
      environmentId: CAPTURED_ENVIRONMENT_ID,
      status: environmentStatusFixture({
        principal: { kind: "team", teamName: "Acme" },
      }),
      bindingOwnerKind: "organization",
      effectiveRole: "viewer",
    });
    hostMocks.clientById.set(CAPTURED_HOST_ID, viewerHost.client);
    hostMocks.directory = [hostEntryFixture(CAPTURED_HOST_ID)];
    hostMocks.defaultHostId = CAPTURED_HOST_ID;
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

    expect(
      await screen.findByText("Ask a teammate to sign in on Providers."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(viewerHost.linkRequests).toEqual([]);
    expect(viewerHost.startRequests).toEqual([]);

    cleanup();
    hostMocks.clientById.clear();
    const editorHost = makeAddHost({
      hostId: CAPTURED_HOST_ID,
      environmentId: CAPTURED_ENVIRONMENT_ID,
      status: environmentStatusFixture({
        principal: { kind: "team", teamName: "Acme" },
      }),
      bindingOwnerKind: "organization",
      effectiveRole: "editor",
    });
    hostMocks.clientById.set(CAPTURED_HOST_ID, editorHost.client);
    const editorQueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    useProviderProfileAddFlowStore
      .getState()
      .openForHarness("claude", CAPTURED_HOST_ID, () => undefined);
    render(
      <QueryClientProvider client={editorQueryClient}>
        <TooltipProvider>
          <ProviderProfileAddFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in" }),
    );

    await waitFor(() => expect(editorHost.linkRequests).toHaveLength(1));
    expect(editorHost.linkRequests[0]).toEqual({
      providerId: "claude-code",
      profileId: null,
      environmentId: CAPTURED_ENVIRONMENT_ID,
      createProfile: { label: "New profile", shareSkillsAndPlugins: true },
      replaceAccount: false,
    });
    expect(editorHost.startRequests).toEqual([]);
  });
});
