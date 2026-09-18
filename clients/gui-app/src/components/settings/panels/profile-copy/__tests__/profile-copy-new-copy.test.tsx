import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { RpcErrorCode } from "@traycer/protocol/framework/versioned-rpc-types";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileCopyFlowHost } from "@/components/settings/panels/profile-copy/profile-copy-flow-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopyOperationsStore } from "@/stores/settings/profile-copy-operations-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  hostDirectoryEntry,
  PREVIEW_REVISION,
  SCOPED_HOST_ID,
  SOURCE_HOST_ID,
  SOURCE_PROFILE_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import {
  claudeProviderState,
  hostOption,
  managedProfile,
} from "./profile-copy-component-fixtures";

const harness = vi.hoisted(
  (): {
    spine: HostClient<HostRpcRegistry> | null;
    hosts: HostScopeOption[];
    scopedHostId: string;
    hostOptionsCalls: number;
  } => ({
    spine: null,
    hosts: [],
    // Hoisted above the imports, so no imported constant can be read here;
    // beforeEach sets the real scoped host id.
    scopedHostId: "",
    hostOptionsCalls: 0,
  }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || harness.spine === null) return null;
    return harness.spine.createRequesterForHostId(hostId);
  },
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => {
    harness.hostOptionsCalls += 1;
    return {
      hosts: harness.hosts,
      activeHostId: harness.scopedHostId,
      isLoading: false,
      directoryResolved: true,
      directoryFailed: false,
      listsResolved: true,
      listsFailed: false,
      retryLists: () => undefined,
      nowMs: 0,
    };
  },
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: () => undefined,
  }),
}));

function resetStores(): void {
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
  useProfileCopyOperationsStore.setState({ handles: [] });
  useSettingsHostScopeStore.getState().setScopedHostId(null);
}

function rpcError(code: RpcErrorCode, method: string): HostRpcError {
  return new HostRpcError({
    code,
    message: "profile copy test error",
    requestId: "req-copy",
    method,
    fatalDetails: null,
  });
}

function previewDestination(
  hostId: string,
  disposition: "automatic" | "unavailable",
  reason: "manual-login-unavailable" | "adapter-not-admitted" | null,
): {
  readonly destinationHostId: string;
  readonly feasibility: {
    readonly automatic:
      | { readonly status: "available"; readonly admissionRevision: string }
      | {
          readonly status: "unavailable";
          readonly reason: "adapter-not-admitted";
        };
    readonly manual: {
      readonly status: "unavailable";
      readonly reason: "manual-login-unavailable";
    };
  };
  readonly disposition: "automatic" | "unavailable";
  readonly reason: "manual-login-unavailable" | "adapter-not-admitted" | null;
  readonly existingProfileId: null;
  readonly destinationProviderEnabled: boolean;
} {
  return {
    destinationHostId: hostId,
    feasibility: {
      automatic:
        disposition === "automatic"
          ? { status: "available", admissionRevision: "b".repeat(64) }
          : { status: "unavailable", reason: "adapter-not-admitted" },
      manual: {
        status: "unavailable",
        reason: "manual-login-unavailable",
      },
    },
    disposition,
    reason,
    existingProfileId: null,
    destinationProviderEnabled: true,
  };
}

