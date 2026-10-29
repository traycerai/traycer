import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import {
  act,
  cleanup,
  render,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import { organizationSubscribeV11 } from "@traycer/protocol/host/organization/contracts";
import {
  AuthService,
  type LiveRevalidationOutcome,
} from "@/lib/auth/auth-service";
import { OrganizationProvider } from "@/hooks/organization/organization-provider";
import { useCloseTilesOnTeamRemoval } from "@/hooks/teams/use-close-tiles-on-team-removal";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * The organization provider's own call-triggering rules are covered against
 * a fake `AuthService` in `organization-provider-revalidate-auth.test.tsx`.
 * This file proves the other half of the contract against the REAL
 * `AuthService`: the pushed stream frame that actually drives
 * `revalidateCurrentContextAfterInvalidation()`, and that method's own
 * single-flight/trailing-read semantics - at most one trailing read queued
 * behind a running one, a signal arriving while that trailing read is itself
 * running starts its own next trailing read, a read already in flight for
 * another caller (Settings) is still followed by a fresh one, and neither a
 * signed-out account nor a replaced one ever has a stale queued read applied
 * to it.
 *
 * Every wait is on a real, observable signal: a spy on the real method
 * proves Query actually dispatched into it, and the controlled fetch queue
 * proves how many real reads landed. Where a check runs synchronously with
 * no `waitFor`, it is because the fact it asserts is decided synchronously
 * inside that call (a branch taken before any `await`), not because a fixed
 * number of microtask turns were assumed to be "enough".
 */

const NEGOTIATED_VALIDATION_URL =
  "http://localhost:5005/api/v3/user/negotiated";

interface TeamFixture {
  readonly id: string;
  readonly slug: string;
}

const TEAM_A: TeamFixture = { id: "team-a", slug: "team-a-slug" };

function teamSubscription(userId: string, team: TeamFixture) {
  return {
    id: `sub-${team.id}`,
    userID: userId,
    orgID: null,
    teamID: team.id,
    customerId: `cus-${team.id}`,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    subscriptionExpiry: null,
    trialEndsAt: null,
    subscriptionStatus: "FREE",
    hasPaymentMethod: false,
    isInTrial: false,
    bundleSummary: { bundleTotal: 0, bundleConsumed: 0, bundleRemaining: 0 },
    totalPlanCredits: 0,
    rechargeRateSeconds: 0,
    hasActiveBundle: false,
    team: {
      id: team.id,
      slug: team.slug,
      avatarUrl: null,
      privacyMode: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  };
}

interface ProfileFixture {
  readonly userId: string;
  readonly teams: readonly TeamFixture[];
}

function profileResponse(profile: ProfileFixture): Response {
  return new Response(
    JSON.stringify({
      user: {
        id: profile.userId,
        name: `${profile.userId} display`,
        providerId: `gh-${profile.userId}`,
        providerHandle: profile.userId,
        providerType: "GITHUB",
        email: `${profile.userId}@example.com`,
        avatarUrl: null,
        activatedAt: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        lastSeenAt: null,
        privacyMode: false,
        isLearningEnabled: true,
      },
      userSubscription: {
        id: `sub-${profile.userId}`,
        userID: profile.userId,
        orgID: null,
        teamID: null,
        customerId: `cus-${profile.userId}`,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        subscriptionExpiry: null,
        trialEndsAt: null,
        subscriptionStatus: "FREE",
        hasPaymentMethod: false,
        isInTrial: false,
        rechargeRateSeconds: 0,
      },
      teamSubscriptions: profile.teams.map((team) =>
        teamSubscription(profile.userId, team),
      ),
      payAsYouGoUsage: { allowPayAsYouGo: false },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-traycer-user-record-version": "2.0",
      },
    },
  );
}

interface QueuedValidation {
  resolve(profile: ProfileFixture): void;
}

/**
 * Installs a fetch stub answering only the identity-validation route the
 * real revalidate paths hit. The sign-in that establishes the session
 * resolves at once with `signedIn`; every later validation call - whichever
 * of `revalidateCurrentContext` / `revalidateCurrentContextAfterInvalidation`
 * reaches it, including a caller outside the organization provider, or a
 * second account's own sign-in - is queued for the test to settle explicitly
 * and in order, so the suite can observe exactly how many real reads
 * happened and feed each one the account state at that moment.
 */
function installControlledValidationFetch(signedIn: ProfileFixture): {
  readonly queue: QueuedValidation[];
  restore(): void;
} {
  let signInSettled = false;
  const queue: QueuedValidation[] = [];
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url !== NEGOTIATED_VALIDATION_URL) {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      if (!signInSettled) {
        signInSettled = true;
        return Promise.resolve(profileResponse(signedIn));
      }
      return new Promise<Response>((resolve) => {
        queue.push({
          resolve: (profile) => resolve(profileResponse(profile)),
        });
      });
    },
  });
  return {
    queue,
    restore: () => {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    },
  };
}

