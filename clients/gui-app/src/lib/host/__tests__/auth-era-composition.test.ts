/**
 * The auth-era composition, asserted at the TRANSPORT boundary.
 *
 * Everything here is production wiring: a real `AuthService`, the real
 * `createAuthBoundHostDirectory` (so the accessors and the default fetcher are
 * the ones the provider installs), and a real `HostRuntime` subscribing to the
 * real `RequestContextProvider`. The only seams are the shell (`MockRunnerHost`
 * calls the shared HTTP helpers directly) and `fetch` itself.
 *
 * WHY it is written this way. Four consecutive rounds of fixes to these two
 * defects shipped green, because each round's tests supplied the very thing
 * under question: a fake directory that modelled the lagging identity but not
 * the lagging bearer, and a fence driven by a counter the test incremented by
 * hand. Every assertion below is therefore on the `Authorization` header that
 * reached `fetch` — the credential ACTUALLY USED — and on the production
 * generation accessor moving across a real rotation. A stamp can be right
 * while the request underneath it is wrong; that is precisely the bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { QueryClient } from "@tanstack/react-query";
import { AuthService } from "@/lib/auth/auth-service";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import type { HostDirectoryService } from "@/lib/host/host-directory-service";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useAuthStore } from "@/stores/auth/auth-store";

const AUTHN_BASE_URL = "http://localhost:5005";
const VALIDATION_URL = `${AUTHN_BASE_URL}/api/v3/user`;
const HOSTS_URL = `${AUTHN_BASE_URL}/api/v3/hosts`;

const TOKEN_A = "token-a";
const TOKEN_A_ROTATED = "token-a2";
const TOKEN_B = "token-b";

/** Which account each bearer belongs to, as the cloud sees it. */
const ACCOUNT_BY_BEARER = new Map<string, string>([
  [TOKEN_A, "user-a"],
  [TOKEN_A_ROTATED, "user-a"],
  [TOKEN_B, "user-b"],
]);

/** Which host row each account owns, so a leak is visible as a host id. */
const HOST_BY_ACCOUNT = new Map<string, string>([
  ["user-a", "account-a-host"],
  ["user-b", "account-b-host"],
]);

interface FetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: BodyInit | null;
}

type FetchHandler = (
  input: unknown,
  init: FetchInit | undefined,
) => Promise<Response>;

function installFetch(handler: FetchHandler): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: handler,
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function bearerOf(init: FetchInit | undefined): string {
  const authorization = init?.headers?.["Authorization"] ?? "";
  return authorization.replace(/^Bearer /, "");
}

