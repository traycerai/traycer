import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import type {
  HostEnsureJoinResult,
  HostOperationKind,
  HostOperationStatusEnvelope,
  HostProgressEvent,
  IHostManagement,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { LocalHostGate } from "@/components/local-host-gate";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  HostCompatibilityProvider,
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { runnerQueryKeys } from "@/lib/query-keys";

// Ticket T3 (E+G) - "Gate consumes the canonical envelope" - gui-app,
// `local-host-gate.tsx`. The gate now consumes
// `useRunnerHostOperationStatusQuery(runnerHost.hostManagement)`, keyed by
// `runnerQueryKeys.hostOperationStatus(management)`. Every test here pushes a
// `HostOperationStatusEnvelope` directly into that same TanStack Query cache
// entry `HostOperationStatusListener` writes to in production, exactly the
// pattern used by `host-update-cross-surface.test.tsx`, and asserts the
// gate-hold-table contract from the governing tech plan.
//
// Notes on scenarios where the plan leaves a detail to the code:
//   - Canonical progress is asserted via whatever object the gate passes as
//     `provisioningLoading`'s `progress` prop; the probe below only checks
//     `stage`/`percent`/`bytes`/`totalBytes` values, not `operationId`
//     equality, since G's contract is "id-independent" rendering.
//   - Busy-keep replay validity is host-pid-relative, not just
//     `busyHostPid`-vs-itself: it compares against the CURRENT local-host
//     snapshot's pid. When the snapshot is genuinely still reachable
//     (`isReady`), the gate never auto-fires ensure regardless of replay
//     validity - only the null-row ("host unreachable, no valid outcome")
//     path does. A pid-mismatched busy replay on a reachable host therefore
//     falls through to the ordinary ready/compat flow, not a fresh ensure.
//   - `removed` replay is seed-only: the on-disk removal-state query is the
//     durable truth, so a removed-outcome test's `getRemovalState` mock must
//     agree with the seeded outcome for the removed surface to hold past the
//     query's own resolution.

const validSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-1",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
};

const localEntry: HostDirectoryEntry = {
  hostId: validSnapshot.hostId,
  label: validSnapshot.displayName,
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  status: "available",
};

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;
type HostStatusHandler = () => Promise<HostStatusResponse> | HostStatusResponse;

interface EnsureHostInput {
  readonly onProgress: ((event: HostProgressEvent) => void) | null;
  readonly force: boolean;
  readonly observedOperationId: string | null;
}

const compatibleHostStatus: HostStatusResponse = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
};

const incompatibleHostStatus: HostStatusHandler = () => {
  throw new HostRpcError({
    code: "INCOMPATIBLE",
    message: "Incompatible methods: epic.listTasks",
    requestId: "req-status",
    method: "host.status",
    fatalDetails: null,
  });
};

function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

interface ManagementOverrides {
  readonly ensureHost: IHostManagement["ensureHost"];
  readonly getOperationStatus: () => Promise<HostOperationStatusEnvelope>;
  readonly getRemovalState?: () => Promise<{ removedByUser: boolean }>;
}

function makeManagement(overrides: ManagementOverrides): IHostManagement {
  const notImplemented =
    (name: string) =>
    (): Promise<never> =>
      Promise.reject(new Error(`${name} not implemented in this test`));
  return {
    installHost: notImplemented("installHost"),
    updateHost: notImplemented("updateHost"),
    uninstallHost: notImplemented("uninstallHost"),
    restartHost: notImplemented("restartHost"),
    uninstallTraycer: notImplemented("uninstallTraycer"),
    getRemovalState:
      overrides.getRemovalState ?? (() => Promise.resolve({ removedByUser: false })),
    clearRemoval: () => Promise.resolve(),
    getHostLogs: notImplemented("getHostLogs"),
    runDoctor: notImplemented("runDoctor"),
    availableVersions: notImplemented("availableVersions"),
    installedRecord: () => Promise.resolve(null),
    registerService: notImplemented("registerService"),
    ensureHost: overrides.ensureHost,
    deregisterService: notImplemented("deregisterService"),
    registryCheck: notImplemented("registryCheck"),
    getOperationStatus: overrides.getOperationStatus,
    freePortAndRestart: (input) => Promise.resolve(input),
    cliManifest: () => Promise.resolve(null),
    getHostName: () =>
      Promise.resolve({
        systemName: validSnapshot.systemHostName,
        customName: null,
        effectiveName: validSnapshot.displayName,
      }),
    setHostName: (input) =>
      Promise.resolve({
        systemName: validSnapshot.systemHostName,
        customName: input.customName,
        effectiveName: input.customName ?? validSnapshot.systemHostName,
      }),
  };
}