async function deviceSignIn(
  service: AuthService,
  host: MockRunnerHost,
  session: { readonly token: string },
): Promise<void> {
  await service.signIn();
  host.deviceFlow.emitResult({
    kind: "authorized",
    token: session.token,
    refreshToken: `${session.token}-refresh`,
  });
  await vi.waitFor(() => {
    expect(service.getCurrentSessionSnapshot().token).toBe(session.token);
  });
}

function makeRealService(): {
  readonly service: AuthService;
  readonly host: MockRunnerHost;
} {
  const host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return { service: new AuthService({ runnerHost: host }), host };
}

/** The stream the provider's account-wide `OrganizationSubscription` rides: captures its pushed-frame callback so the test can push real, schema-shaped frames. */
interface CapturedOrganizationStream {
  readonly wsStreamClient: {
    readonly subscribe: () => {
      readonly onServerFrame: (listener: (envelope: unknown) => void) => void;
      readonly close: () => void;
    };
    readonly subscribeAvailabilityRecovered: () => () => void;
  };
  push(view: OrganizationView): void;
}

function capturedOrganizationStream(): CapturedOrganizationStream {
  let listener: ((envelope: unknown) => void) | null = null;
  return {
    wsStreamClient: {
      subscribe: () => ({
        onServerFrame: (next) => {
          listener = next;
        },
        close: () => {
          listener = null;
        },
      }),
      subscribeAvailabilityRecovered: () => () => undefined,
    },
    push: (view) => {
      listener?.({ kind: "snapshot", hasBinaryPayload: false, view });
    },
  };
}

const mocks = vi.hoisted(() => {
  const identity = { hostId: "host-1", userId: "user-1" };
  const client = {
    getActiveHostId: () => identity.hostId,
    getRequestContextUserId: () => identity.userId,
  };
  const toastInfo = vi.fn();
  const authService: { current: unknown } = { current: null };
  const stream: { current: unknown } = { current: null };
  return { identity, client, toastInfo, authService, stream };
});

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: {
    info: mocks.toastInfo,
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// No host of this team was ever registered, matching the staging repro the
// design targets: the team has no hosts, so the toast hook's only source for
// a display name is the slug.
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({ data: { hosts: [] } }),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.client,
  useAuthService: () => mocks.authService.current,
}));

vi.mock("@/hooks/host/use-pool-tier", () => ({
  usePoolTierHostClient: <T,>(c: T): T => c,
  usePoolTierStreamClient: () =>
    (mocks.stream.current as CapturedOrganizationStream | null)
      ?.wsStreamClient ?? null,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: mocks.identity.hostId,
    requestContextUserId: mocks.identity.userId,
  }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostSupportsMethod: () => true,
}));

vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () =>
    (mocks.stream.current as CapturedOrganizationStream | null) === null
      ? null
      : {
          wsStreamClient: (mocks.stream.current as CapturedOrganizationStream)
            .wsStreamClient,
        },
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  // The account-wide subscription's own refresh query: never fetched here -
  // every view in this file arrives through the real pushed stream frame,
  // exactly as `organization.subscribe`'s server push does.
  useHostQuery: () => ({
    data: undefined,
    isFetchedAfterMount: false,
    isSuccess: false,
  }),
  useHostMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/components/organization/organization-dialogs", () => ({
  OrganizationDialogHost: () => null,
}));

