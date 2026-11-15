import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { useEffect } from "react";
import type { ReactNode } from "react";
import type {
  ClaimedComputer,
  ClaimedComputersResult,
} from "@traycer-clients/shared/auth/claimed-computers";
import type { HostDoorState } from "@traycer-clients/shared/host-transport/host-door-state";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import { TileDoorCoverLayer } from "@/components/hosts/tile-door-cover";
import { HostReadinessControllerContext } from "@/components/layout/host-readiness-controller-context";
import type {
  DefaultHostReadinessPresentation,
  HostReadinessController,
} from "@/components/layout/host-readiness-controller-context";
import { useTileDoorCover } from "@/hooks/host/use-tile-door-cover";
import { AuthService } from "@/lib/auth/auth-service";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";
import { authQueryKeys } from "@/lib/query-keys";
import { setMobileApp } from "@/lib/mobile-app";
import { HostRuntimeTestProvider } from "@/lib/host/__tests__/host-runtime-test-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  clearHostDoorState,
  noteHostDoorState,
  useHostDoorStateStore,
} from "@/stores/host/host-door-state-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import {
  CLAIMED_COMPUTERS_RESULTS,
  deferredClaimRead,
  environmentList,
  organizationEnvironment,
} from "./claimed-computers-fixtures";
import type { DeferredClaimRead } from "./claimed-computers-fixtures";

const WINDOW_HOST_ID = "window-host";
const TILE_HOST_ID = "tile-host";
const ENVIRONMENT_ID = "team-acme";
const ENVIRONMENT_LABEL = "Acme";
const USER_ID = "test-user";

type ClaimPlan = ClaimedComputersResult | DeferredClaimRead | Error;

const claimPlans = new Map<string, ClaimPlan[]>();
const claimCalls: string[] = [];
const queryClients = new Set<QueryClient>();
const externalSubscriptions = new Set<() => void>();

const EMPTY_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  ensureFailure: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

const READY_CONTROLLER: HostReadinessController = {
  readinessFor: () => ({ kind: "ready" }),
  defaultHostPresentation: EMPTY_PRESENTATION,
  hasBeenDefaultHostReady: true,
};

interface AuthReference {
  current: AuthService | null;
}

function isDeferredClaimRead(plan: ClaimPlan): plan is DeferredClaimRead {
  return "promise" in plan;
}

function claim(
  hostId: string,
  claimantName: string,
  claimedAt: string,
): ClaimedComputer {
  return {
    hostId,
    computerName: null,
    claimantName,
    claimedAt,
  };
}

function claims(...items: ClaimedComputer[]): ClaimedComputersResult {
  return { kind: "ok", claims: items };
}

function queueClaimPlan(environmentId: string, plan: ClaimPlan): void {
  const queued = claimPlans.get(environmentId) ?? [];
  queued.push(plan);
  claimPlans.set(environmentId, queued);
}

function claimCallCount(environmentId: string): number {
  return claimCalls.filter(
    (calledEnvironmentId) => calledEnvironmentId === environmentId,
  ).length;
}

function claimedQuery(
  harness: ClaimHarness,
  environmentId: string,
): {
  readonly auth: AuthService;
  readonly queryKey: readonly unknown[];
} {
  const auth = harness.authReference.current;
  if (auth === null) throw new Error("The AuthService was not mounted");
  return {
    auth,
    queryKey: authQueryKeys.claimedComputers(auth, USER_ID, environmentId),
  };
}

function seedClaimedQuery(
  harness: ClaimHarness,
  environmentId: string,
  result: ClaimedComputersResult,
): void {
  const { queryKey } = claimedQuery(harness, environmentId);
  harness.queryClient.setQueryData(queryKey, result);
}

function resetStores(): void {
  useHostDoorStateStore.setState({ byHost: new Map() });
  useSelectionAuthorityStore.getState().reset();
}

function hostClaimedState(hostId: string): HostDoorState {
  return { hostId, kind: "host-claimed", detail: null };
}

function setHostClaimedState(hostId: string): HostDoorState {
  const state = hostClaimedState(hostId);
  act(() => noteHostDoorState(state));
  return state;
}

function replaceDoorState(state: HostDoorState): void {
  act(() => {
    useHostDoorStateStore.setState((previous) => {
      const byHost = new Map(previous.byHost);
      byHost.set(state.hostId, state);
      return { byHost };
    });
  });
}