function makeHost(
  localHost: LocalHostSnapshot | null,
  management: IHostManagement,
): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement: management,
  });
}

function seedStoredToken(host: MockRunnerHost): void {
  void host.tokenStore.set({
    token: "test-token",
    refreshToken: "test-refresh-token",
  });
}

function buildMessengerFactory(
  hostStatus: HostStatusHandler,
): MessengerFactory<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
      handlers: {
        "host.status": () => hostStatus(),
        "epic.listTasks": () => ({ tasks: [], hasMore: false }),
      },
    });
}

interface ProvisioningLoadingProbeProps {
  readonly progress: HostProgressEvent | null;
  readonly operationKind: HostOperationKind | null;
}

function ProvisioningLoadingProbe(
  props: ProvisioningLoadingProbeProps,
): ReactNode {
  return (
    <div data-testid="gate-provisioning-loading">
      {props.progress !== null ? (
        <div data-testid="gate-provisioning-progress">
          <span data-testid="gate-provisioning-operation-kind">
            {props.operationKind}
          </span>
          <span data-testid="gate-provisioning-progress-stage">
            {props.progress.stage}
          </span>
          <span data-testid="gate-provisioning-progress-percent">
            {props.progress.percent}
          </span>
          <span data-testid="gate-provisioning-progress-bytes">
            {props.progress.bytes}
          </span>
          <span data-testid="gate-provisioning-progress-total-bytes">
            {props.progress.totalBytes}
          </span>
        </div>
      ) : null}
    </div>
  );
}

let restoreFetch: () => void = () => undefined;

function installAuthFetch(): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/v3/user")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user: {
                id: "user-1",
                name: "Test User",
                providerId: "gh-1",
                providerHandle: "test-user",
                providerType: "GITHUB",
                email: "test@example.com",
                avatarUrl: null,
                activatedAt: null,
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                lastSeenAt: null,
                privacyMode: false,
                isLearningEnabled: true,
              },
              userSubscription: {
                id: "sub-1",
                userID: "user-1",
                orgID: null,
                teamID: null,
                customerId: "cus-1",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                subscriptionExpiry: null,
                trialEndsAt: null,
                subscriptionStatus: "FREE",
                hasPaymentMethod: false,
                isInTrial: false,
                rechargeRateSeconds: 0,
              },
              teamSubscriptions: [],
              payAsYouGoUsage: { allowPayAsYouGo: false },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(
        new Error(`unexpected fetch in local-host-gate-envelope-gate test: ${url}`),
      );
    },
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function signIn(): void {
  useAuthStore.getState().setSignedIn(
    {
      userId: "test-user",
      userName: "Test User",
      email: "test@example.com",
    },
    { userId: "test-user", username: "Test User" },
    [],
  );
}

function renderGate(
  host: MockRunnerHost,
  hostStatus: HostStatusHandler,
): { readonly queryClient: QueryClient } {
  seedStoredToken(host);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={buildMessengerFactory(hostStatus)}
            invalidator={null}
            requestId={null}
            remoteFetcher={() => Promise.resolve([])}
            fallback={<div data-testid="runtime-fallback">runtime loading</div>}
          >
            <HostCompatibilityProvider>
              <LocalHostGate
                bypass={false}
                selectedEntry={localEntry}
                loading={<div data-testid="gate-loading">loading</div>}
                provisioningLoading={
                  <ProvisioningLoadingProbe progress={null} operationKind={null} />
                }
                unavailable={
                  <div data-testid="gate-unavailable">unavailable</div>
                }
              >
                <div data-testid="gate-children">children</div>
              </LocalHostGate>
            </HostCompatibilityProvider>
          </HostRuntimeProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
  return { queryClient };
}