vi.mock("@/lib/epic-selectors", async (load) => {
  const actual = await load<typeof import("@/lib/epic-selectors")>();
  return { ...actual, useRegisteredEpicLocalHome: () => false };
});

function emptyView(historyInvalidation: string): OrganizationView {
  return {
    catalog: [],
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
    historyInvalidation,
  };
}

// The frame schema is validated on the way in (`organizationSubscribeV11`);
// asserting against it up front catches a malformed fixture at the point of
// authorship rather than as a silently-dropped frame deep in the provider.
function assertValidFrame(envelope: unknown): void {
  const result = organizationSubscribeV11.serverFrameSchema.safeParse(envelope);
  if (!result.success) {
    throw new Error(
      `invalid organization.subscribe frame: ${result.error.message}`,
    );
  }
}

/** The promise a spied call returned, for awaiting that specific call's own completion. */
function returnedPromise(
  spy: MockInstance<() => Promise<LiveRevalidationOutcome | null>>,
  callIndex: number,
): Promise<LiveRevalidationOutcome | null> {
  const result = spy.mock.results[callIndex];
  if (result.type !== "return") {
    throw new Error(`expected call ${callIndex} to have returned`);
  }
  return result.value;
}

function pushAccountWideFrame(
  stream: CapturedOrganizationStream,
  historyInvalidation: string,
): void {
  const view = emptyView(historyInvalidation);
  assertValidFrame({ kind: "snapshot", hasBinaryPayload: false, view });
  act(() => {
    stream.push(view);
  });
}

function CloseTilesProbe() {
  useCloseTilesOnTeamRemoval();
  return null;
}

function providerTree(): ReactElement {
  return (
    <OrganizationProvider>
      <CloseTilesProbe />
    </OrganizationProvider>
  );
}

function renderProvider(queryClient: QueryClient): RenderResult {
  return render(
    <QueryClientProvider client={queryClient}>
      {providerTree()}
    </QueryClientProvider>,
  );
}

function rerenderProvider(
  rendered: RenderResult,
  queryClient: QueryClient,
): void {
  act(() => {
    rendered.rerender(
      <QueryClientProvider client={queryClient}>
        {providerTree()}
      </QueryClientProvider>,
    );
  });
}