function attachWindow(hostId: string): void {
  const snapshot: SelectionKernelSnapshot = {
    attached: true,
    preferredHostId: null,
    targetHostId: hostId,
    effectiveHostId: hostId,
    leases: [],
    selectionRevision: 1,
  };
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
  });
}

function EnvironmentClientBinding({
  client,
  authReferenceRef,
  children,
}: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly authReferenceRef: AuthReference;
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  if (binding === null) throw new Error("Host runtime binding was not mounted");
  useEffect(() => {
    authReferenceRef.current = binding.auth;
  }, [authReferenceRef, binding.auth]);
  return (
    <HostRuntimeContext.Provider
      value={{
        ...binding,
        hostClient: client,
        hostId: mockLocalHostEntry.hostId,
      }}
    >
      {children}
    </HostRuntimeContext.Provider>
  );
}

function TileClaimConsumer(props: { readonly hostId: string }): ReactNode {
  const cover = useTileDoorCover(props.hostId);
  return (
    <div data-testid={`tile-surface-${props.hostId}`}>
      {cover === null ? null : (
        <TileDoorCoverLayer hostId={props.hostId} cover={cover} />
      )}
    </div>
  );
}

function NestedRuntimeTileConsumer(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly authReferenceRef: AuthReference;
  readonly hostId: string;
}): ReactNode {
  return (
    <HostRuntimeTestProvider>
      <EnvironmentClientBinding
        client={props.client}
        authReferenceRef={props.authReferenceRef}
      >
        <TileClaimConsumer hostId={props.hostId} />
      </EnvironmentClientBinding>
    </HostRuntimeTestProvider>
  );
}

function ClaimConsumers(props: {
  readonly showWindow: boolean;
  readonly tileHostIds: readonly string[];
}): ReactNode {
  return (
    <>
      {props.showWindow ? <WindowHostModalHost bypassed={false} /> : null}
      {props.tileHostIds.map((hostId) => (
        <TileClaimConsumer key={hostId} hostId={hostId} />
      ))}
    </>
  );
}

interface ClaimHarness {
  readonly queryClient: QueryClient;
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly authReference: AuthReference;
  readonly environmentRequestCount: () => number;
  readonly setEnvironmentList: (response: EnvironmentListResponseV11) => void;
  readonly setEnvironmentFailure: (fails: boolean) => void;
  readonly refetchEnvironmentList: () => Promise<void>;
  readonly renderTree: (children: ReactNode) => void;
  readonly show: (showWindow: boolean, tileHostIds: readonly string[]) => void;
  readonly unmountConsumers: () => void;
}

function isEnvironmentList(data: unknown): data is EnvironmentListResponseV11 {
  return (
    typeof data === "object" &&
    data !== null &&
    "environments" in data &&
    Array.isArray(data.environments)
  );
}

function createClaimHarness(
  environments: readonly EnvironmentListResponseV11["environments"][number][],
): ClaimHarness {
  let nextRequestId = 0;
  let environmentRequests = 0;
  let currentEnvironmentList = environmentList(environments);
  let environmentFails = false;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClients.add(queryClient);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `claimed-computers-${++nextRequestId}`,
      handlers: {
        "environment.list": () => {
          environmentRequests += 1;
          if (environmentFails) throw new Error("environment.list failed");
          return currentEnvironmentList;
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "claimed-computers-test-token",
    }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const authReference: AuthReference = { current: null };
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <HostRuntimeTestProvider>
        <EnvironmentClientBinding
          client={client}
          authReferenceRef={authReference}
        >
          <HostReadinessControllerContext.Provider value={READY_CONTROLLER}>
            {props.children}
          </HostReadinessControllerContext.Provider>
        </EnvironmentClientBinding>
      </HostRuntimeTestProvider>
    </QueryClientProvider>
  );
  const rendered = render(<Wrapper>{null}</Wrapper>);
  const renderTree = (children: ReactNode): void => {
    act(() => {
      rendered.rerender(<Wrapper>{children}</Wrapper>);
    });
  };
  return {
    queryClient,
    hostClient: client,
    authReference,
    environmentRequestCount: () => environmentRequests,
    setEnvironmentList: (response) => {
      currentEnvironmentList = response;
    },
    setEnvironmentFailure: (fails) => {
      environmentFails = fails;
    },
    refetchEnvironmentList: async () => {
      const environmentQuery = queryClient
        .getQueryCache()
        .findAll()
        .find((query) => isEnvironmentList(query.state.data));
      if (environmentQuery === undefined)
        throw new Error("The environment.list query has not answered");
      await queryClient.invalidateQueries({
        queryKey: environmentQuery.queryKey,
        exact: true,
      });
    },
    renderTree,
    show: (showWindow, tileHostIds) => {
      renderTree(
        <ClaimConsumers showWindow={showWindow} tileHostIds={tileHostIds} />,
      );
    },
    unmountConsumers: () => {
      renderTree(null);
    },
  };
}

