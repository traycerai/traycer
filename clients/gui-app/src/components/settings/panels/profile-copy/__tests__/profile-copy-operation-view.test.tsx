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
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { clearProfileCopyObservations } from "@/hooks/providers/profile-copy/profile-copy-observations";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopyOperationsStore } from "@/stores/settings/profile-copy-operations-store";
import {
  ATTEMPT_TWO_ID,
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  hostDirectoryEntry,
  OPERATION_ID,
  PREVIEW_REVISION,
  previewRecord,
  profileCopyAttempt,
  recordedOutcome,
  RETRY_REQUEST_ID,
  RETRY_REQUEST_ID_TWO,
  SOURCE_HOST_ID,
  SOURCE_PROFILE_ID,
  TARGET_PROFILE_ID,
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
  } => ({ spine: null, hosts: [] }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || harness.spine === null) return null;
    return harness.spine.createRequesterForHostId(hostId);
  },
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: harness.hosts,
    activeHostId: SOURCE_HOST_ID,
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
}));

function resetStores(): void {
  // reset() also forgets the account-scoped retry request ids.
  useProfileCopyFlowStore.getState().reset();
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
  useProfileCopyOperationsStore.setState({ handles: [] });
  clearProfileCopyObservations();
}

function rpcError(code: RpcErrorCode, method: string): HostRpcError {
  return new HostRpcError({
    code,
    message: "profile copy test error",
    requestId: "req-op",
    method,
    fatalDetails: null,
  });
}

function plantHandle(startAcknowledged: boolean): void {
  useProfileCopyOperationsStore.getState().record({
    operationId: OPERATION_ID,
    sourceHostId: SOURCE_HOST_ID,
    sourceProfileId: SOURCE_PROFILE_ID,
    providerId: "claude",
    destinationHostIds: [DEST_HOST_ID, DEST_HOST_TWO_ID, "pi-host"],
    previewRevision: PREVIEW_REVISION,
    previewRecords: [
      previewRecord({
        destinationHostId: DEST_HOST_ID,
        disposition: "automatic",
      }),
      previewRecord({
        destinationHostId: DEST_HOST_TWO_ID,
        disposition: "unavailable",
        reason: "update-required",
      }),
      previewRecord({ destinationHostId: "pi-host", disposition: "automatic" }),
    ],
    createdAt: 1_000,
    startAcknowledged,
    cancelConfirmedAt: null,
    settled: false,
    settlementReadAt: 0,
  });
}