function pushEnvelope(
  queryClient: QueryClient,
  management: IHostManagement,
  envelope: HostOperationStatusEnvelope,
): void {
  act(() => {
    queryClient.setQueryData<HostOperationStatusEnvelope>(
      runnerQueryKeys.hostOperationStatus(management),
      envelope,
    );
  });
}

async function settleMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("LocalHostGate - E+G canonical envelope gate hold table", () => {
  beforeEach(() => {
    vi.useRealTimers();
    restoreFetch = installAuthFetch();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    vi.restoreAllMocks();
    restoreFetch();
  });

  it("holds and fires nothing while the envelope is undefined (cold/pre-hydration window)", async () => {
    signIn();
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> =>
        Promise.resolve({
          action: "already-ready",
          running: true,
          version: "1.2.3",
        }),
    );
    const management = makeManagement({
      ensureHost,
      // Never resolves: the query stays `undefined` (unknown), not `null`.
      getOperationStatus: () => neverResolves<HostOperationStatusEnvelope>(),
    });
    renderGate(makeHost(null, management), () => compatibleHostStatus);

    await waitFor(() => {
      expect(screen.queryByTestId("gate-loading")).not.toBeNull();
    });
    // Give any effect-driven fire a chance to run before asserting silence.
    await settleMicrotasks();
    await settleMicrotasks();

    expect(ensureHost).not.toHaveBeenCalled();
  });

  it("fires ensure exactly once on a non-ensure settle edge (active kind -> null), still unreachable", async () => {
    signIn();
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> => neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          revision: 1,
          status: {
            operationId: "op-restart",
            kind: "restart",
            stage: null,
            percent: null,
            bytes: null,
            totalBytes: null,
            message: null,
            startedAt: "2026-07-21T00:00:00Z",
          },
          lastEnsureOutcome: null,
        }),
    });
    const { queryClient } = renderGate(
      makeHost(null, management),
      () => compatibleHostStatus,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("gate-loading")).not.toBeNull();
    });
    expect(ensureHost).not.toHaveBeenCalled();

    // Settle: the restart operation finished, host still unreachable.
    pushEnvelope(queryClient, management, {
      revision: 2,
      status: null,
      lastEnsureOutcome: null,
    });

    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledTimes(1);
    });

    // No further re-render should double-fire for the same settle edge.
    await settleMicrotasks();
    expect(ensureHost).toHaveBeenCalledTimes(1);
  });

  it("does not auto-refire after an ensure settle edge, even with a persistent failure outcome", async () => {
    signIn();
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> => neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          revision: 1,
          status: {
            operationId: "op-ensure-1",
            kind: "ensure",
            stage: "applying",
            percent: null,
            bytes: null,
            totalBytes: null,
            message: null,
            startedAt: "2026-07-21T00:00:00Z",
          },
          lastEnsureOutcome: null,
        }),
    });
    const { queryClient } = renderGate(
      makeHost(null, management),
      () => compatibleHostStatus,
    );

    // kind "ensure" -> join-only invoke carrying the observed operationId.
    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledTimes(1);
    });
    expect(ensureHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ observedOperationId: "op-ensure-1" }),
    );

    const callsAfterJoin = ensureHost.mock.calls.length;

    // Ensure settle edge with a persistent-failure outcome: the latch is
    // consumed, the error is surfaced, and the gate must NOT auto-refire.
    pushEnvelope(queryClient, management, {
      revision: 2,
      status: null,
      lastEnsureOutcome: {
        operationId: "op-ensure-1",
        revision: 2,
        error: { message: "persistent ensure failure", code: "E_FOO" },
      },
    });

    await settleMicrotasks();
    await settleMicrotasks();

    expect(ensureHost).toHaveBeenCalledTimes(callsAfterJoin);
    expect(
      await screen.findByTestId("local-host-provisioning-error"),
    ).not.toBeNull();
    expect(screen.getByText("persistent ensure failure")).not.toBeNull();
    expect(
      screen.getByTestId("local-host-provisioning-retry"),
    ).not.toBeNull();
  });

  it("does not resurrect a removed outcome replayed at a stale (non-matching) revision", async () => {
    signIn();
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> => neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          // Envelope has moved to revision 6, but the retained outcome is
          // still stamped revision 5 (a later, unrelated bump happened
          // without clearing/refreshing the outcome) - the replay is
          // invalid, so `removed` must not resurrect mid-reinstall.
          revision: 6,
          status: null,
          lastEnsureOutcome: {
            operationId: "op-removed",
            revision: 5,
            result: { action: "removed", running: false, version: null },
            busyHostPid: null,
          },
        }),
    });
    renderGate(makeHost(null, management), () => compatibleHostStatus);

    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("local-host-removed")).toBeNull();
  });

  it("suppresses the null-row auto-fire when a valid removed outcome replays at the matching revision", async () => {
    signIn();
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> => neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          revision: 3,
          status: null,
          lastEnsureOutcome: {
            operationId: "op-removed",
            revision: 3,
            result: { action: "removed", running: false, version: null },
            busyHostPid: null,
          },
        }),
      // The seed (envelope outcome) and the durable on-disk sentinel must
      // agree in a real removed-by-user world - the removal-state query is
      // the query that ultimately re-asserts the removed surface once the
      // seed's `replayedRemoved && unknown` grace period resolves.
      getRemovalState: () => Promise.resolve({ removedByUser: true }),
    });
    renderGate(makeHost(null, management), () => compatibleHostStatus);

    await waitFor(() => {
      expect(screen.queryByTestId("local-host-removed")).not.toBeNull();
    });
    await settleMicrotasks();
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it("falls through to one ensure when a removed replay's sentinel resolves false", async () => {
    signIn();
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> => neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          revision: 4,
          status: null,
          lastEnsureOutcome: {
            operationId: "op-removed",
            revision: 4,
            result: { action: "removed", running: false, version: null },
            busyHostPid: null,
          },
        }),
      // A replayed `removed` result is seed-only. The durable sentinel is the
      // final authority, so a false read re-enters the bare-null ensure row.
      getRemovalState: () => Promise.resolve({ removedByUser: false }),
    });
    renderGate(makeHost(null, management), () => compatibleHostStatus);

    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("local-host-removed")).toBeNull();
  });

  it("re-arms exactly one recovery ensure when a retained busy pid dies without an envelope transition", async () => {
    signIn();
    const ensureHost = vi.fn(
      (input: EnsureHostInput) =>
        input.observedOperationId === "op-ensure-busy"
          ? Promise.resolve<HostEnsureJoinResult>({
              action: "host-busy",
              running: true,
              version: "1.2.3",
            })
          : neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          revision: 1,
          status: {
            operationId: "op-ensure-busy",
            kind: "ensure",
            stage: "waiting-ready",
            percent: null,
            bytes: null,
            totalBytes: null,
            message: null,
            startedAt: "2026-07-21T00:00:00Z",
          },
          lastEnsureOutcome: null,
        }),
    });
    const host = makeHost(validSnapshot, management);
    const { queryClient } = renderGate(host, incompatibleHostStatus);

    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledWith(
        expect.objectContaining({ observedOperationId: "op-ensure-busy" }),
      );
    });

    pushEnvelope(queryClient, management, {
      revision: 2,
      status: null,
      lastEnsureOutcome: {
        operationId: "op-ensure-busy",
        revision: 2,
        result: { action: "host-busy", running: true, version: "1.2.3" },
        busyHostPid: validSnapshot.pid,
      },
    });

    expect(
      await screen.findByTestId("local-host-incompatible-busy"),
    ).not.toBeNull();
    expect(ensureHost).toHaveBeenCalledTimes(1);

    // No operation transition arrives when a previously busy host simply dies.
    // The lost snapshot alone must re-arm one recovery ensure.
    act(() => {
      host.setLocalHost(null);
    });

    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledTimes(2);
    });
    expect(ensureHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ observedOperationId: null }),
    );
    await settleMicrotasks();
    expect(ensureHost).toHaveBeenCalledTimes(2);
  });

  it("suppresses the null-row auto-fire and enters busy-keep when the busy replay's pid still matches", async () => {
    signIn();
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> => neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          revision: 4,
          status: null,
          lastEnsureOutcome: {
            operationId: "op-busy",
            revision: 4,
            result: { action: "host-busy", running: true, version: "1.2.3" },
            busyHostPid: validSnapshot.pid,
          },
        }),
    });
    renderGate(
      makeHost(validSnapshot, management),
      incompatibleHostStatus,
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("local-host-incompatible-busy"),
      ).not.toBeNull();
    });
    await settleMicrotasks();
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it("fires recovery ensure when a busy replay has no current host pid", async () => {
    signIn();
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> => neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          revision: 5,
          status: null,
          lastEnsureOutcome: {
            operationId: "op-busy-lost-pid",
            revision: 5,
            result: { action: "host-busy", running: true, version: "1.2.3" },
            busyHostPid: validSnapshot.pid,
          },
        }),
    });
    renderGate(makeHost(null, management), () => compatibleHostStatus);

    await waitFor(() => {
      expect(ensureHost).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("local-host-incompatible-busy")).toBeNull();
  });

  it("renders canonical progress from the envelope after a simulated reload, id-independent of the local mutation", async () => {
    signIn();
    // The gate never called `ensureHost` from THIS window - it joins an
    // ensure that was already running before the (simulated) reload, so
    // there is no locally-tracked mutation `onProgress` to source progress
    // from. The rendered progress must come from the envelope alone.
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> => neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          revision: 7,
          status: {
            operationId: "op-ensure-reload",
            kind: "ensure",
            stage: "downloading",
            percent: 42,
            bytes: 420,
            totalBytes: 1000,
            message: null,
            startedAt: "2026-07-21T00:00:00Z",
          },
          lastEnsureOutcome: null,
        }),
    });
    renderGate(makeHost(null, management), () => compatibleHostStatus);

    await waitFor(() => {
      const node = screen.queryByTestId("gate-provisioning-progress");
      expect(node).not.toBeNull();
    });
    expect(
      screen.getByTestId("gate-provisioning-progress-stage").textContent,
    ).toBe("downloading");
    expect(
      screen.getByTestId("gate-provisioning-progress-percent").textContent,
    ).toBe("42");
    expect(
      screen.getByTestId("gate-provisioning-progress-bytes").textContent,
    ).toBe("420");
    expect(
      screen.getByTestId("gate-provisioning-progress-total-bytes").textContent,
    ).toBe("1000");
    expect(
      screen.getByTestId("gate-provisioning-operation-kind").textContent,
    ).toBe("ensure");
    expect(ensureHost).toHaveBeenCalledWith(
      expect.objectContaining({ observedOperationId: "op-ensure-reload" }),
    );
  });

  it("holds an active status instead of replaying its stale terminal outcome", async () => {
    signIn();
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> => neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          revision: 8,
          status: {
            operationId: "op-update",
            kind: "update",
            stage: "download",
            percent: 10,
            bytes: 10,
            totalBytes: 100,
            message: "updating host",
            startedAt: "2026-07-21T00:00:00Z",
          },
          lastEnsureOutcome: {
            operationId: "op-old-removed",
            revision: 8,
            result: { action: "removed", running: false, version: null },
            busyHostPid: null,
          },
        }),
    });
    renderGate(makeHost(null, management), () => compatibleHostStatus);

    expect(
      await screen.findByTestId("gate-provisioning-progress"),
    ).not.toBeNull();
    expect(
      screen.getByTestId("gate-provisioning-operation-kind").textContent,
    ).toBe("update");
    expect(screen.queryByTestId("local-host-removed")).toBeNull();
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it("keeps a ready host on its normal page while a non-ensure operation is active", async () => {
    signIn();
    const ensureHost = vi.fn(
      (): Promise<HostEnsureJoinResult> => neverResolves<HostEnsureJoinResult>(),
    );
    const management = makeManagement({
      ensureHost,
      getOperationStatus: () =>
        Promise.resolve({
          revision: 9,
          status: {
            operationId: "op-update-ready-host",
            kind: "update",
            stage: "download",
            percent: 50,
            bytes: 50,
            totalBytes: 100,
            message: "updating host",
            startedAt: "2026-07-21T00:00:00Z",
          },
          lastEnsureOutcome: null,
        }),
    });
    renderGate(makeHost(validSnapshot, management), () => compatibleHostStatus);

    expect(await screen.findByTestId("gate-children")).not.toBeNull();
    expect(screen.queryByTestId("gate-provisioning-loading")).toBeNull();
    expect(ensureHost).not.toHaveBeenCalled();
  });
});
