import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  type AnyRouter,
} from "@tanstack/react-router";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  LocalHostSnapshot,
  StoredCredentialsIdentity,
} from "@traycer-clients/shared/platform/runner-host";
import {
  CURRENT_EPIC_VERSION,
  CURRENT_PHASE_VERSION,
} from "@traycer-clients/shared/epic/epic-version";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import { HeaderNotificationsBell } from "@/components/layout/header/app-header";
import { requireSignedIn } from "@/lib/router-auth";
import { bindAuthInvalidation, type AppRouterContext } from "@/router";
import { AUTH_ERROR_SESSION_EXPIRED } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";
import type {
  ListTasksRequest,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Cross-seam coverage for `s6-renderer-local-admission`.
 *
 * The composition this ticket fixes has no other test owner: host Vitest
 * globally stubs auth, and GUI tests mock the host away. This file drives
 * the REAL `AuthService` (constructed internally by the REAL
 * `HostRuntimeProvider`, exactly as production boots it) through a faked
 * authn HTTP boundary only, into the REAL `useAuthStore`, and asserts on
 * what the REAL renderer admission code (`root-landing-page.tsx` /
 * `router-auth.ts#requireSignedIn`) decides from it — with a REAL
 * `epic.listTasks` host round-trip through the REAL `useHostQuery` /
 * `useHostClient` production primitives (only the WebSocket wire is faked,
 * via `MockHostMessenger`).
 *
 * HISTORY, because this comment used to describe a live defect and now
 * describes a closed one. It read: the app's ACTUAL epics-list surfaces
 * "do NOT yet honor `admitsLocalPlane` … so today they render a permanent
 * loading skeleton under `unverified` rather than the local rows the host
 * would happily serve", scoped OUT of `s6-renderer-local-admission`.
 *
 * That was accurate, and it was the P1 an external reviewer later filed
 * against this branch — written down here, in prose, before the review
 * existed. It sat because a limitation recorded in a comment has no owner
 * and no trigger; the same night, the `it.skip` in
 * `hooks/epics/__tests__/use-cloud-epic-tasks-query.test.tsx` recorded the
 * same gap a second time and was un-skipped only after the reviewer found it.
 *
 * `resolveCloudTasksUserId` now gates on `admitsLocalPlane` and issues the
 * `localFirstPhase: "initial"` leg for an admitted identity, so the
 * epics-list half is CLOSED and asserted by that test.
 *
 * `epic-tab-existence-reconciler.tsx`'s `authStatus !== "signed-in"` gate is
 * NOT the same defect and is staying, deliberately. It was audited alongside
 * the above and kept: that reconciler force-closes tabs and deletes run
 * settings, and an `unverified` session still carries a live credential lease
 * to the host, so `epic.getTaskContexts` can return a genuine
 * `confirmed-absent` from the cloud. `unverified` commonly means authn's
 * validation endpoint was unreachable while the cloud-data path was fine — so
 * admitting it would widen a DESTRUCTIVE path on evidence gathered before the
 * account verdict. Restored tabs staying unreconciled until `signed-in` is the
 * cheaper failure. See the note at that gate.
 *
 * This file's `LocalEpicsProbe` still drives `epic.listTasks` directly through
 * the same real `useHostQuery` primitive those components use internally,
 * WITHOUT their auth gate — now to keep this file testing only what THIS
 * ticket owns (whether the renderer ADMITS the user to a point where local,
 * disk-served content renders and is interactive), rather than because the
 * surfaces cannot do it themselves.
 */

const VALIDATION_URL = "http://localhost:5005/api/v3/user";
const REFRESH_URL = "http://localhost:5005/api/v3/auth/refresh";
/**
 * The exact URL `fetchRegisteredHostsViaHttp` (`remote-fetcher.ts`) builds
 * from the mock's `authnBaseUrl` — the wire endpoint the REAL
 * `buildDefaultRemoteFetcher` reaches through `AuthService.fetchRegisteredHosts`
 * → `IRunnerHost.listRegisteredHosts`. See the file header: this test no
 * longer stubs `remoteFetcher`, so this is where the discriminating
 * absence/presence assertions below are made.
 */
const HOSTS_URL = "http://localhost:5005/api/v3/hosts";

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-1",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
  availability: "available",
};