describe("ProfileCopyNewCopy", () => {
  beforeEach(() => {
    resetStores();
    harness.spine = null;
    harness.scopedHostId = SCOPED_HOST_ID;
    harness.hostOptionsCalls = 0;
    harness.hosts = [
      hostOption(SOURCE_HOST_ID, "Studio Mac", true),
      hostOption(DEST_HOST_ID, "Linux box", false),
      hostOption(DEST_HOST_TWO_ID, "Old Mac", false),
      hostOption(SCOPED_HOST_ID, "Settings host", false),
      hostOption("other-host", "Other machine", false),
    ];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    resetStores();
    harness.spine = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks preview for the selected list in click order after 400ms, bound to the captured source", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.list": () => ({
          providers: [
            claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
          ],
          native: null,
        }),
        "providers.profileCopy.preview": (params) => ({
          source: {
            sourceHostId: params.sourceHostId,
            sourceProfileId: params.sourceProfileId,
            providerId: params.providerId,
          },
          previewRevision: PREVIEW_REVISION,
          destinations: params.destinationHostIds.map((hostId) =>
            previewDestination(hostId, "automatic", null),
          ),
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-copy",
      }),
    );
    harness.spine = spine;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{props.children}</TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(<ProfileCopyFlowHost />, { wrapper });
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "new",
        sourceHostId: SOURCE_HOST_ID,
        providerId: "claude",
        sourceProfileId: SOURCE_PROFILE_ID,
      });
    });

    fireEvent.click(screen.getByRole("checkbox", { name: /Old Mac/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Linux box/ }));
    expect(
      messenger.calls.some(
        (call) => call.method === "providers.profileCopy.preview",
      ),
    ).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    // Settings moves to another host mid-flow: the real viewing-scope store,
    // plus the host list's active id, then a forced re-render. The flow reads
    // neither, so the preview still goes to the captured source.
    act(() => {
      useSettingsHostScopeStore.getState().setScopedHostId("other-host");
    });
    harness.scopedHostId = "other-host";
    rerender(<ProfileCopyFlowHost />);

    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.preview",
        ),
      ).toBe(true),
    );
    const preview = messenger.calls.find(
      (call) => call.method === "providers.profileCopy.preview",
    );
    expect(preview?.authority.endpoint.hostId).toBe(SOURCE_HOST_ID);
    expect(preview?.params).toMatchObject({
      sourceHostId: SOURCE_HOST_ID,
      destinationHostIds: [DEST_HOST_TWO_ID, DEST_HOST_ID],
    });
  });

  it("disables Copy with the none-routable footer and shows each unavailable reason", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.list": () => ({
          providers: [
            claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
          ],
          native: null,
        }),
        "providers.profileCopy.preview": () => ({
          source: {
            sourceHostId: SOURCE_HOST_ID,
            sourceProfileId: SOURCE_PROFILE_ID,
            providerId: "claude" as const,
          },
          previewRevision: PREVIEW_REVISION,
          destinations: [
            previewDestination(
              DEST_HOST_ID,
              "unavailable",
              "manual-login-unavailable",
            ),
            previewDestination(
              DEST_HOST_TWO_ID,
              "unavailable",
              "adapter-not-admitted",
            ),
          ],
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-copy",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "new",
        sourceHostId: SOURCE_HOST_ID,
        providerId: "claude",
        sourceProfileId: SOURCE_PROFILE_ID,
      });
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Linux box/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Old Mac/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          "None of the selected devices can receive this profile yet.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /^Copy$/ })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByText(
        /Signing in to Claude Code on Linux box from here isn't available yet/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Copying this Claude Code account to Old Mac isn't available yet/,
      ),
    ).toBeTruthy();
  });

  it("records the handle before start and removes it on E_INVALID_ARGUMENT", async () => {
    const queryClient = createAppQueryClient();
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
    let previewCount = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.list": () => ({
          providers: [
            claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
          ],
          native: null,
        }),
        "providers.profileCopy.preview": () => {
          previewCount += 1;
          return {
            source: {
              sourceHostId: SOURCE_HOST_ID,
              sourceProfileId: SOURCE_PROFILE_ID,
              providerId: "claude" as const,
            },
            previewRevision: PREVIEW_REVISION,
            destinations: [previewDestination(DEST_HOST_ID, "automatic", null)],
          };
        },
        "providers.profileCopy.start": () => {
          expect(
            useProfileCopyOperationsStore
              .getState()
              .handles.some((entry) => entry.operationId === uuid),
          ).toBe(true);
          throw rpcError("E_INVALID_ARGUMENT", "providers.profileCopy.start");
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-copy",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "new",
        sourceHostId: SOURCE_HOST_ID,
        providerId: "claude",
        sourceProfileId: SOURCE_PROFILE_ID,
      });
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Linux box/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Copy to 1 device/ }),
      ).toHaveProperty("disabled", false),
    );
    const previewsBeforeStart = previewCount;
    fireEvent.click(screen.getByRole("button", { name: /Copy to 1 device/ }));
    // The start is dispatched asynchronously (FIFO scheduling), so wait for it.
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.start",
        ),
      ).toBe(true),
    );
    const startCall = messenger.calls.find(
      (call) => call.method === "providers.profileCopy.start",
    );
    expect(startCall?.authority.endpoint.hostId).toBe(SOURCE_HOST_ID);
    await waitFor(() =>
      expect(
        screen.getByText(/Something changed since the check/),
      ).toBeTruthy(),
    );
    expect(
      useProfileCopyOperationsStore
        .getState()
        .handles.some((entry) => entry.operationId === uuid),
    ).toBe(false);
    expect(previewCount).toBeGreaterThan(previewsBeforeStart);
  });

  it("keeps the handle and opens the operation view on a non-invalid-argument start error", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.list": () => ({
          providers: [
            claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
          ],
          native: null,
        }),
        "providers.profileCopy.preview": () => ({
          source: {
            sourceHostId: SOURCE_HOST_ID,
            sourceProfileId: SOURCE_PROFILE_ID,
            providerId: "claude" as const,
          },
          previewRevision: PREVIEW_REVISION,
          destinations: [previewDestination(DEST_HOST_ID, "automatic", null)],
        }),
        "providers.profileCopy.start": () => {
          throw rpcError("FORBIDDEN", "providers.profileCopy.start");
        },
        "providers.profileCopy.status": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          outcomes: [],
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-copy",
      }),
    );
    harness.spine = spine;
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "new",
        sourceHostId: SOURCE_HOST_ID,
        providerId: "claude",
        sourceProfileId: SOURCE_PROFILE_ID,
      });
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Linux box/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Copy to 1 device/ }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: /Copy to 1 device/ }));
    await waitFor(() =>
      expect(
        useProfileCopyOperationsStore
          .getState()
          .handles.some((entry) => entry.operationId === uuid),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(useProfileCopyFlowStore.getState().view?.kind).toBe("operation"),
    );
  });

  it("stays on the new view and refetches preview when start answers with no outcomes", async () => {
    const queryClient = createAppQueryClient();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    let previewCount = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.list": () => ({
          providers: [
            claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
          ],
          native: null,
        }),
        "providers.profileCopy.preview": () => {
          previewCount += 1;
          return {
            source: {
              sourceHostId: SOURCE_HOST_ID,
              sourceProfileId: SOURCE_PROFILE_ID,
              providerId: "claude" as const,
            },
            previewRevision: PREVIEW_REVISION,
            destinations: [previewDestination(DEST_HOST_ID, "automatic", null)],
          };
        },
        "providers.profileCopy.start": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          outcomes: [],
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-copy",
      }),
    );
    harness.spine = spine;
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "new",
        sourceHostId: SOURCE_HOST_ID,
        providerId: "claude",
        sourceProfileId: SOURCE_PROFILE_ID,
      });
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Linux box/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Copy to 1 device/ }),
      ).toHaveProperty("disabled", false),
    );
    const previewsBeforeStart = previewCount;
    fireEvent.click(screen.getByRole("button", { name: /Copy to 1 device/ }));
    await waitFor(() =>
      expect(
        screen.getByText(
          /Nothing was started: none of the selected devices can receive this profile right now/,
        ),
      ).toBeTruthy(),
    );
    expect(useProfileCopyFlowStore.getState().view?.kind).toBe("new");
    expect(
      useProfileCopyOperationsStore
        .getState()
        .handles.some((entry) => entry.operationId === uuid),
    ).toBe(false);
    expect(previewCount).toBeGreaterThan(previewsBeforeStart);
    expect(
      track.mock.calls.some(
        (call) => call[0] === AnalyticsEvent.ProfileCopyStarted,
      ),
    ).toBe(false);
  });

  it("does not read host options while the copy dialog is closed", () => {
    const queryClient = createAppQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(harness.hostOptionsCalls).toBe(0);
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "new",
        sourceHostId: SOURCE_HOST_ID,
        providerId: "claude",
        sourceProfileId: SOURCE_PROFILE_ID,
      });
    });
    expect(harness.hostOptionsCalls).toBeGreaterThan(0);
  });
});