function userResponse(userId: string): Response {
  return new Response(
    JSON.stringify({
      user: {
        id: userId,
        name: `User ${userId}`,
        providerId: `gh-${userId}`,
        providerHandle: userId,
        providerType: "GITHUB",
        email: `${userId}@example.com`,
        avatarUrl: null,
        activatedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: null,
        privacyMode: false,
        isLearningEnabled: true,
      },
      userSubscription: {
        id: `sub-${userId}`,
        userID: userId,
        orgID: null,
        teamID: null,
        customerId: `cus-${userId}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
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
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function hostsResponse(hostId: string): Response {
  return new Response(
    JSON.stringify({
      hosts: [
        {
          hostId,
          displayName: hostId,
          platform: "Ubuntu",
          kind: "personal",
          publicKey: `pk-${hostId}`,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatePolicy: "manual",
          status: {
            connectivity: "connectable",
            viewerReachability: "unknown",
            clientCloud: "ok",
            updateState: "current",
            appVersion: "1.0.0",
            lastSeenAt: "2026-08-01T00:00:00.000Z",
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function requestUrl(input: unknown): string {
  return typeof input === "string" ? input : String(input);
}

/**
 * Records every bearer that reached `GET /api/v3/hosts`, and answers with the
 * hosts of whichever account that bearer belongs to.
 *
 * The mapping is the load-bearing part: a fetcher that returned the same rows
 * for every bearer could not tell "asked as B" apart from "asked as A and
 * stamped B", which is the exact substitution that let this bug through
 * before.
 */
interface HostsEndpoint {
  readonly bearers: string[];
  /** Bearers to hold open instead of answering, plus their resolvers. */
  readonly hold: (bearer: string) => void;
  readonly release: (bearer: string, response: Response) => void;
  /**
   * Bearers the HOSTS endpoint 401s even though they are otherwise valid -
   * the transient mid-rotation refusal (`/api/v3/user` keeps answering, so
   * nothing signs the session out).
   */
  readonly deny: (bearer: string) => void;
  readonly handler: FetchHandler;
}

function hostsEndpoint(): HostsEndpoint {
  const bearers: string[] = [];
  const held = new Set<string>();
  const denied = new Set<string>();
  const pending = new Map<string, (response: Response) => void>();
  return {
    bearers,
    hold: (bearer) => held.add(bearer),
    deny: (bearer) => denied.add(bearer),
    release: (bearer, response) => {
      const resolve = pending.get(bearer);
      pending.delete(bearer);
      held.delete(bearer);
      resolve?.(response);
    },
    handler: (input, init) => {
      const url = requestUrl(input);
      const bearer = bearerOf(init);
      if (url === VALIDATION_URL) {
        const userId = ACCOUNT_BY_BEARER.get(bearer);
        return Promise.resolve(
          userId === undefined
            ? new Response(null, { status: 401 })
            : userResponse(userId),
        );
      }
      if (url === HOSTS_URL) {
        bearers.push(bearer);
        if (held.has(bearer)) {
          return new Promise<Response>((resolve) => {
            pending.set(bearer, resolve);
          });
        }
        if (denied.has(bearer)) {
          return Promise.resolve(new Response(null, { status: 401 }));
        }
        const userId = ACCOUNT_BY_BEARER.get(bearer);
        const hostId =
          userId === undefined ? undefined : HOST_BY_ACCOUNT.get(userId);
        return Promise.resolve(
          hostId === undefined
            ? new Response(null, { status: 401 })
            : hostsResponse(hostId),
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    },
  };
}

interface Composition {
  readonly auth: AuthService;
  readonly directory: HostDirectoryService;
  readonly runtime: HostRuntime<HostRpcRegistry>;
  readonly runnerHost: MockRunnerHost;
}

const built: Composition[] = [];

/**
 * The production composition, minus React. `createAuthBoundHostDirectory` is
 * the same call `HostRuntimeProvider` makes, so the identity accessor, the
 * credential-generation accessor and the default remote fetcher under test
 * here are the ones the app runs.
 */
function buildComposition(): Composition {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: AUTHN_BASE_URL,
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const auth = new AuthService({ runnerHost });
  const directory = createAuthBoundHostDirectory({
    auth,
    runnerHost,
    remoteFetcher: null,
    localHostIdSeeder: () => Promise.resolve(null),
    onRegistryPollTick: null,
  });
  let requestSeq = 0;
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `auth-era-${++requestSeq}`,
      handlers: {},
    }),
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    ),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    connectionRegistry: null,
  });
  const composition = { auth, directory, runtime, runnerHost };
  built.push(composition);
  return composition;
}

/** Signs in as `userId`, then brings the directory and runtime up on it. */
async function startSignedInAs(
  composition: Composition,
  token: string,
  userId: string,
): Promise<void> {
  await composition.runnerHost.tokenStore.signIn(
    { token, refreshToken: `${token}-refresh` },
    { id: userId, email: `${userId}@example.com`, name: `User ${userId}` },
  );
  await composition.auth.start();
  await composition.directory.start();
  composition.runtime.start();
}

async function directoryHostIds(
  directory: HostDirectoryService,
): Promise<string[]> {
  const entries = await directory.list();
  return entries.map((entry) => entry.hostId);
}

/**
 * Bringing the composition up issues its own reads under the signed-in
 * account (the directory's initial refresh, and the local-host subscription
 * firing on subscribe). Those are the OTHER cadence - unrelated to what this
 * suite is about - so every probe takes a mark after startup and asserts on
 * exactly the requests issued after it.
 */
function bearersSince(endpoint: HostsEndpoint, mark: number): string[] {
  return endpoint.bearers.slice(mark);
}

describe("auth-era composition — the credential a refresh actually uses", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  afterEach(() => {
    while (built.length > 0) {
      const composition = built.pop();
      composition?.runtime.dispose();
      composition?.directory.dispose();
      composition?.auth.dispose();
    }
    useAuthStore.getState().setSignedOut();
    restoreFetch();
    restoreFetch = () => undefined;
  });

  it("issues the mandatory A→B refresh with B's bearer, and commits B's hosts", async () => {
    const endpoint = hostsEndpoint();
    restoreFetch = installFetch(endpoint.handler);
    const composition = buildComposition();
    await startSignedInAs(composition, TOKEN_A, "user-a");

    await vi.waitFor(async () => {
      expect(await directoryHostIds(composition.directory)).toEqual([
        "account-a-host",
      ]);
    });
    const mark = endpoint.bearers.length;

    // The user signs into B in the same app lifetime: the shared credentials
    // file changes, the §4 watcher reconciles it, and the cross-user branch
    // runs the full signed-in projection - emitting the new RequestContext,
    // inside which the runtime issues the mandatory refresh.
    await composition.runnerHost.tokenStore.signIn(
      { token: TOKEN_B, refreshToken: `${TOKEN_B}-refresh` },
      { id: "user-b", email: "user-b@example.com", name: "User user-b" },
    );

    await vi.waitFor(async () => {
      expect(await directoryHostIds(composition.directory)).toEqual([
        "account-b-host",
      ]);
    });

    // THE ASSERTION THIS TICKET EXISTS FOR. Not "the refresh was stamped B" -
    // it was, in the version that shipped this bug - but which credential the
    // request carried. B's refresh must go out under B's bearer; issuing it
    // under A's returns A's machine names, ids and platforms, and the identity
    // guard then waves them through because by the time they land the ambient
    // profile really is B.
    expect(bearersSince(endpoint, mark)).toEqual([TOKEN_B]);
  });

  it("signs out without issuing a hosts read at all, so a still-valid old bearer cannot re-commit A's hosts as signed-out", async () => {
    const endpoint = hostsEndpoint();
    restoreFetch = installFetch(endpoint.handler);
    const composition = buildComposition();
    await startSignedInAs(composition, TOKEN_A, "user-a");

    await vi.waitFor(async () => {
      expect(await directoryHostIds(composition.directory)).toEqual([
        "account-a-host",
      ]);
    });
    const mark = endpoint.bearers.length;

    await composition.auth.signOut();

    await vi.waitFor(async () => {
      expect(await directoryHostIds(composition.directory)).toEqual([]);
    });

    // The sign-out variant of the same defect, and the reason it is nastier:
    // A's bearer here is not expired. Had the signed-out refresh gone out
    // under it, the registry would have answered 200 with A's hosts, and a
    // 401 - the thing the whole `signed-out` outcome path is written around -
    // would never have arrived to save it. So the requirement is not "the
    // request failed", it is that no request was made on a signed-out
    // session at all.
    expect(bearersSince(endpoint, mark)).toEqual([]);
  });

  it("advances the wired credential generation across an ordinary same-user rotation", async () => {
    const endpoint = hostsEndpoint();
    restoreFetch = installFetch(endpoint.handler);
    const composition = buildComposition();
    await startSignedInAs(composition, TOKEN_A, "user-a");
    await vi.waitFor(async () => {
      expect(await directoryHostIds(composition.directory)).toEqual([
        "account-a-host",
      ]);
    });

    const identityBefore = composition.auth.getIdentityGeneration();
    const credentialBefore = composition.auth.getCredentialGeneration();

    // A background rotation: same account, new token, adopted through the
    // reconcile path. No sign-in, no sign-out - which is exactly why the
    // identity counter cannot see it.
    await composition.runnerHost.tokenStore.signIn(
      { token: TOKEN_A_ROTATED, refreshToken: `${TOKEN_A_ROTATED}-refresh` },
      { id: "user-a", email: "user-a@example.com", name: "User user-a" },
    );
    await vi.waitFor(() => {
      expect(composition.auth.getCurrentSessionSnapshot().token).toBe(
        TOKEN_A_ROTATED,
      );
    });

    // The production accessor the directory's fence is wired to - not a local
    // counter standing in for it. This is the assertion the previous round's
    // test could not make, and its absence is why an identity-transition
    // counter sat in that slot through a full review.
    expect(composition.auth.getCredentialGeneration()).toBe(
      credentialBefore + 1,
    );
    expect(composition.auth.getIdentityGeneration()).toBe(identityBefore);
  });

  it("does not let a late 401 from the pre-rotation bearer clear the directory the new one filled", async () => {
    const endpoint = hostsEndpoint();
    restoreFetch = installFetch(endpoint.handler);
    const composition = buildComposition();
    await startSignedInAs(composition, TOKEN_A, "user-a");
    await vi.waitFor(async () => {
      expect(await directoryHostIds(composition.directory)).toEqual([
        "account-a-host",
      ]);
    });

    // Drain startup before marking: a refresh still in flight would be JOINED
    // rather than re-issued (that coalescing is deliberate), and this probe
    // needs a request of its own to hold open.
    await composition.directory.refresh();
    const mark = endpoint.bearers.length;

    // A poll goes out under A's current bearer and is held open.
    endpoint.hold(TOKEN_A);
    const heldPoll = composition.directory.refresh();
    await vi.waitFor(() => {
      expect(bearersSince(endpoint, mark)).toEqual([TOKEN_A]);
    });

    // Mid-flight, the token rotates - same user, so nothing about the
    // identity changes and no context is emitted.
    await composition.runnerHost.tokenStore.signIn(
      { token: TOKEN_A_ROTATED, refreshToken: `${TOKEN_A_ROTATED}-refresh` },
      { id: "user-a", email: "user-a@example.com", name: "User user-a" },
    );
    await vi.waitFor(() => {
      expect(composition.auth.getCurrentSessionSnapshot().token).toBe(
        TOKEN_A_ROTATED,
      );
    });

    // The new credential refreshes and legitimately fills the directory. A
    // FRESH request, not a join onto the held one: the era changed, so the
    // memo cannot answer for it.
    await composition.directory.refresh();
    expect(bearersSince(endpoint, mark)).toEqual([TOKEN_A, TOKEN_A_ROTATED]);
    expect(await directoryHostIds(composition.directory)).toEqual([
      "account-a-host",
    ]);

    // NOW the held request comes back 401, as an expired bearer's request
    // does. `unauthorized` becomes a `signed-out` outcome, the user id still
    // matches on both sides, and only the credential generation can tell that
    // this 401 was earned by a token that is no longer in use.
    endpoint.release(TOKEN_A, new Response(null, { status: 401 }));
    await heldPoll;

    expect(await directoryHostIds(composition.directory)).toEqual([
      "account-a-host",
    ]);
  });

  it("retains the directory when the registry 401s a STILL-CURRENT bearer", async () => {
    // This used to also assert the bound remote SELECTION survived the 401
    // (`directory.selectById` / `.getSelected()`). P4.2 deleted selection
    // from `HostDirectoryService` entirely - it now lives in the selection
    // authority store, a subsystem this composition test doesn't construct -
    // so that half of the claim has no post-slot equivalent to migrate to
    // and is dropped. What survives is the directory's own retention
    // contract, already covered below by the `directoryHostIds` assertions.
    const endpoint = hostsEndpoint();
    restoreFetch = installFetch(endpoint.handler);
    const composition = buildComposition();
    await startSignedInAs(composition, TOKEN_A, "user-a");
    await vi.waitFor(async () => {
      expect(await directoryHostIds(composition.directory)).toEqual([
        "account-a-host",
      ]);
    });

    // Drain startup before marking: a refresh still in flight would be
    // JOINED rather than re-issued (that coalescing is deliberate), and this
    // probe needs the DENIED answer to be the one its refresh consumes.
    await composition.directory.refresh();
    const mark = endpoint.bearers.length;

    // The registry rejects the CURRENT bearer - proactive rotation has not
    // landed yet, so no era transition exists for the generation fence to
    // catch: the same credential that filled the directory observes this
    // 401. `AuthService.fetchRegisteredHosts` deliberately does not sign out
    // on it (a background list poll must never force a sign-out), and the
    // directory must be no more destructive than the auth layer: retain the
    // last-known entries, recover on the next poll. Mapping it to
    // `signed-out` cleared every remote entry mid-session on a transient
    // credential blip.
    endpoint.deny(TOKEN_A);
    await composition.directory.refresh();

    // The refusal really went out (and went out under the current bearer) -
    // without this, a refresh that silently joined an older in-flight read
    // would make the retention assertion below pass vacuously.
    expect(bearersSince(endpoint, mark)).toEqual([TOKEN_A]);
    expect(await directoryHostIds(composition.directory)).toEqual([
      "account-a-host",
    ]);
  });
});

/**
 * The reorder trap for the commit-before-emit contract.
 *
 * Separate from the probes above because it fails for a different reason: it
 * does not ask what the refresh did, it asks what any listener would have seen
 * at the instant the transition was announced. If an assignment is ever moved
 * back after its emission, this fails immediately and points at the ordering,
 * rather than surfacing later as a confusing directory-contents mismatch.
 */
describe("auth-era composition — auth state is committed before the transition is announced", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  afterEach(() => {
    while (built.length > 0) {
      const composition = built.pop();
      composition?.runtime.dispose();
      composition?.directory.dispose();
      composition?.auth.dispose();
    }
    useAuthStore.getState().setSignedOut();
    restoreFetch();
    restoreFetch = () => undefined;
  });

  it("reports the INCOMING identity and bearer to a listener reading ambiently during the emission", async () => {
    const endpoint = hostsEndpoint();
    restoreFetch = installFetch(endpoint.handler);
    const composition = buildComposition();
    await startSignedInAs(composition, TOKEN_A, "user-a");

    const observed: Array<{
      readonly emitted: string | null;
      readonly ambientIdentity: string | null;
      readonly ambientToken: string | null;
    }> = [];
    const unsubscribe = composition.auth
      .getRequestContextProvider()
      .onChange((ctx) => {
        // Deliberately the AMBIENT reads, not the era. A listener is allowed
        // to make them - the whole point of committing first is that they are
        // true by the time anyone can look.
        const snapshot = composition.auth.getCurrentSessionSnapshot();
        observed.push({
          emitted: ctx?.identity.userId ?? null,
          ambientIdentity: snapshot.profile?.userId ?? null,
          ambientToken: snapshot.token,
        });
      });

    await composition.runnerHost.tokenStore.signIn(
      { token: TOKEN_B, refreshToken: `${TOKEN_B}-refresh` },
      { id: "user-b", email: "user-b@example.com", name: "User user-b" },
    );
    await vi.waitFor(() => {
      expect(observed).toHaveLength(1);
    });
    await composition.auth.signOut();
    await vi.waitFor(() => {
      expect(observed).toHaveLength(2);
    });
    unsubscribe();

    expect(observed).toEqual([
      {
        emitted: "user-b",
        ambientIdentity: "user-b",
        ambientToken: TOKEN_B,
      },
      { emitted: null, ambientIdentity: null, ambientToken: null },
    ]);
  });
});