type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Promise<Response>;

interface FetchLedger {
  validationAttempts: number;
  validationSuccesses: number;
  refreshAttempts: number;
  /** Count of real `GET /api/v3/hosts` requests observed at the wire. */
  hostsRequests: number;
}

function freshLedger(): FetchLedger {
  return {
    validationAttempts: 0,
    validationSuccesses: 0,
    refreshAttempts: 0,
    hostsRequests: 0,
  };
}

/** Cold-start-unreachable: every `/api/v3/user` and `/refresh` call fails to transport. */
function networkErrorFetch(ledger: FetchLedger): FetchHandler {
  return (url) => {
    if (url === VALIDATION_URL) {
      ledger.validationAttempts += 1;
      return Promise.reject(new Error("authn unreachable"));
    }
    if (url === REFRESH_URL) {
      ledger.refreshAttempts += 1;
      return Promise.reject(new Error("authn unreachable"));
    }
    // Should never be reached under `unverified` — `cloudBearer()` withholds
    // the bearer before `fetchRegisteredHosts` ever calls `fetch`. Tracked
    // (rather than left to fall into the catch-all below) so a regression
    // shows up as a ledger assertion failure, not a swallowed rejection.
    if (url === HOSTS_URL) {
      ledger.hostsRequests += 1;
      return Promise.reject(new Error("authn unreachable"));
    }
    return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
  };
}

/** Reachable-but-dead-credential: both calls answer, both reject with 401. */
function rejectedFetch(ledger: FetchLedger): FetchHandler {
  return (url) => {
    if (url === VALIDATION_URL) {
      ledger.validationAttempts += 1;
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    if (url === REFRESH_URL) {
      ledger.refreshAttempts += 1;
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    // See `networkErrorFetch` above: should never be reached under
    // `unverified`, tracked so a regression fails a ledger assertion.
    if (url === HOSTS_URL) {
      ledger.hostsRequests += 1;
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
  };
}

/**
 * Minimal, schema-valid body for AuthnV3's `/api/v3/user` 200 response
 * (`authenticatedUserSchema`, `protocol/src/auth/_internal/schemas.ts`) —
 * enough fields to satisfy the `.strict()`-adjacent record parse
 * `validateAuthTokenIdentityAccessOnly` runs, nothing more.
 */
function authenticatedUserResponseBody(
  identity: StoredCredentialsIdentity,
): unknown {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    user: {
      id: identity.id,
      name: identity.name,
      providerId: identity.id,
      providerHandle: identity.email,
      providerType: "EMAIL",
      email: identity.email,
      avatarUrl: null,
      activatedAt: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
      privacyMode: false,
      isLearningEnabled: false,
    },
    userSubscription: {
      id: "sub-1",
      userID: identity.id,
      orgID: null,
      teamID: null,
      customerId: "cust-1",
      createdAt: now,
      updatedAt: now,
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus: "FREE",
      hasPaymentMethod: null,
      isInTrial: false,
      rechargeRateSeconds: 0,
    },
    payAsYouGoUsage: { allowPayAsYouGo: false },
    teamSubscriptions: [],
  };
}

/**
 * Positive control (see file header): `/api/v3/user` answers 200 with a
 * schema-valid identity, so the real `AuthService` reaches `signed-in` and
 * `cloudBearer()` genuinely holds a bearer — the real
 * `buildDefaultRemoteFetcher` → `fetchRegisteredHostsViaHttp` wiring puts a
 * real `GET /api/v3/hosts` on the wire through this same fetch boundary.
 */
function signedInFetch(
  ledger: FetchLedger,
  identity: StoredCredentialsIdentity,
): FetchHandler {
  return (url) => {
    if (url === VALIDATION_URL) {
      ledger.validationAttempts += 1;
      ledger.validationSuccesses += 1;
      return Promise.resolve(
        new Response(JSON.stringify(authenticatedUserResponseBody(identity)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url === HOSTS_URL) {
      ledger.hostsRequests += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ hosts: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url === REFRESH_URL) {
      ledger.refreshAttempts += 1;
      return Promise.reject(
        new Error("unexpected refresh: this session validates cleanly"),
      );
    }
    return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
  };
}

function installFetch(initial: FetchHandler): {
  readonly setHandler: (handler: FetchHandler) => void;
  readonly restore: () => void;
} {
  const original: unknown = (globalThis as { fetch?: unknown }).fetch;
  let handler = initial;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown, init: RequestInit | undefined) =>
      handler(typeof input === "string" ? input : String(input), init),
  });
  return {
    setHandler: (next: FetchHandler) => {
      handler = next;
    },
    restore: () => {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
}

type ListTasksHandler = (params: ListTasksRequest) => ListTasksResponse;

function epicRow(
  id: string,
  title: string,
  updatedAtIso: string,
): ListTasksResponse["tasks"][number] {
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "local disk prompt",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: Date.parse(updatedAtIso),
        updatedAt: Date.parse(updatedAtIso),
        createdBy: "user-1",
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
  };
}

function buildMessengerFactory(
  tasksHandler: ListTasksHandler,
): (args: { registry: HostRpcRegistry }) => IHostMessenger<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
      handlers: {
        "epic.listTasks": (params): Promise<ListTasksResponse> =>
          Promise.resolve(tasksHandler(params)),
        "host.status": () =>
          Promise.resolve({
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
            busyBreakdown: null,
            updateOperation: null,
            updateTransaction: null,
          }),
      },
    });
}