describe("OrganizationProvider -> real AuthService.revalidateCurrentContextAfterInvalidation", () => {
  let restoreFetch: () => void = () => undefined;
  let queue: QueuedValidation[] = [];
  let realStream: CapturedOrganizationStream;
  let realAuthService: AuthService;
  let realHost: MockRunnerHost;
  let spy: MockInstance<() => Promise<LiveRevalidationOutcome | null>>;

  beforeEach(async () => {
    mocks.identity.hostId = "host-1";
    mocks.identity.userId = "user-1";
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    mocks.toastInfo.mockClear();
    realStream = capturedOrganizationStream();
    mocks.stream.current = realStream;
    const built = makeRealService();
    realAuthService = built.service;
    realHost = built.host;
    mocks.authService.current = built.service;
    spy = vi.spyOn(built.service, "revalidateCurrentContextAfterInvalidation");
    const installed = installControlledValidationFetch({
      userId: "user-1",
      teams: [TEAM_A],
    });
    queue = installed.queue;
    restoreFetch = () => installed.restore();
    await deviceSignIn(built.service, built.host, { token: "live-token" });
  });

  afterEach(() => {
    cleanup();
    realAuthService.dispose();
    mocks.authService.current = null;
    mocks.stream.current = null;
    restoreFetch();
    useAuthStore.getState().setSignedOut();
  });

  it("a pushed account-wide frame's changed token drives a real revalidate, and the team-removal toast fires once the real read lands", async () => {
    const queryClient = new QueryClient();
    renderProvider(queryClient);

    pushAccountWideFrame(realStream, "token-1"); // first load: establishes the baseline.
    // `accept`'s "first load, skip" branch is taken synchronously inside the
    // frame handler above; nothing async could still invoke the method.
    expect(spy).not.toHaveBeenCalled();

    pushAccountWideFrame(realStream, "token-2"); // the membership change.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queue).toHaveLength(1));

    act(() => {
      queue[0]?.resolve({ userId: "user-1", teams: [] }); // the real read: the member's own team is gone.
    });
    await returnedPromise(spy, 0);

    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith(
        "You are no longer a member of team-a-slug.",
      ),
    );
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(1);
  });

  it("coalesces signals that land while the read they'd trigger is still out, into one trailing read driven by the last signal's own fresh answer", async () => {
    const queryClient = new QueryClient();
    renderProvider(queryClient);
    pushAccountWideFrame(realStream, "token-1");
    expect(spy).not.toHaveBeenCalled();

    pushAccountWideFrame(realStream, "token-2"); // A: fires immediately.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queue).toHaveLength(1));

    pushAccountWideFrame(realStream, "token-3"); // B: queues a trailing read behind A.
    pushAccountWideFrame(realStream, "token-4"); // C: lands while B is still only queued (A has not settled) - coalesces into B.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    // B's and C's own fenced decision (coalesce vs. start a fresh read) is
    // made synchronously inside each dispatched call, before any further
    // await; A is still unresolved, so neither could have started a second
    // read yet.
    expect(queue).toHaveLength(1);

    act(() => {
      // A's own (unchanged) answer - so a toast here would prove A's
      // resolution wrongly re-applied, not the trailing read's own fresh one.
      queue[0]?.resolve({ userId: "user-1", teams: [TEAM_A] });
    });
    await waitFor(() => expect(queue).toHaveLength(2)); // B/C's one trailing read starts now.

    act(() => {
      queue[1]?.resolve({ userId: "user-1", teams: [] }); // the trailing read's own, fresh answer: removed.
    });
    await Promise.all([returnedPromise(spy, 1), returnedPromise(spy, 2)]);
    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledTimes(1));
    expect(queue).toHaveLength(2); // exactly 2 real reads for 3 signals.
  });

  it("a signal landing while the trailing read is itself running starts its own next trailing read", async () => {
    const queryClient = new QueryClient();
    renderProvider(queryClient);
    pushAccountWideFrame(realStream, "token-1");

    pushAccountWideFrame(realStream, "token-2"); // A
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queue).toHaveLength(1));
    pushAccountWideFrame(realStream, "token-3"); // B: queued trailing behind A.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(queue).toHaveLength(1); // A still unresolved, so B cannot have started a read yet.

    act(() => {
      queue[0]?.resolve({ userId: "user-1", teams: [TEAM_A] }); // A settles; B's own read starts.
    });
    await waitFor(() => expect(queue).toHaveLength(2));

    // D lands while B's own read is running, not merely queued - it must not
    // coalesce into B; it starts its own third read once B settles.
    pushAccountWideFrame(realStream, "token-4");
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    expect(queue).toHaveLength(2); // B's own read is still unresolved.

    act(() => {
      queue[1]?.resolve({ userId: "user-1", teams: [TEAM_A] }); // B settles; D's trailing read starts.
    });
    await waitFor(() => expect(queue).toHaveLength(3));

    act(() => {
      queue[2]?.resolve({ userId: "user-1", teams: [] }); // D's own fresh answer.
    });
    await returnedPromise(spy, 2);
    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledTimes(1));
  });

  it("a signal arriving while another caller's read is already in flight still gets its own fresh read afterwards", async () => {
    const queryClient = new QueryClient();
    renderProvider(queryClient);
    pushAccountWideFrame(realStream, "token-1");

    // A caller outside the organization provider - the Settings surface's
    // own identity read - has a read in flight when the signal arrives.
    const externalRead = realAuthService.revalidateCurrentContext();
    await waitFor(() => expect(queue).toHaveLength(1));
    expect(spy).not.toHaveBeenCalled(); // this read did not go through the provider's method at all.

    pushAccountWideFrame(realStream, "token-2");
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(queue).toHaveLength(1); // the signal's own read has not started yet - the external read is still out.

    act(() => {
      queue[0]?.resolve({ userId: "user-1", teams: [TEAM_A] }); // the external read's pre-removal snapshot.
    });
    await externalRead;
    await waitFor(() => expect(queue).toHaveLength(2)); // the signal's own, fresh read.

    act(() => {
      queue[1]?.resolve({ userId: "user-1", teams: [] }); // the signal's own read actually sees the removal.
    });
    await returnedPromise(spy, 0);
    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledTimes(1));
  });

  it("never applies a trailing read for an account that signed out before that read could start", async () => {
    const queryClient = new QueryClient();
    renderProvider(queryClient);
    pushAccountWideFrame(realStream, "token-1");

    pushAccountWideFrame(realStream, "token-2"); // A: fires immediately.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queue).toHaveLength(1));
    pushAccountWideFrame(realStream, "token-3"); // B: queued trailing behind A, for this account.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const bPromise = returnedPromise(spy, 1);

    await act(async () => {
      await realAuthService.signOut();
    });
    act(() => {
      queue[0]?.resolve({ userId: "user-1", teams: [] }); // A settles after the account is gone.
    });
    // B's own async body resolves fully once its fence check runs - whether
    // it starts a read or not - so awaiting B's own returned promise is the
    // real completion signal, not a guessed number of ticks.
    await bPromise;

    expect(queue).toHaveLength(1); // B never started a second read.
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe("signed-out");
  });

  it("a stream reconnect - a fresh stream object carrying a changed token - still drives a fresh real read, never treated as a first load", async () => {
    const queryClient = new QueryClient();
    const rendered = renderProvider(queryClient);
    pushAccountWideFrame(realStream, "token-1"); // baseline over the original stream.
    expect(spy).not.toHaveBeenCalled();

    // The stream reconnects: a new WS session, same provider instance. The
    // baseline the provider holds (`identityScope.current`) is a ref keyed
    // only on host/account scope, so it survives this rerender untouched.
    const reconnected = capturedOrganizationStream();
    mocks.stream.current = reconnected;
    rerenderProvider(rendered, queryClient);

    pushAccountWideFrame(reconnected, "token-2"); // the reconnected stream's own first frame, a real change from the baseline.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queue).toHaveLength(1));

    act(() => {
      queue[0]?.resolve({ userId: "user-1", teams: [] });
    });
    await returnedPromise(spy, 0);
    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledTimes(1));
  });

  it("a different account signing in while a trailing read is queued keeps that account's own profile; the superseded account's queued read never applies", async () => {
    const queryClient = new QueryClient();
    renderProvider(queryClient);
    pushAccountWideFrame(realStream, "token-1");

    pushAccountWideFrame(realStream, "token-2"); // A: user-1's own change.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queue).toHaveLength(1));

    pushAccountWideFrame(realStream, "token-3"); // B: queued trailing, still user-1's scope.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(queue).toHaveLength(1); // A still unresolved.
    const bPromise = returnedPromise(spy, 1);

    // Account B replaces account A's session while A's read is still out.
    // `signIn()` bumps the identity generation the instant it is called,
    // before the new device flow even completes, fencing both A's and B's
    // in-flight reads to the identity each was raised under.
    const newAccountSignedIn = deviceSignIn(realAuthService, realHost, {
      token: "live-token-2",
    });
    await waitFor(() => expect(queue).toHaveLength(2)); // user-2's own sign-in validation.
    act(() => {
      queue[1]?.resolve({
        userId: "user-2",
        teams: [{ id: "team-b", slug: "team-b-slug" }],
      });
    });
    await newAccountSignedIn;

    // Only now does A's long-pending read for the OLD account settle.
    act(() => {
      queue[0]?.resolve({ userId: "user-1", teams: [] });
    });
    await bPromise;

    expect(queue).toHaveLength(2); // B never started a third read for the superseded account.
    expect(useAuthStore.getState().contextMetadata?.userId).toBe("user-2");
    expect(useAuthStore.getState().shareableTeams).toEqual([
      { teamId: "team-b", slug: "team-b-slug", avatarUrl: null },
    ]);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });
});