function windowButtons(): readonly (string | null)[] {
  return within(screen.getByTestId("window-host-modal"))
    .getAllByRole("button")
    .map((button) => button.textContent);
}

function assertWindowClaim(claimant: string, team: string): void {
  const window = within(screen.getByTestId("window-host-modal"));
  expect(window.getByText(`${claimant} claimed this computer`)).toBeTruthy();
  expect(window.getByText(`It no longer belongs to ${team}.`)).toBeTruthy();
  expect(windowButtons()).toEqual(["Open settings"]);
}

function assertTileClaim(hostId: string, claimant: string, team: string): void {
  const surface = screen.getByTestId(`tile-surface-${hostId}`);
  const cover = within(surface).getByTestId("tile-door-cover");
  expect(cover.getAttribute("data-kind")).toBe("host-claimed");
  expect(
    within(cover).getByText(`${claimant} claimed this computer`),
  ).toBeTruthy();
  expect(
    within(cover).getByText(`It no longer belongs to ${team}.`),
  ).toBeTruthy();
  expect(within(cover).queryByRole("button")).toBeNull();
}

beforeEach(() => {
  claimPlans.clear();
  claimCalls.length = 0;
  resetStores();
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: USER_ID, userName: "Test User", email: "test@example.com" },
      { userId: USER_ID, username: "Test User" },
      [],
    );
  setMobileApp(false);
  vi.spyOn(AuthService.prototype, "listClaimedComputers").mockImplementation(
    (environmentId, signal) => {
      claimCalls.push(environmentId);
      const queued = claimPlans.get(environmentId);
      const plan = queued?.shift();
      if (plan === undefined)
        throw new Error(
          `No claimed-computer response queued for ${environmentId}`,
        );
      if (plan instanceof Error) return Promise.reject(plan);
      if (isDeferredClaimRead(plan))
        return signal === null ? plan.promise : plan.attachSignal(signal);
      return Promise.resolve(plan);
    },
  );
});

afterEach(() => {
  cleanup();
  for (const unsubscribe of externalSubscriptions) unsubscribe();
  externalSubscriptions.clear();
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.clear();
  claimPlans.clear();
  claimCalls.length = 0;
  resetStores();
  useAuthStore.getState().setSignedOut();
  setMobileApp(false);
  vi.restoreAllMocks();
});