describe("ProfileCopyOperationView", () => {
  beforeEach(() => {
    resetStores();
    harness.spine = null;
    harness.hosts = [
      hostOption(SOURCE_HOST_ID, "Studio Mac", true),
      hostOption(DEST_HOST_ID, "Linux box", false),
      hostOption(DEST_HOST_TWO_ID, "Old Mac", false),
      hostOption("pi-host", "Pi", false),
    ];
  });
  afterEach(() => {
    cleanup();
    resetStores();
    harness.spine = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("offers Start again on FORBIDDEN with an unacknowledged handle and resends the same request", async () => {
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
        "providers.profileCopy.status": () => {
          throw rpcError("FORBIDDEN", "providers.profileCopy.status");
        },
        "providers.profileCopy.start": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: OPERATION_ID,
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(false);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() =>
      expect(screen.getByText(/may not have started/)).toBeTruthy(),
    );
    expect(
      messenger.calls.some(
        (call) => call.method === "providers.profileCopy.start",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.start",
        ),
      ).toBe(true),
    );
    expect(
      messenger.calls.find(
        (call) => call.method === "providers.profileCopy.start",
      )?.params,
    ).toMatchObject({
      operationId: OPERATION_ID,
      previewRevision: PREVIEW_REVISION,
      sourceHostId: SOURCE_HOST_ID,
    });
    expect(
      messenger.calls.find(
        (call) => call.method === "providers.profileCopy.start",
      )?.authority.endpoint.hostId,
    ).toBe(SOURCE_HOST_ID);
  });

  it("does not offer Start again when FORBIDDEN and the start was acknowledged", async () => {
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
        "providers.profileCopy.status": () => {
          throw rpcError("FORBIDDEN", "providers.profileCopy.status");
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(true);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() =>
      expect(
        screen.getByText(/couldn't confirm this copy right now/i),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Start again" })).toBeNull();
  });

  it("keeps the current Retry replacement when the next status read fails", async () => {
    const queryClient = createAppQueryClient();
    const REPLACEMENT = "55555555-5555-4555-8555-555555555558";
    let statusFails = false;
    const piAttempt = (attemptId: string) =>
      profileCopyAttempt({ attemptId, destinationHostId: "pi-host" });
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
        "providers.profileCopy.status": () => {
          if (statusFails) {
            throw rpcError("FORBIDDEN", "providers.profileCopy.status");
          }
          return {
            sourceHostId: SOURCE_HOST_ID,
            operationId: OPERATION_ID,
            outcomes: [
              recordedOutcome({
                state: "signed-in",
                attempt: profileCopyAttempt({
                  destinationHostId: DEST_HOST_ID,
                }),
              }),
              recordedOutcome({
                state: "quarantined",
                reason: "writer-unconfirmed",
                attempt: piAttempt(ATTEMPT_TWO_ID),
              }),
            ],
          };
        },
        "providers.profileCopy.draftStatus": (params) => ({
          result: "current" as const,
          outcome: recordedOutcome({
            state: "signed-in",
            attempt: params.attempt,
          }),
        }),
        "providers.profileCopy.retry": () => ({
          result: "current" as const,
          outcome: recordedOutcome({
            state: "preparing",
            revision: 1,
            attempt: piAttempt(REPLACEMENT),
          }),
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(true);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() =>
      expect(screen.getByText("Interrupted — retry required")).toBeTruthy(),
    );
    // The next status read (the one the retry triggers) fails.
    statusFails = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.retry",
        ),
      ).toBe(true),
    );
    // The replacement is shown anyway: the old interrupted row and its Retry
    // are gone, though no status read could confirm them.
    await waitFor(() =>
      expect(screen.queryByText("Interrupted — retry required")).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows mixed rows and reuses retryRequestId on a second click at the same revision", async () => {
    const queryClient = createAppQueryClient();
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(RETRY_REQUEST_ID)
      .mockReturnValueOnce(RETRY_REQUEST_ID_TWO);
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
        "providers.profileCopy.status": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: OPERATION_ID,
          outcomes: [
            recordedOutcome({
              state: "signed-in",
              attempt: profileCopyAttempt({ destinationHostId: DEST_HOST_ID }),
            }),
            recordedOutcome({
              state: "quarantined",
              reason: "writer-unconfirmed",
              attempt: profileCopyAttempt({
                attemptId: ATTEMPT_TWO_ID,
                destinationHostId: "pi-host",
              }),
              targetProfileId: TARGET_PROFILE_ID,
            }),
          ],
        }),
        "providers.profileCopy.draftStatus": (params) => ({
          result: "current" as const,
          outcome: recordedOutcome({
            state: "signed-in",
            attempt: params.attempt,
          }),
        }),
        "providers.profileCopy.retry": () => ({
          result: "unavailable" as const,
          outcome: recordedOutcome({
            state: "quarantined",
            attempt: profileCopyAttempt({
              attemptId: ATTEMPT_TWO_ID,
              destinationHostId: "pi-host",
            }),
          }),
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(true);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() => expect(screen.getByText("Signed in")).toBeTruthy());
    expect(screen.getByText(/Not included in this copy/)).toBeTruthy();
    expect(screen.getByText("Interrupted — retry required")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.retry",
        ),
      ).toBe(true),
    );
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.retry",
        ),
      ).toHaveLength(2),
    );
    const retries = messenger.calls.filter(
      (call) => call.method === "providers.profileCopy.retry",
    );
    expect(retries[0]?.authority.endpoint.hostId).toBe(SOURCE_HOST_ID);
    expect(retries[0]?.params).toMatchObject({
      retryRequestId: RETRY_REQUEST_ID,
    });
    expect(retries[1]?.params).toMatchObject({
      retryRequestId: RETRY_REQUEST_ID,
    });
    expect(screen.getByText(/Retry isn't possible right now/)).toBeTruthy();
    const draftReads = messenger.calls.filter(
      (call) => call.method === "providers.profileCopy.draftStatus",
    );
    expect(
      draftReads.every(
        (call) => call.authority.endpoint.hostId === DEST_HOST_ID,
      ),
    ).toBe(true);
  });

  it("puts operation Cancel behind a destructive confirm and keeps finished rows", async () => {
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
        "providers.profileCopy.status": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: OPERATION_ID,
          outcomes: [
            recordedOutcome({ state: "signed-in" }),
            recordedOutcome({
              state: "sign-in-required",
              attempt: profileCopyAttempt({
                attemptId: ATTEMPT_TWO_ID,
                destinationHostId: DEST_HOST_TWO_ID,
              }),
            }),
          ],
        }),
        "providers.profileCopy.draftStatus": (params) => ({
          result: "current" as const,
          outcome: recordedOutcome({
            state:
              params.attempt.destinationHostId === DEST_HOST_ID
                ? "signed-in"
                : "sign-in-required",
            attempt: params.attempt,
          }),
        }),
        "providers.profileCopy.cancel": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: OPERATION_ID,
          outcomes: [
            recordedOutcome({ state: "signed-in" }),
            recordedOutcome({
              state: "cancelled",
              reason: "cancelled",
              attempt: profileCopyAttempt({
                attemptId: ATTEMPT_TWO_ID,
                destinationHostId: DEST_HOST_TWO_ID,
              }),
            }),
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(true);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel copy" })).toBeTruthy(),
    );
    expect(
      messenger.calls.some(
        (call) => call.method === "providers.profileCopy.cancel",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel copy" }));
    fireEvent.click(
      within(screen.getByTestId("confirm-destructive-dialog")).getByRole(
        "button",
        { name: "Cancel copy" },
      ),
    );
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.cancel",
        ),
      ).toBe(true),
    );
    expect(
      messenger.calls.find(
        (call) => call.method === "providers.profileCopy.cancel",
      )?.authority.endpoint.hostId,
    ).toBe(SOURCE_HOST_ID);
    await waitFor(() => expect(screen.getByText("Cancelled")).toBeTruthy());
    expect(screen.getByText("Signed in")).toBeTruthy();
  });

  it("sends no cancel on close and reopening from Recent re-reads status without start", async () => {
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
        "providers.profileCopy.status": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: OPERATION_ID,
          outcomes: [recordedOutcome({ state: "signed-in" })],
        }),
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: recordedOutcome({ state: "signed-in" }),
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(true);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() => expect(screen.getByText("Signed in")).toBeTruthy());
    const statusBeforeClose = messenger.calls.filter(
      (call) => call.method === "providers.profileCopy.status",
    ).length;
    // The footer's outline Close, not the dialog's ghost corner X (same
    // accessible name).
    const footerClose = screen
      .getAllByRole("button", { name: "Close" })
      .find((button) => button.getAttribute("data-variant") === "outline");
    expect(footerClose).toBeDefined();
    if (footerClose === undefined) return;
    fireEvent.click(footerClose);
    expect(
      messenger.calls.some(
        (call) => call.method === "providers.profileCopy.cancel",
      ),
    ).toBe(false);
    expect(useProfileCopyFlowStore.getState().view).toBeNull();
    // Reopen as after an app restart: nothing cached, only the persisted
    // handle. Status must be read again, and start must never be re-sent.
    queryClient.clear();
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() =>
      expect(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.status",
        ).length,
      ).toBeGreaterThan(statusBeforeClose),
    );
    expect(
      messenger.calls.some(
        (call) => call.method === "providers.profileCopy.start",
      ),
    ).toBe(false);
  });

  it("fires profile_copy_attempt_settled once for a settled row", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const queryClient = createAppQueryClient();
    const track = vi.spyOn(Analytics.getInstance(), "track");
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
        "providers.profileCopy.status": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: OPERATION_ID,
          outcomes: [
            recordedOutcome({ state: "signed-in", reason: null }),
            recordedOutcome({
              state: "preparing",
              attempt: profileCopyAttempt({
                attemptId: ATTEMPT_TWO_ID,
                destinationHostId: DEST_HOST_TWO_ID,
              }),
            }),
          ],
        }),
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: recordedOutcome({ state: "signed-in", reason: null }),
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(true);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() =>
      expect(track).toHaveBeenCalledWith(
        AnalyticsEvent.ProfileCopyAttemptSettled,
        {
          provider: "claude-code",
          state: "signed-in",
          reason: "none",
        },
      ),
    );
    expect(
      track.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.ProfileCopyAttemptSettled,
      ),
    ).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(
      track.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.ProfileCopyAttemptSettled,
      ),
    ).toHaveLength(1);
  });

  it("marks the handle settled only once every routable destination is settled, and unmarks it on a later read", async () => {
    const queryClient = createAppQueryClient();
    const piAttempt = profileCopyAttempt({
      attemptId: ATTEMPT_TWO_ID,
      destinationHostId: "pi-host",
    });
    let piState: "preparing" | "cancelled" = "preparing";
    let statusReads = 0;
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
        "providers.profileCopy.status": () => {
          statusReads += 1;
          return {
            sourceHostId: SOURCE_HOST_ID,
            operationId: OPERATION_ID,
            outcomes: [
              recordedOutcome({ state: "signed-in", reason: null }),
              recordedOutcome({ state: piState, attempt: piAttempt }),
            ],
          };
        },
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: recordedOutcome({ state: "signed-in", reason: null }),
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(true);
    const settled = (): boolean | undefined =>
      useProfileCopyOperationsStore.getState().handles[0]?.settled;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() => expect(statusReads).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled()).toBe(false);

    // The unavailable destination got no attempt; the other two settle.
    piState = "cancelled";
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitFor(() => expect(settled()).toBe(true));

    piState = "preparing";
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitFor(() => expect(settled()).toBe(false));
  });

  it("still offers Cancel copy and Retry after a FORBIDDEN cancel and a reopen", async () => {
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
        "providers.profileCopy.status": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: OPERATION_ID,
          outcomes: [
            recordedOutcome({ state: "preparing" }),
            recordedOutcome({
              state: "quarantined",
              reason: "writer-unconfirmed",
              attempt: profileCopyAttempt({
                attemptId: ATTEMPT_TWO_ID,
                destinationHostId: "pi-host",
              }),
              targetProfileId: TARGET_PROFILE_ID,
            }),
          ],
        }),
        "providers.profileCopy.cancel": () => {
          throw rpcError("FORBIDDEN", "providers.profileCopy.cancel");
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(true);
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel copy" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel copy" }));
    fireEvent.click(
      within(screen.getByTestId("confirm-destructive-dialog")).getByRole(
        "button",
        { name: "Cancel copy" },
      ),
    );
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.cancel",
        ),
      ).toBe(true),
    );
    // The cancel has FAILED (its error is on screen) before the dialog closes.
    await waitFor(() =>
      expect(
        screen.getByText(/couldn't confirm your devices right now/),
      ).toBeTruthy(),
    );
    unmount();
    expect(
      useProfileCopyOperationsStore.getState().handles[0]?.cancelConfirmedAt,
    ).toBeNull();
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel copy" })).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("marks a confirmed cancel and offers Copy again instead of Retry", async () => {
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
        "providers.profileCopy.status": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: OPERATION_ID,
          outcomes: [
            recordedOutcome({ state: "preparing" }),
            recordedOutcome({
              state: "quarantined",
              reason: "writer-unconfirmed",
              attempt: profileCopyAttempt({
                attemptId: ATTEMPT_TWO_ID,
                destinationHostId: "pi-host",
              }),
              targetProfileId: TARGET_PROFILE_ID,
            }),
          ],
        }),
        "providers.profileCopy.cancel": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: OPERATION_ID,
          outcomes: [
            recordedOutcome({ state: "preparing" }),
            recordedOutcome({
              state: "quarantined",
              reason: "writer-unconfirmed",
              attempt: profileCopyAttempt({
                attemptId: ATTEMPT_TWO_ID,
                destinationHostId: "pi-host",
              }),
              targetProfileId: TARGET_PROFILE_ID,
            }),
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(true);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel copy" }));
    fireEvent.click(
      within(screen.getByTestId("confirm-destructive-dialog")).getByRole(
        "button",
        { name: "Cancel copy" },
      ),
    );
    await waitFor(() =>
      expect(
        useProfileCopyOperationsStore.getState().handles[0]?.cancelConfirmedAt,
      ).not.toBeNull(),
    );
    expect(
      typeof useProfileCopyOperationsStore.getState().handles[0]
        ?.cancelConfirmedAt,
    ).toBe("number");
    await waitFor(() =>
      expect(
        screen.getByText("Cancelling — waiting for Linux box to answer."),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Copy again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // The preparing row has not settled, so the host has not shown the fence:
    // Cancel stays offered (the host's cancel is idempotent).
    expect(screen.getByRole("button", { name: "Cancel copy" })).toBeTruthy();
  });

  it("returns to the new-copy view when Start again answers with no outcomes", async () => {
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
        "providers.profileCopy.status": () => {
          throw rpcError("FORBIDDEN", "providers.profileCopy.status");
        },
        "providers.profileCopy.start": () => ({
          sourceHostId: SOURCE_HOST_ID,
          operationId: OPERATION_ID,
          outcomes: [],
        }),
        "providers.profileCopy.preview": () => ({
          source: {
            sourceHostId: SOURCE_HOST_ID,
            sourceProfileId: SOURCE_PROFILE_ID,
            providerId: "claude" as const,
          },
          previewRevision: PREVIEW_REVISION,
          destinations: [],
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
        bearerToken: "tok-op",
      }),
    );
    harness.spine = spine;
    plantHandle(false);
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyFlowHost />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useProfileCopyFlowStore.getState().open({
        kind: "operation",
        operationId: OPERATION_ID,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    await waitFor(() =>
      expect(useProfileCopyFlowStore.getState().view?.kind).toBe("new"),
    );
    expect(useProfileCopyFlowStore.getState().view).toMatchObject({
      kind: "new",
      sourceHostId: SOURCE_HOST_ID,
      providerId: "claude",
      sourceProfileId: SOURCE_PROFILE_ID,
    });
    expect(
      useProfileCopyOperationsStore
        .getState()
        .handles.some((entry) => entry.operationId === OPERATION_ID),
    ).toBe(false);
  });
});