/**
 * A minimal, REAL local-plane consumer: `useHostClient()` +
 * `useHostQuery("epic.listTasks")`, the exact production primitives
 * `gui-app/AGENTS.md` prescribes for "Host RPC" reads. It carries NO auth
 * gate of its own (unlike `useCloudEpicTasksQuery`/`EpicTabExistenceReconciler`
 * — see the file header). Mounted behind the REAL admission gate under test,
 * it stands in for "any surface that renders local, disk-served content" —
 * see the file header for why the app's actual epics-list surfaces cannot
 * serve this role today.
 */
function LocalEpicsProbe(): ReactNode {
  const client = useHostClient();
  const [query, setQuery] = useState("");
  const listQuery = useHostQuery<HostRpcRegistry, "epic.listTasks">({
    client,
    method: "epic.listTasks",
    params: {
      limit: 20,
      filters: query.length === 0 ? null : { query },
      extensionPhaseVersion: String(CURRENT_PHASE_VERSION),
      extensionEpicVersion: String(CURRENT_EPIC_VERSION),
    },
    cacheKeyIdentity: undefined,
    options: { enabled: true },
  });
  const tasks = listQuery.data?.tasks ?? [];
  return (
    <div data-testid="local-epics-probe">
      <input
        aria-label="Filter local epics"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
      <ul data-testid="local-epics-probe-rows">
        {tasks.map((task) => {
          const id = task.epic?.light?.id ?? task.phase?.light?.id ?? "unknown";
          const title =
            task.epic?.light?.title ?? task.phase?.light?.title ?? "untitled";
          return (
            <li key={id} data-testid="local-epics-probe-row">
              {title}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface Harness {
  readonly host: MockRunnerHost;
  readonly router: AnyRouter;
  readonly setFetchHandler: (handler: FetchHandler) => void;
  readonly teardown: () => void;
}

/**
 * The default stored principal every existing arm of this file signs in as.
 * Kept as a named constant (rather than inlined into `mountHarness`) so a
 * caller that DOES care which principal is on disk has something to diverge
 * from, and every caller that does not gets byte-identical behaviour to
 * before this was parameterised.
 */
const DEFAULT_STORED_IDENTITY: StoredCredentialsIdentity = {
  id: "user-1",
  email: "user1@example.com",
  name: "User One",
};

/**
 * `storedIdentity` parameterises WHICH principal `host.tokenStore.signIn`
 * mints the stored session for. `MockRunnerHost.tokenStore.signIn` already
 * accepts any identity (see its mock implementation), so this is fixture
 * plumbing only - no credential-layer work. Defaults to
 * {@link DEFAULT_STORED_IDENTITY} when the caller passes `undefined`, so both
 * existing arms below are unaffected; a later cross-principal test mints a
 * SECOND harness with a different identity to drive a two-principal scenario
 * through the same real `AuthService` × `useAuthStore` wiring.
 *
 * `T | undefined` with every caller passing explicitly, NOT `storedIdentity?:`.
 * The repo bans optional parameters in favour of this shape, and the three
 * lines below (`workspaceFolderPickerPaths: undefined`, `hasLocalHost`,
 * `traycerCli`) are the same convention in the same function. ESLint's
 * `optionalParameterRestrictions` happens not to reach a `TSPropertySignature`,
 * but that is an enforcement gap rather than a licence.
 */
/**
 * Harnesses mounted by the current test, torn down unconditionally in
 * `afterEach`. See the note at the push site for why the per-test tail calls
 * are not sufficient on their own.
 */
const activeHarnesses: Harness[] = [];

function mountHarness(opts: {
  readonly storedToken: string;
  readonly initialFetch: FetchHandler;
  readonly tasksHandler: ListTasksHandler;
  readonly storedIdentity: StoredCredentialsIdentity | undefined;
}): Harness {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: localSnapshot,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  void host.tokenStore.signIn(
    { token: opts.storedToken, refreshToken: `${opts.storedToken}-refresh` },
    opts.storedIdentity ?? DEFAULT_STORED_IDENTITY,
  );

  const fetchControl = installFetch(opts.initialFetch);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });

  const rootRoute = createRootRouteWithContext<AppRouterContext>()({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    path: "/",
    getParentRoute: () => rootRoute,
    component: () => <div data-testid="home-stub">home</div>,
  });
  const epicsRoute = createRoute({
    path: "/epics",
    getParentRoute: () => rootRoute,
    beforeLoad: ({ context }) => {
      requireSignedIn(context);
    },
    component: LocalEpicsProbe,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, epicsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: {
      queryClient,
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
  const unsubscribeAuthInvalidation = bindAuthInvalidation(router);

  const Wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={buildMessengerFactory(opts.tasksHandler)}
          invalidator={null}
          requestId={null}
          // `null` installs the REAL `buildDefaultRemoteFetcher` (via
          // `createAuthBoundHostDirectory`) — the path this ticket's fix
          // lives on. A stubbed fetcher here would suppress `GET
          // /api/v3/hosts` itself, making the absence assertions below
          // vacuous; see the file header.
          remoteFetcher={null}
          fallback={<div data-testid="runtime-fallback">loading runtime…</div>}
        >
          {children}
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>
  );

  render(
    <Wrapper>
      {/* Persistent, routing-independent admission sentinel: the REAL
          `RootLandingPage`, driven by the REAL store. It renders the REAL
          `AuthLandingPage` whenever `!admitsLocalPlane(status)` and `null`
          otherwise — this is the mechanism the ticket fixes, not a stand-in
          for it. */}
      <div data-testid="admission-sentinel">
        <RootLandingPage />
      </div>
      {/* Positive control: a genuinely cloud-dependent surface, through the
          IDENTICAL `useAuthStore` wiring, still gated on `status ===
          "signed-in"` (see `app-header.tsx`). */}
      <div data-testid="cloud-control-slot">
        <HeaderNotificationsBell />
      </div>
      <RouterProvider router={router} />
    </Wrapper>,
  );

  const harness: Harness = {
    host,
    router,
    setFetchHandler: fetchControl.setHandler,
    teardown: () => {
      unsubscribeAuthInvalidation();
      fetchControl.restore();
      queryClient.clear();
    },
  };
  // Registered so `afterEach` can tear it down UNCONDITIONALLY.
  //
  // Each test also calls `harness.teardown()` on its final line, which is fine
  // when the test passes and useless when it does not: an assertion failing
  // earlier skips that line, leaving this test's `fetch` stub installed
  // globally. The next test then runs against the previous test's network, and
  // the first real red cascades into a run of unrelated ones - the suite
  // becomes LEAST diagnostic exactly when it first has something to say.
  //
  // `teardown` is idempotent (`restore` reinstalls the captured original,
  // `clear` on an emptied client is a no-op), so the tail calls can stay.
  activeHarnesses.push(harness);
  return harness;
}

describe("renderer local admission — cross-seam (real AuthService × real useAuthStore × real useHostQuery)", () => {
  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  afterEach(() => {
    // Drain in reverse: a test that mounted more than one harness restores the
    // fetch stubs in the opposite order to installation, so the ORIGINAL global
    // is what survives rather than an intermediate stub.
    while (activeHarnesses.length > 0) {
      activeHarnesses.pop()?.teardown();
    }
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it("admits the interactive local epics probe on a network-unreachable cold start, while a genuinely cloud-gated surface stays dark — no successful /api/v3/user is ever consumed", async () => {
    const ledger = freshLedger();
    const listTasksRequests: ListTasksRequest[] = [];
    const tasksHandler: ListTasksHandler = (params) => {
      listTasksRequests.push(params);
      if (params.filters?.query === "renderer") {
        return {
          tasks: [
            epicRow(
              "epic-2",
              "Renderer Admission Epic",
              "2026-08-24T09:00:00.000Z",
            ),
          ],
          hasMore: false,
        };
      }
      return {
        tasks: [
          epicRow("epic-1", "Local Disk Epic", "2026-08-24T08:00:00.000Z"),
        ],
        hasMore: false,
      };
    };
    const harness = mountHarness({
      storedToken: "stored-token",
      initialFetch: networkErrorFetch(ledger),
      tasksHandler,
      // Explicit, per the `T | undefined` convention on `mountHarness`.
      storedIdentity: undefined,
    });

    // Cold start settles into `unverified` — the local plane is admitted
    // WITHOUT any successful /api/v3/user verdict.
    await vi.waitFor(
      () => {
        expect(useAuthStore.getState().status).toBe("unverified");
      },
      { timeout: 5000, interval: 50 },
    );
    expect(ledger.validationSuccesses).toBe(0);
    expect(ledger.validationAttempts).toBeGreaterThan(0);
    // network-error never authorizes a rotate spend (tech plan §5).
    expect(ledger.refreshAttempts).toBe(0);
    // DISCRIMINATING ASSERTION, at the fetch boundary: the REAL
    // `buildDefaultRemoteFetcher` is installed (no stub — see
    // `mountHarness`), yet no real `GET /api/v3/hosts` reached the wire.
    // `cloudBearer()` withholds the bearer under `unverified`, so
    // `fetchRegisteredHosts` returns before ever calling `fetch`. Paired
    // below with `signedInFetch`'s positive control, which proves this
    // absence is a real suppression and not an artifact of dead wiring.
    expect(ledger.hostsRequests).toBe(0);

    // DISCRIMINATING ASSERTION (admission gate #1, root-landing-page.tsx):
    // the real AuthLandingPage never rendered. An absence check alone would
    // be vacuous (shape #2), so it is paired below with real interactive
    // content and a positive control in the identical tree.
    expect(screen.queryByText("Welcome to Traycer")).toBeNull();

    // Positive control, identical wiring: a surface that really does read
    // `status === "signed-in"` (app-header.tsx#HeaderNotificationsBell)
    // stays dark under `unverified`. Without this, the local content below
    // would only prove something upstream was stubbed permissively.
    expect(screen.getByTestId("cloud-control-slot").childElementCount).toBe(0);

    // Admission gate #2 (router-auth.ts#requireSignedIn): a real navigation
    // to a real requireSignedIn-guarded route succeeds without a validated
    // session.
    await act(async () => {
      await harness.router.navigate({ to: "/epics" });
    });
    expect(harness.router.state.location.pathname).toBe("/epics");

    // DISCRIMINATING ASSERTION (the mechanism, not an effect): a real
    // `epic.listTasks` round-trip through the real `useHostQuery` renders
    // actual local-homed rows (only the WS wire is faked).
    await screen.findByText("Local Disk Epic");
    expect(screen.getAllByTestId("local-epics-probe-row")).toHaveLength(1);

    // INTERACTIVE, not just rendered: typing in the real filter input
    // drives a real host round-trip and the DOM updates from it.
    const filterInput = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Filter local epics",
    });
    fireEvent.change(filterInput, { target: { value: "renderer" } });
    await screen.findByText("Renderer Admission Epic");
    expect(
      listTasksRequests.some(
        (request) => request.filters?.query === "renderer",
      ),
    ).toBe(true);

    // Still true after all of the above: local interaction never spent a
    // /api/v3/user verdict, and the real hosts fetcher still never put a
    // request on the wire.
    expect(ledger.validationSuccesses).toBe(0);
    expect(ledger.hostsRequests).toBe(0);

    harness.teardown();
  }, 15000);

  it("a refresh-rejected recovery tick does not tear down local access already in progress", async () => {
    const ledger = freshLedger();
    const tasksHandler: ListTasksHandler = (params) => {
      if (params.filters?.query === "zzz-no-match") {
        return { tasks: [], hasMore: false };
      }
      return {
        tasks: [
          epicRow("epic-1", "Local Disk Epic", "2026-08-24T08:00:00.000Z"),
        ],
        hasMore: false,
      };
    };
    const harness = mountHarness({
      storedToken: "stored-token",
      initialFetch: networkErrorFetch(ledger),
      tasksHandler,
      // Explicit, per the `T | undefined` convention on `mountHarness`.
      storedIdentity: undefined,
    });

    // Phase A: establish local access "already in progress" via the same
    // cold-start-unreachable path as arm 1.
    await vi.waitFor(
      () => {
        expect(useAuthStore.getState().status).toBe("unverified");
      },
      { timeout: 5000, interval: 50 },
    );
    await act(async () => {
      await harness.router.navigate({ to: "/epics" });
    });
    await screen.findByText("Local Disk Epic");
    const rowsBefore = screen.getByTestId("local-epics-probe-rows");
    const filterInputBefore = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Filter local epics",
    });
    // Prove the pre-existing session is genuinely in use, not idle.
    fireEvent.change(filterInputBefore, { target: { value: "disk" } });
    await vi.waitFor(() => {
      expect(filterInputBefore.value).toBe("disk");
    });
    fireEvent.change(filterInputBefore, { target: { value: "" } });
    await screen.findByText("Local Disk Epic");

    // Phase B: the network returns, but this credential is genuinely dead —
    // /api/v3/user now answers 401 (rejected, not network-error) and the
    // locked rotate's refresh also 401s. A 401 classifies CREDENTIAL-scoped,
    // so this is the exact outcome `applyUnadoptedStoredRotateOutcome`'s
    // "refresh-rejected-credential" branch handles - the arm that HOLDS the
    // local plane. Reached here through the background recovery tick
    // `scheduleSessionRecovery("startup:validate-network")` already armed.
    harness.setFetchHandler(rejectedFetch(ledger));
    // Wait on the APPLIED verdict, not on the request having been issued.
    // `rejectedFetch` bumps `refreshAttempts` BEFORE it returns the 401, so a
    // ledger-only wait settles while the rejection is still unprocessed -
    // `applyUnadoptedStoredRotateOutcome` is several microtasks downstream of
    // it. The status assertion below would then read the state phase A already
    // established, and pass because nothing had happened yet rather than
    // because the local plane was held. `getLastError()` is the discriminating
    // marker: it flips only once the rejection has been applied, so waiting on
    // it is what makes the assertion that follows mean anything.
    await vi.waitFor(
      () => {
        expect(ledger.refreshAttempts).toBeGreaterThanOrEqual(1);
        expect(getHostBindingSnapshot()?.auth.getLastError()).toBe(
          AUTH_ERROR_SESSION_EXPIRED,
        );
      },
      { timeout: 5000, interval: 50 },
    );

    // DISCRIMINATING ASSERTION #1 (the store): local admission survives —
    // status is re-affirmed as `unverified`, never dropped to `signed-out`.
    // A wrong implementation that reused `applyLiveRotateOutcome`'s
    // sibling handling (clearUiSession on refresh-rejected) fails here.
    expect(useAuthStore.getState().status).toBe("unverified");
    // Never signed-in at any point across phases A/B, so the real hosts
    // fetcher's bearer gate never opened — no `GET /api/v3/hosts` reached
    // the wire (same fetch-boundary discrimination as arm 1).
    expect(ledger.hostsRequests).toBe(0);

    // The credentials file is deliberately KEPT on refresh-rejected — the
    // identity that names this machine's local epics is still on disk.
    const stored = await harness.host.tokenStore.get();
    expect(stored?.token).toBe("stored-token");

    // DISCRIMINATING ASSERTION #2 (the render, structural canary): the
    // rendered rows container was never torn down. `requireSignedIn` is
    // re-evaluated on every auth-status change via `bindAuthInvalidation`
    // — if refresh-rejected had (even momentarily) projected a
    // non-admitted status, the router would have redirected `/epics` away
    // to `/`, destroying this exact DOM node. A wrong implementation is
    // structurally incapable of passing this reference check even if it
    // "eventually" re-admits the session, because React would have to
    // unmount and remount the subtree to get there.
    const rowsAfter = screen.getByTestId("local-epics-probe-rows");
    expect(rowsAfter).toBe(rowsBefore);
    expect(screen.getByText("Local Disk Epic")).not.toBeNull();

    // Still interactive after the rejection, not just present.
    const filterInputAfter = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Filter local epics",
    });
    expect(filterInputAfter).toBe(filterInputBefore);
    fireEvent.change(filterInputAfter, { target: { value: "zzz-no-match" } });
    await vi.waitFor(() => {
      expect(screen.queryAllByTestId("local-epics-probe-row")).toHaveLength(0);
    });

    harness.teardown();
  }, 15000);

  it("positive control: a genuinely signed-in session, through the IDENTICAL real remote-fetcher wiring, DOES put GET /api/v3/hosts on the wire", async () => {
    // Without this arm, the two arms above only prove an empty request
    // ledger — which passes just as well against a fetcher that never fires
    // for ANY reason (a typo'd URL, a swallowed exception, dead wiring). This
    // arm drives the same real `buildDefaultRemoteFetcher` →
    // `AuthService.fetchRegisteredHosts` → `fetchRegisteredHostsViaHttp`
    // chain to a genuine `signed-in` verdict and shows it DOES egress —
    // proving the arms above are suppression, not silence.
    const ledger = freshLedger();
    const tasksHandler: ListTasksHandler = () => ({
      tasks: [epicRow("epic-1", "Local Disk Epic", "2026-08-24T08:00:00.000Z")],
      hasMore: false,
    });
    const harness = mountHarness({
      storedToken: "stored-token",
      initialFetch: signedInFetch(ledger, DEFAULT_STORED_IDENTITY),
      tasksHandler,
      // Explicit, per the `T | undefined` convention on `mountHarness`.
      storedIdentity: undefined,
    });

    await vi.waitFor(
      () => {
        expect(useAuthStore.getState().status).toBe("signed-in");
      },
      { timeout: 5000, interval: 50 },
    );
    expect(ledger.validationSuccesses).toBeGreaterThan(0);

    // DISCRIMINATING ASSERTION: the real fetch boundary DOES see a
    // `GET /api/v3/hosts` once the session is genuinely signed-in — the
    // mirror image of the `unverified` arms' absence assertions above.
    await vi.waitFor(
      () => {
        expect(ledger.hostsRequests).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 50 },
    );

    harness.teardown();
  }, 15000);
});