describe("claimed-computer narration consumers", () => {
  it("shows the claim and team in the window cover", async () => {
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await screen.findByText("Priya claimed this computer");
    assertWindowClaim("Priya", ENVIRONMENT_LABEL);
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(1);
  });

  it("shows the claim and team on a tile without an action", async () => {
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(TILE_HOST_ID, "Priya", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(TILE_HOST_ID);
    harness.show(false, [TILE_HOST_ID]);

    await screen.findByText("Priya claimed this computer");
    assertTileClaim(TILE_HOST_ID, "Priya", ENVIRONMENT_LABEL);
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(1);
  });

  it("shares one read with the same-host tile hook while the window draws the cover once", async () => {
    const pending = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, pending);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, [WINDOW_HOST_ID]);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));

    harness.show(true, [WINDOW_HOST_ID]);
    harness.show(true, [WINDOW_HOST_ID]);
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(1);

    act(() => {
      pending.resolve(
        claims(claim(WINDOW_HOST_ID, "Priya", "2026-11-10T00:00:00.000Z")),
      );
    });
    await screen.findByText("Priya claimed this computer");
    assertWindowClaim("Priya", ENVIRONMENT_LABEL);
    expect(
      within(
        screen.getByTestId(`tile-surface-${WINDOW_HOST_ID}`),
      ).queryByTestId("tile-door-cover"),
    ).toBeNull();
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(1);
  });

  it("keeps today's window cover and no tile cover until the pending read answers", async () => {
    const answer = deferredClaimRead();
    const bothClaims = (): ClaimedComputersResult =>
      claims(
        claim(WINDOW_HOST_ID, "Priya", "2026-11-10T00:00:00.000Z"),
        claim(TILE_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z"),
      );
    queueClaimPlan(ENVIRONMENT_ID, answer);
    // Two states are on one team's entry. The tile's state asked while the
    // window's read was in flight, so it waits for that read and then reads
    // again (a read begun before its claim may predate it).
    queueClaimPlan(ENVIRONMENT_ID, bothClaims());
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    setHostClaimedState(TILE_HOST_ID);
    harness.show(true, [TILE_HOST_ID]);

    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(
      within(screen.getByTestId(`tile-surface-${TILE_HOST_ID}`)).queryByTestId(
        "tile-door-cover",
      ),
    ).toBeNull();

    act(() => {
      answer.resolve(bothClaims());
    });
    await screen.findByText("Priya claimed this computer");
    await screen.findByText("Rao claimed this computer");
    assertWindowClaim("Priya", ENVIRONMENT_LABEL);
    assertTileClaim(TILE_HOST_ID, "Rao", ENVIRONMENT_LABEL);
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(2);
  });

  it("keeps today's cover when the team says the claims were not found", async () => {
    queueClaimPlan(ENVIRONMENT_ID, CLAIMED_COMPUTERS_RESULTS.notFound);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await waitFor(() => expect(harness.environmentRequestCount()).toBe(1));
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    expect(await screen.findByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();
  });

  it("keeps today's cover when the team does not authorize a claims read", async () => {
    queueClaimPlan(ENVIRONMENT_ID, CLAIMED_COMPUTERS_RESULTS.unauthorized);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    expect(await screen.findByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();
  });

  it("keeps today's cover when a claims read fails", async () => {
    queueClaimPlan(ENVIRONMENT_ID, CLAIMED_COMPUTERS_RESULTS.failed);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();
  });

  it("aborts a pending claims read when the stored door state is replaced", async () => {
    const pending = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, pending);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));

    replaceDoorState({
      hostId: WINDOW_HOST_ID,
      kind: "token-unavailable",
      detail: null,
    });
    await waitFor(() => expect(pending.signalAborted).toBe(true));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(1);
  });

  it("aborts a pending claims read when the stored door state is cleared", async () => {
    const pending = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, pending);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));

    act(() => clearHostDoorState(WINDOW_HOST_ID));
    await waitFor(() => expect(pending.signalAborted).toBe(true));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(1);
  });

  it("keeps the resolved claims entry and cover when the same state remounts", async () => {
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await screen.findByText("Priya claimed this computer");

    harness.unmountConsumers();
    harness.show(true, []);

    expect(screen.getByText("Priya claimed this computer")).toBeTruthy();
    expect(screen.queryByText("No host is available")).toBeNull();
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(1);
  });

  it("restarts each unanswered team read when the same state remounts", async () => {
    const first = deferredClaimRead();
    const second = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, first);
    queueClaimPlan(ENVIRONMENT_ID, second);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));

    harness.unmountConsumers();
    await waitFor(() => expect(first.signalAborted).toBe(true));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(2));
    expect(screen.getByText("No host is available")).toBeTruthy();

    act(() => {
      second.resolve(
        claims(claim(WINDOW_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z")),
      );
    });
    await screen.findByText("Rao claimed this computer");
    assertWindowClaim("Rao", ENVIRONMENT_LABEL);
  });

  it("reads only the newly added team when environment.list adds a team", async () => {
    queueClaimPlan(
      "team-acme",
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z")),
    );
    queueClaimPlan(
      "team-beta",
      claims(claim(WINDOW_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment("team-acme", "Acme"),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await screen.findByText("Priya claimed this computer");

    harness.setEnvironmentList(
      environmentList([
        organizationEnvironment("team-beta", "Beta"),
        organizationEnvironment("team-acme", "Acme"),
      ]),
    );
    await act(async () => harness.refetchEnvironmentList());

    await screen.findByText("Rao claimed this computer");
    assertWindowClaim("Rao", "Beta");
    expect(claimCallCount("team-acme")).toBe(1);
    expect(claimCallCount("team-beta")).toBe(1);
  });

  it("reads a fresh claim for a new host-claimed state object", async () => {
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z")),
    );
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Sam", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await screen.findByText("Priya claimed this computer");

    replaceDoorState(hostClaimedState(WINDOW_HOST_ID));

    await screen.findByText("Sam claimed this computer");
    assertWindowClaim("Sam", ENVIRONMENT_LABEL);
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(2);
  });

  it("does not draw one account's claim after the same state moves to another account", async () => {
    const secondAccountRead = deferredClaimRead();
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-11-10T00:00:00.000Z")),
    );
    queueClaimPlan(ENVIRONMENT_ID, secondAccountRead);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    const state = setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await screen.findByText("Priya claimed this computer");

    act(() => {
      useAuthStore.getState().setSignedIn(
        {
          userId: "other-user",
          userName: "Other User",
          email: "other@example.com",
        },
        { userId: "other-user", username: "Other User" },
        [],
      );
    });
    replaceDoorState(state);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(2));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();

    act(() => {
      secondAccountRead.resolve(
        claims(claim(WINDOW_HOST_ID, "Rao", "2026-11-20T00:00:00.000Z")),
      );
    });
    await screen.findByText("Rao claimed this computer");
    assertWindowClaim("Rao", ENVIRONMENT_LABEL);
  });

  it("shares one claims entry between two AuthService instances of one account, each state reading after its own claim", async () => {
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(TILE_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z")),
    );
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(TILE_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    setHostClaimedState(TILE_HOST_ID);
    const secondAuthReference: AuthReference = { current: null };
    // Added nodes are inspected as they land: the final DOM cannot show a
    // name that was drawn and replaced.
    let priyaDrawn = false;
    const scan = (records: readonly MutationRecord[]): void => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.textContent?.includes("Priya claimed this computer"))
            priyaDrawn = true;
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      harness.renderTree(
        <>
          <TileClaimConsumer hostId={TILE_HOST_ID} />
          <NestedRuntimeTileConsumer
            client={harness.hostClient}
            authReferenceRef={secondAuthReference}
            hostId={TILE_HOST_ID}
          />
        </>,
      );

      await waitFor(() =>
        expect(screen.getAllByText("Rao claimed this computer")).toHaveLength(
          2,
        ),
      );
      await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
      scan(observer.takeRecords());
    } finally {
      observer.disconnect();
    }
    expect(harness.authReference.current).not.toBe(secondAuthReference.current);
    expect(priyaDrawn).toBe(false);
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(2);
  });

  it("does not retry a team read that throws during rerender, team change or remount", async () => {
    queueClaimPlan("team-acme", new Error("Acme claims unavailable"));
    const harness = createClaimHarness([
      organizationEnvironment("team-acme", "Acme"),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount("team-acme")).toBe(1));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));

    harness.show(true, []);
    harness.setEnvironmentList(
      environmentList([
        organizationEnvironment("team-beta", "Beta"),
        organizationEnvironment("team-acme", "Acme"),
      ]),
    );
    queueClaimPlan("team-beta", CLAIMED_COMPUTERS_RESULTS.notFound);
    await act(async () => harness.refetchEnvironmentList());
    await waitFor(() => expect(claimCallCount("team-beta")).toBe(1));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    harness.unmountConsumers();
    harness.show(true, []);
    expect(claimCallCount("team-acme")).toBe(1);
    expect(claimCallCount("team-beta")).toBe(1);

    queueClaimPlan(
      "team-acme",
      claims(claim(WINDOW_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z")),
    );
    queueClaimPlan("team-beta", CLAIMED_COMPUTERS_RESULTS.notFound);
    replaceDoorState(hostClaimedState(WINDOW_HOST_ID));
    await screen.findByText("Rao claimed this computer");
    expect(claimCallCount("team-acme")).toBe(2);
    expect(claimCallCount("team-beta")).toBe(2);
  });

  it("lets two claimed computers on one team finish their own reads", async () => {
    const first = deferredClaimRead();
    const second = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, first);
    queueClaimPlan(ENVIRONMENT_ID, second);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    setHostClaimedState("host-A");
    setHostClaimedState("host-B");
    harness.show(false, ["host-A"]);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    harness.show(false, ["host-A", "host-B"]);

    expect(first.signalAborted).toBe(false);
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(1);
    act(() => {
      first.resolve(
        claims(claim("host-A", "Priya", "2026-11-10T00:00:00.000Z")),
      );
    });
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(2));
    act(() => {
      second.resolve(
        claims(claim("host-B", "Rao", "2026-11-10T00:00:00.000Z")),
      );
    });

    await screen.findByText("Priya claimed this computer");
    expect(screen.getByText("Rao claimed this computer")).toBeTruthy();
    assertTileClaim("host-A", "Priya", ENVIRONMENT_LABEL);
    assertTileClaim("host-B", "Rao", ENVIRONMENT_LABEL);
  });

  it("keeps the other claimed state reading when the first state ends", async () => {
    const first = deferredClaimRead();
    const second = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, first);
    queueClaimPlan(ENVIRONMENT_ID, second);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    setHostClaimedState("host-A");
    setHostClaimedState("host-B");
    harness.show(false, ["host-A"]);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    harness.show(false, ["host-A", "host-B"]);

    act(() =>
      noteHostDoorState({
        hostId: "host-A",
        kind: "token-unavailable",
        detail: null,
      }),
    );
    await waitFor(() => expect(first.signalAborted).toBe(true));
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(2));
    act(() => {
      second.resolve(
        claims(claim("host-B", "Rao", "2026-11-10T00:00:00.000Z")),
      );
    });

    await screen.findByText("Rao claimed this computer");
    assertTileClaim("host-B", "Rao", ENVIRONMENT_LABEL);
  });

  it("does not cancel a team read shared by the remaining claimed state", async () => {
    const first = deferredClaimRead();
    const shared = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, first);
    queueClaimPlan(ENVIRONMENT_ID, shared);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    setHostClaimedState("host-A");
    setHostClaimedState("host-B");
    setHostClaimedState("host-C");
    harness.show(false, ["host-A"]);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    harness.show(false, ["host-A", "host-B", "host-C"]);
    act(() => {
      first.resolve(
        claims(claim("host-A", "Priya", "2026-11-10T00:00:00.000Z")),
      );
    });
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(2));

    act(() =>
      noteHostDoorState({
        hostId: "host-B",
        kind: "token-unavailable",
        detail: null,
      }),
    );
    expect(shared.signalAborted).toBe(false);
    act(() => {
      shared.resolve(
        claims(claim("host-C", "Sam", "2026-11-10T00:00:00.000Z")),
      );
    });

    await screen.findByText("Sam claimed this computer");
    assertTileClaim("host-C", "Sam", ENVIRONMENT_LABEL);
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(2);
  });

  it("joins an outside refetch to a pending team read when the entry has no data", async () => {
    const pending = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, pending);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    const { auth, queryKey } = claimedQuery(harness, ENVIRONMENT_ID);
    const observer = new QueryObserver(harness.queryClient, {
      queryKey,
      queryFn: ({ signal }) =>
        auth.listClaimedComputers(ENVIRONMENT_ID, signal),
      enabled: false,
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    externalSubscriptions.add(unsubscribe);
    let externalRefetchFinished = false;
    act(() => {
      void observer.refetch({ cancelRefetch: true }).then(() => {
        externalRefetchFinished = true;
      });
    });
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(1);

    act(() => {
      pending.resolve(
        claims(claim(WINDOW_HOST_ID, "Priya", "2026-11-10T00:00:00.000Z")),
      );
    });
    await waitFor(() => expect(externalRefetchFinished).toBe(true));
    await screen.findByText("Priya claimed this computer");
    assertWindowClaim("Priya", ENVIRONMENT_LABEL);
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(1);
  });

  it("follows an outside replacement refetch instead of drawing cached claims", async () => {
    const initialRead = deferredClaimRead();
    const replacementRead = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, initialRead);
    queueClaimPlan(ENVIRONMENT_ID, replacementRead);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    const oldResult = claims(
      claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z"),
    );
    seedClaimedQuery(harness, ENVIRONMENT_ID, oldResult);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    const { auth, queryKey } = claimedQuery(harness, ENVIRONMENT_ID);
    const observer = new QueryObserver(harness.queryClient, {
      queryKey,
      queryFn: ({ signal }) =>
        auth.listClaimedComputers(ENVIRONMENT_ID, signal),
      enabled: false,
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    externalSubscriptions.add(unsubscribe);
    let externalRefetchFinished = false;
    act(() => {
      void observer.refetch({ cancelRefetch: true }).then(() => {
        externalRefetchFinished = true;
      });
    });
    await waitFor(() => expect(initialRead.signalAborted).toBe(true));
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(2));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();

    act(() => {
      replacementRead.resolve(
        claims(claim(WINDOW_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z")),
      );
    });
    await waitFor(() => expect(externalRefetchFinished).toBe(true));
    await screen.findByText("Rao claimed this computer");
    assertWindowClaim("Rao", ENVIRONMENT_LABEL);
  });

  it("draws the newer claimant when the shared query entry is refetched", async () => {
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z")),
    );
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Sam", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await screen.findByText("Priya claimed this computer");
    const { auth, queryKey } = claimedQuery(harness, ENVIRONMENT_ID);
    let externalRefetchFinished = false;
    act(() => {
      void harness.queryClient
        .fetchQuery({
          queryKey,
          queryFn: ({ signal }) =>
            auth.listClaimedComputers(ENVIRONMENT_ID, signal),
          staleTime: 0,
        })
        .then(() => {
          externalRefetchFinished = true;
        });
    });

    await waitFor(() => expect(externalRefetchFinished).toBe(true));
    await screen.findByText("Sam claimed this computer");
    assertWindowClaim("Sam", ENVIRONMENT_LABEL);
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(2);
  });

  it("returns to today's cover when an outside refetch no longer names this host", async () => {
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z")),
    );
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim("another-host", "Sam", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await screen.findByText("Priya claimed this computer");
    const { auth, queryKey } = claimedQuery(harness, ENVIRONMENT_ID);
    let externalRefetchFinished = false;
    act(() => {
      void harness.queryClient
        .fetchQuery({
          queryKey,
          queryFn: ({ signal }) =>
            auth.listClaimedComputers(ENVIRONMENT_ID, signal),
          staleTime: 0,
        })
        .then(() => {
          externalRefetchFinished = true;
        });
    });

    await waitFor(() => expect(externalRefetchFinished).toBe(true));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(2);
  });

  it("does not draw a cached claim after unmount cancels the new state's read", async () => {
    const freshRead = deferredClaimRead();
    const remountedRead = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, freshRead);
    queueClaimPlan(ENVIRONMENT_ID, remountedRead);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    seedClaimedQuery(
      harness,
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z")),
    );
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();

    harness.unmountConsumers();
    await waitFor(() => expect(freshRead.signalAborted).toBe(true));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(2));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();

    act(() => {
      remountedRead.resolve(
        claims(claim(WINDOW_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z")),
      );
    });
    await screen.findByText("Rao claimed this computer");
    assertWindowClaim("Rao", ENVIRONMENT_LABEL);
  });

  it("does not count an outside-cancelled cached result before its replacement answers", async () => {
    const initialRead = deferredClaimRead();
    const replacementRead = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, initialRead);
    queueClaimPlan(ENVIRONMENT_ID, replacementRead);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    seedClaimedQuery(
      harness,
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z")),
    );
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    const { auth, queryKey } = claimedQuery(harness, ENVIRONMENT_ID);
    let replacement: Promise<unknown> = Promise.resolve();
    await act(async () => {
      await harness.queryClient.cancelQueries({ queryKey, exact: true });
      replacement = harness.queryClient.fetchQuery({
        queryKey,
        queryFn: ({ signal }) =>
          auth.listClaimedComputers(ENVIRONMENT_ID, signal),
        staleTime: 0,
      });
    });
    await waitFor(() => expect(initialRead.signalAborted).toBe(true));
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(2));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();

    act(() => {
      replacementRead.resolve(
        claims(claim(WINDOW_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z")),
      );
    });
    await replacement;
    await screen.findByText("Rao claimed this computer");
    assertWindowClaim("Rao", ENVIRONMENT_LABEL);
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(2);
  });

  it("keeps today's cover when an outside replacement for a cached claim answers failed", async () => {
    const initialRead = deferredClaimRead();
    queueClaimPlan(ENVIRONMENT_ID, initialRead);
    queueClaimPlan(ENVIRONMENT_ID, CLAIMED_COMPUTERS_RESULTS.failed);
    queueClaimPlan(ENVIRONMENT_ID, CLAIMED_COMPUTERS_RESULTS.failed);
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    seedClaimedQuery(
      harness,
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z")),
    );
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);
    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    const { auth, queryKey } = claimedQuery(harness, ENVIRONMENT_ID);
    let replacementOutcome: Promise<unknown> = Promise.resolve();
    await act(async () => {
      await harness.queryClient.cancelQueries({ queryKey, exact: true });
      replacementOutcome = harness.queryClient
        .fetchQuery({
          queryKey,
          queryFn: ({ signal }) =>
            auth.listClaimedComputers(ENVIRONMENT_ID, signal),
          staleTime: 0,
        })
        .then(
          () => "answered",
          (cause: unknown) => cause,
        );
    });
    await waitFor(() => expect(initialRead.signalAborted).toBe(true));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(await replacementOutcome).toBe("answered");
    const readsAfterFailure = claimCallCount(ENVIRONMENT_ID);
    harness.show(true, []);

    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();
    expect(claimCallCount(ENVIRONMENT_ID)).toBe(readsAfterFailure);
  });

  it("keeps today's cover when no claim names this computer", async () => {
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim("another-computer", "Priya", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await waitFor(() => expect(claimCallCount(ENVIRONMENT_ID)).toBe(1));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();
  });

  it("does not ask for team claims when the account has no organization environment", async () => {
    const harness = createClaimHarness([]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await waitFor(() => expect(harness.environmentRequestCount()).toBe(1));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(claimCalls).toEqual([]);
    expect(screen.getByText("No host is available")).toBeTruthy();
  });

  it("does not ask for team claims when environment.list fails without data", async () => {
    const harness = createClaimHarness([]);
    harness.setEnvironmentFailure(true);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await waitFor(() => expect(harness.environmentRequestCount()).toBe(1));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(claimCalls).toEqual([]);
    expect(screen.getByText("No host is available")).toBeTruthy();
  });

  it("uses the team label from the claims result across two teams", async () => {
    queueClaimPlan("team-first", CLAIMED_COMPUTERS_RESULTS.notFound);
    queueClaimPlan(
      "team-beta",
      claims(claim(WINDOW_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment("team-first", "Acme"),
      organizationEnvironment("team-beta", "Beta"),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await screen.findByText("Rao claimed this computer");
    assertWindowClaim("Rao", "Beta");
    expect(claimCalls).toEqual(["team-first", "team-beta"]);
  });

  it("uses the full claimant name", async () => {
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(claim(WINDOW_HOST_ID, "Dr. Rao", "2026-11-10T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await screen.findByText("Dr. Rao claimed this computer");
    assertWindowClaim("Dr. Rao", ENVIRONMENT_LABEL);
  });

  it("keeps the older team's claimant hidden until the newer team's read settles", async () => {
    const newerRead = deferredClaimRead();
    queueClaimPlan(
      "team-acme",
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z")),
    );
    queueClaimPlan("team-beta", newerRead);
    const harness = createClaimHarness([
      organizationEnvironment("team-acme", "Acme"),
      organizationEnvironment("team-beta", "Beta"),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await waitFor(() => expect(claimCallCount("team-beta")).toBe(1));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();

    act(() => {
      newerRead.resolve(
        claims(claim(WINDOW_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z")),
      );
    });
    await screen.findByText("Rao claimed this computer");
    assertWindowClaim("Rao", "Beta");
  });

  it("chooses the newest claim when the team dates are reversed", async () => {
    queueClaimPlan(
      "team-acme",
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-11-10T00:00:00.000Z")),
    );
    queueClaimPlan(
      "team-beta",
      claims(claim(WINDOW_HOST_ID, "Rao", "2026-10-01T00:00:00.000Z")),
    );
    const harness = createClaimHarness([
      organizationEnvironment("team-acme", "Acme"),
      organizationEnvironment("team-beta", "Beta"),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await screen.findByText("Priya claimed this computer");
    assertWindowClaim("Priya", "Acme");
  });

  it("chooses the newest of two claims from one team", async () => {
    queueClaimPlan(
      ENVIRONMENT_ID,
      claims(
        claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z"),
        claim(WINDOW_HOST_ID, "Rao", "2026-11-10T00:00:00.000Z"),
      ),
    );
    const harness = createClaimHarness([
      organizationEnvironment(ENVIRONMENT_ID, ENVIRONMENT_LABEL),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await screen.findByText("Rao claimed this computer");
    assertWindowClaim("Rao", ENVIRONMENT_LABEL);
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();
  });

  it("shows the older team's claim once the newer team's read fails", async () => {
    const newerRead = deferredClaimRead();
    queueClaimPlan(
      "team-a",
      claims(claim(WINDOW_HOST_ID, "Priya", "2026-10-01T00:00:00.000Z")),
    );
    queueClaimPlan("team-b", newerRead);
    const harness = createClaimHarness([
      organizationEnvironment("team-a", "A"),
      organizationEnvironment("team-b", "B"),
    ]);
    attachWindow(WINDOW_HOST_ID);
    setHostClaimedState(WINDOW_HOST_ID);
    harness.show(true, []);

    await waitFor(() => expect(claimCallCount("team-b")).toBe(1));
    expect(screen.getByText("No host is available")).toBeTruthy();
    expect(screen.queryByText("Priya claimed this computer")).toBeNull();

    act(() => {
      newerRead.resolve(CLAIMED_COMPUTERS_RESULTS.failed);
    });
    await screen.findByText("Priya claimed this computer");
    assertWindowClaim("Priya", "A");
  });
});
