import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  AUTH_FETCH_MAX_ATTEMPTS,
  authRetryDelayMs,
} from "@traycer-clients/shared/auth/auth-validation";
import { authenticatedUserResponseRecordV100 } from "@traycer/protocol/auth/registry";
import type {
  AuthenticatedUser,
  SubscriptionStatus,
} from "@traycer/protocol/auth";
import { AuthService, AUTH_ERROR_LAUNCH_FAILED } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

// Mirrors `provisional-session-snapshot.ts`'s module-private key. Not exported
// there on purpose (nothing but `AuthService` should address the slot), so the
// literal is duplicated here rather than imported.
const SNAPSHOT_KEY = "traycer.auth.provisionalSession.v1";

type FetchHandler = (
  input: unknown,
  init:
    | {
        readonly method?: string;
        readonly headers?: Record<string, string>;
        readonly body?: BodyInit | null;
      }
    | undefined,
) => Promise<Response>;

interface DeferredResponse {
  readonly promise: Promise<Response>;
  resolve(response: Response): void;
}

const trackedServices: AuthService[] = [];

function makeService(): { service: AuthService; host: MockRunnerHost } {
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
  const service = new AuthService({ runnerHost: host });
  trackedServices.push(service);
  return { service, host };
}

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

function createDeferredResponse(): DeferredResponse {
  const state: { resolve: (response: Response) => void } = {
    resolve: () => undefined,
  };
  const promise = new Promise<Response>((resolve) => {
    state.resolve = resolve;
  });
  return {
    promise,
    resolve: (response) => {
      state.resolve(response);
    },
  };
}

function status(code: number): Promise<Response> {
  return Promise.resolve(new Response(null, { status: code }));
}

/** A real macrotask flush - the only thing that can wait out a fire-and-forget background settle. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function signInStoredCredentials(
  host: MockRunnerHost,
  userId: string,
  token: string,
): Promise<void> {
  await host.tokenStore.signIn(
    { token, refreshToken: `${token}-refresh` },
    { id: userId, email: `${userId}@example.com`, name: "Test User" },
  );
}

/** The exact `/api/v3/user` payload shape `okWithProfile()` uses in the sibling suite, parameterized. */
function authenticatedUserRawPayload(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
): unknown {
  return {
    user: {
      id: userId,
      name: `${userId} display`,
      providerId: `gh-${userId}`,
      providerHandle: userId,
      providerType: "GITHUB",
      email: `${userId}@example.com`,
      avatarUrl: null,
      activatedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
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
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus,
      hasPaymentMethod: false,
      isInTrial: false,
      rechargeRateSeconds: 0,
    },
    teamSubscriptions: [],
    payAsYouGoUsage: { allowPayAsYouGo: false },
  };
}

/** The protocol-parsed value, for seeding a snapshot with a genuine `AuthenticatedUser`. */
function authenticatedUser(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
): AuthenticatedUser {
  return authenticatedUserResponseRecordV100.schema.parse(
    authenticatedUserRawPayload(userId, subscriptionStatus),
  );
}

function okWithUser(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify(authenticatedUserRawPayload(userId, subscriptionStatus)),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
}

interface SnapshotEnvelope {
  readonly schemaVersion: { readonly major: number; readonly minor: number };
  readonly userId: string;
  readonly user: unknown;
}

function seedSnapshot(host: MockRunnerHost, envelope: SnapshotEnvelope): void {
  host.secureStorageEntries.set(SNAPSHOT_KEY, JSON.stringify(envelope));
}

function validSnapshotEnvelope(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
): SnapshotEnvelope {
  return {
    schemaVersion: authenticatedUserResponseRecordV100.schemaVersion,
    userId,
    user: authenticatedUser(userId, subscriptionStatus),
  };
}

/**
 * A local variant of {@link authenticatedUserRawPayload} that parameterizes
 * `user.name`, for A5/A6 below - the same-user re-projection pins. A separate
 * function rather than a new parameter on the shared helper, so every
 * existing call site of `authenticatedUserRawPayload` / `authenticatedUser` /
 * `okWithUser` keeps working unchanged.
 */
function authenticatedUserRawPayloadWithName(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
  name: string,
): unknown {
  return {
    user: {
      id: userId,
      name,
      providerId: `gh-${userId}`,
      providerHandle: userId,
      providerType: "GITHUB",
      email: `${userId}@example.com`,
      avatarUrl: null,
      activatedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
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
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus,
      hasPaymentMethod: false,
      isInTrial: false,
      rechargeRateSeconds: 0,
    },
    teamSubscriptions: [],
    payAsYouGoUsage: { allowPayAsYouGo: false },
  };
}

function authenticatedUserWithName(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
  name: string,
): AuthenticatedUser {
  return authenticatedUserResponseRecordV100.schema.parse(
    authenticatedUserRawPayloadWithName(userId, subscriptionStatus, name),
  );
}

function okWithUserNamed(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
  name: string,
): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify(
        authenticatedUserRawPayloadWithName(userId, subscriptionStatus, name),
      ),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
}

function validSnapshotEnvelopeWithName(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
  name: string,
): SnapshotEnvelope {
  return {
    schemaVersion: authenticatedUserResponseRecordV100.schemaVersion,
    userId,
    user: authenticatedUserWithName(userId, subscriptionStatus, name),
  };
}

interface RawTeam {
  readonly id: string;
  readonly slug: string;
}

/**
 * A local variant of {@link authenticatedUserRawPayload} that parameterizes
 * `teamSubscriptions`, for C.8 - the reorder-vs-change pin on
 * `reprojectSameUserIdentity`'s teams comparison.
 */
function authenticatedUserRawPayloadWithTeams(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
  teams: readonly RawTeam[],
): unknown {
  return {
    user: {
      id: userId,
      name: `${userId} display`,
      providerId: `gh-${userId}`,
      providerHandle: userId,
      providerType: "GITHUB",
      email: `${userId}@example.com`,
      avatarUrl: null,
      activatedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
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
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus,
      hasPaymentMethod: false,
      isInTrial: false,
      rechargeRateSeconds: 0,
    },
    teamSubscriptions: teams.map((team) => ({
      id: `sub-team-${team.id}`,
      userID: null,
      orgID: null,
      teamID: team.id,
      customerId: `cus-team-${team.id}`,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus,
      hasPaymentMethod: false,
      isInTrial: false,
      rechargeRateSeconds: 0,
      totalPlanCredits: 0,
      hasActiveBundle: false,
      bundleSummary: { bundleTotal: 0, bundleConsumed: 0, bundleRemaining: 0 },
      team: {
        id: team.id,
        slug: team.slug,
        avatarUrl: null,
        privacyMode: false,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    })),
    payAsYouGoUsage: { allowPayAsYouGo: false },
  };
}

function authenticatedUserWithTeams(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
  teams: readonly RawTeam[],
): AuthenticatedUser {
  return authenticatedUserResponseRecordV100.schema.parse(
    authenticatedUserRawPayloadWithTeams(userId, subscriptionStatus, teams),
  );
}

function okWithUserTeams(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
  teams: readonly RawTeam[],
): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify(
        authenticatedUserRawPayloadWithTeams(userId, subscriptionStatus, teams),
      ),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
}

function validSnapshotEnvelopeWithTeams(
  userId: string,
  subscriptionStatus: SubscriptionStatus,
  teams: readonly RawTeam[],
): SnapshotEnvelope {
  return {
    schemaVersion: authenticatedUserResponseRecordV100.schemaVersion,
    userId,
    user: authenticatedUserWithTeams(userId, subscriptionStatus, teams),
  };
}

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A real JWS-shaped token whose payload decodes to an `exp` already in the past. */
function expiredJwt(): string {
  const pastSeconds = Math.trunc(Date.now() / 1000) - 3600;
  return `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ exp: pastSeconds })}.signature`;
}

describe("AuthService provisional boot session", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch(() => okWithUser("user-1", "FREE"));
  });

  afterEach(() => {
    while (trackedServices.length > 0) {
      const service = trackedServices.pop();
      if (service !== undefined) {
        service.dispose();
      }
    }
    useAuthStore.getState().setSignedOut();
    vi.useRealTimers();
    restoreFetch();
  });

  describe("A - the fast path exists", () => {
    it("A1: start() resolves signed-in from the snapshot before /api/v3/user ever answers", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, validSnapshotEnvelope("user-1", "FREE"));
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      const startPromise = service.start();
      await flush();
      expect(useAuthStore.getState().status).toBe("signed-in");
      await expect(startPromise).resolves.toBeUndefined();

      deferred.resolve(await okWithUser("user-1", "FREE"));
    });

    it("A2: entitlement stays null through the provisional apply, then commits the verdict's tier", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, validSnapshotEnvelope("user-1", "FREE"));
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      await service.start();
      // Not "FREE" - the stale cached tier must never be read as the answer.
      expect(service.currentSubscriptionStatus()).toBeNull();

      deferred.resolve(await okWithUser("user-1", "PRO"));
      await flush();
      expect(service.currentSubscriptionStatus()).toBe("PRO");
    });

    it("A3: the provisional apply announces once, and a same-user valid verdict adds no further announcement", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, validSnapshotEnvelope("user-1", "FREE"));
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      let emissions = 0;
      service.onSessionSnapshotChange(() => {
        emissions += 1;
      });
      // Subscribing fires once synchronously.
      expect(emissions).toBe(1);

      await service.start();
      // The provisional apply's own projection.
      expect(emissions).toBe(2);

      deferred.resolve(await okWithUser("user-1", "PRO"));
      await flush();
      expect(emissions).toBe(2);
    });

    it("A4: a valid verdict naming a different user id re-signs-in as that identity, with a further announcement", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, validSnapshotEnvelope("user-1", "FREE"));
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      let emissions = 0;
      service.onSessionSnapshotChange(() => {
        emissions += 1;
      });
      await service.start();
      expect(emissions).toBe(2);

      deferred.resolve(await okWithUser("user-2", "PRO"));
      await flush();

      expect(useAuthStore.getState().contextMetadata?.userId).toBe("user-2");
      expect(service.currentSubscriptionStatus()).toBe("PRO");
      expect(emissions).toBe(3);
    });

    it("A5: a same-user valid verdict re-projects a profile that changed since the cached snapshot", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(
        host,
        validSnapshotEnvelopeWithName("user-1", "FREE", "Old Name"),
      );
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      await service.start();
      // The provisional paint shows the CACHED (snapshot) name.
      expect(useAuthStore.getState().profile?.userName).toBe("Old Name");

      deferred.resolve(await okWithUserNamed("user-1", "FREE", "New Name"));
      await flush();

      // THE REDDENING ONE - today the same-user `valid` branch only commits
      // the subscription and re-writes the snapshot; it never re-projects
      // profile/context metadata/teams, so this stays "Old Name".
      expect(useAuthStore.getState().profile?.userName).toBe("New Name");
    });

    it("A6: an identical same-user verdict leaves the store object untouched", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(
        host,
        validSnapshotEnvelopeWithName("user-1", "FREE", "Stable Name"),
      );
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      await service.start();
      const before = useAuthStore.getState().profile;
      const teamsBefore = useAuthStore.getState().shareableTeams;

      // Same user, same name, same subscription tier - nothing differs from
      // what the provisional paint already committed.
      deferred.resolve(await okWithUserNamed("user-1", "FREE", "Stable Name"));
      await flush();

      // `setSignedIn` always builds a fresh `safeProfile` object, so object
      // identity is the in-band observable for "the reducer did not run" -
      // no spy needed.
      expect(useAuthStore.getState().profile).toBe(before);
      expect(useAuthStore.getState().shareableTeams).toBe(teamsBefore);
    });

    // C.8 - `reprojectSameUserIdentity`'s `unchanged` check (auth-service.ts
    // :3820-3828) compares `shareableTeams` INDEX-BY-INDEX, and
    // `projectShareableTeams` preserves server order verbatim - so the same
    // team set returned in a different order reads as "changed" and fires a
    // spurious re-projection (and, in production, `Analytics.identify`).
    it("A7: THE REDDENING ONE - same teams in a different order is treated as unchanged", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(
        host,
        validSnapshotEnvelopeWithTeams("user-1", "FREE", [
          { id: "team-a", slug: "alpha" },
          { id: "team-b", slug: "beta" },
        ]),
      );
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      await service.start();
      const profileBefore = useAuthStore.getState().profile;
      const teamsBefore = useAuthStore.getState().shareableTeams;
      expect(teamsBefore.map((team) => team.teamId)).toEqual([
        "team-a",
        "team-b",
      ]);

      // Same two teams, reversed order, everything else identical.
      deferred.resolve(
        await okWithUserTeams("user-1", "FREE", [
          { id: "team-b", slug: "beta" },
          { id: "team-a", slug: "alpha" },
        ]),
      );
      await flush();

      // Red today - the index compare finds index 0 and 1 both changed and
      // calls `setSignedIn`, replacing both objects even though the set is
      // identical.
      expect(useAuthStore.getState().shareableTeams).toBe(teamsBefore);
      expect(useAuthStore.getState().profile).toBe(profileBefore);
    });

    it("A8: CONTROL - a genuinely different team set (one added) is still treated as changed", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(
        host,
        validSnapshotEnvelopeWithTeams("user-1", "FREE", [
          { id: "team-a", slug: "alpha" },
          { id: "team-b", slug: "beta" },
        ]),
      );
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      await service.start();
      const teamsBefore = useAuthStore.getState().shareableTeams;

      // The same two teams, PLUS a third - a real change, not a reorder.
      deferred.resolve(
        await okWithUserTeams("user-1", "FREE", [
          { id: "team-a", slug: "alpha" },
          { id: "team-b", slug: "beta" },
          { id: "team-c", slug: "charlie" },
        ]),
      );
      await flush();

      // Green both sides - without this, deleting the teams comparison
      // outright would also make pin A7 pass.
      expect(useAuthStore.getState().shareableTeams).not.toBe(teamsBefore);
      expect(
        useAuthStore.getState().shareableTeams.map((team) => team.teamId),
      ).toEqual(["team-a", "team-b", "team-c"]);
    });
  });

  describe("B - refusal classes fall through to the awaited path", () => {
    async function assertRefusesToTheAwaitedPath(
      service: AuthService,
    ): Promise<void> {
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      const startPromise = service.start();
      await flush();
      expect(useAuthStore.getState().status).toBe("signed-out");

      deferred.resolve(await okWithUser("user-1", "FREE"));
      await startPromise;
      expect(useAuthStore.getState().status).toBe("signed-in");
    }

    it("B5: no snapshot key at all", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      // No snapshot seeded.
      await assertRefusesToTheAwaitedPath(service);
    });

    it("B6: secureStorage.get rejects", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, validSnapshotEnvelope("user-1", "FREE"));
      host.secureStorage.get = () =>
        Promise.reject(new Error("secure storage unavailable"));
      await assertRefusesToTheAwaitedPath(service);
    });

    it("B7: the stored value is not JSON", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      host.secureStorageEntries.set(SNAPSHOT_KEY, "not-json{");
      await assertRefusesToTheAwaitedPath(service);
    });

    it("B8: the envelope is malformed", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      host.secureStorageEntries.set(SNAPSHOT_KEY, JSON.stringify({ nope: 1 }));
      await assertRefusesToTheAwaitedPath(service);
    });

    it("B9: the schemaVersion does not match the current protocol record", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, {
        schemaVersion: { major: 0, minor: 9 },
        userId: "user-1",
        user: authenticatedUser("user-1", "FREE"),
      });
      await assertRefusesToTheAwaitedPath(service);
    });

    it("B10: the envelope's userId names a different account than the credentials file", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, {
        schemaVersion: authenticatedUserResponseRecordV100.schemaVersion,
        userId: "someone-else",
        user: authenticatedUser("someone-else", "FREE"),
      });
      await assertRefusesToTheAwaitedPath(service);
    });

    // Two guards can refuse a mismatched account, and BOTH compare against the
    // credentials file's id rather than against each other: the envelope's
    // `userId`, and - after the payload is parsed - the payload's own
    // `user.id`. B10 above names "someone-else" in both, so it trips both at
    // once and can isolate neither; removing either guard leaves the other to
    // refuse (verified - ablating the envelope check alone reddens nothing).
    //
    // So each fixture below must make exactly one of the two DISAGREE with the
    // credentials while the other AGREES.

    it("B10a: only the envelope check can refuse - the envelope names another account while its payload agrees with the credentials file", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, {
        schemaVersion: authenticatedUserResponseRecordV100.schemaVersion,
        userId: "user-2",
        // Agrees with the credentials file, so the post-parse id check cannot
        // fire and the envelope check is the only guard left.
        user: authenticatedUser("user-1", "FREE"),
      });
      await assertRefusesToTheAwaitedPath(service);
    });

    it("B10b: only the post-parse payload check can refuse - the envelope agrees with the credentials file, its payload does not", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, {
        schemaVersion: authenticatedUserResponseRecordV100.schemaVersion,
        userId: "user-1",
        user: authenticatedUser("user-2", "FREE"),
      });
      await assertRefusesToTheAwaitedPath(service);
    });

    it("B11: the payload fails the protocol schema", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, {
        schemaVersion: authenticatedUserResponseRecordV100.schemaVersion,
        userId: "user-1",
        user: {},
      });
      await assertRefusesToTheAwaitedPath(service);
    });

    it("B12: the access token is a real JWT whose exp is already in the past", async () => {
      const { service, host } = makeService();
      const token = expiredJwt();
      await host.tokenStore.signIn(
        { token, refreshToken: `${token}-refresh` },
        { id: "user-1", email: "user-1@example.com", name: "Test User" },
      );
      seedSnapshot(host, validSnapshotEnvelope("user-1", "FREE"));
      await assertRefusesToTheAwaitedPath(service);
    });
  });

  describe("C - what happens after the verdict", () => {
    it("C13: a network-error verdict leaves the provisional session live with entitlement unknown, and a later successful revalidation commits it without a second announcement", async () => {
      vi.useFakeTimers();
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, validSnapshotEnvelope("user-1", "FREE"));
      restoreFetch();
      restoreFetch = installFetch(() => status(500));

      let emissions = 0;
      service.onSessionSnapshotChange(() => {
        emissions += 1;
      });
      await service.start();
      expect(emissions).toBe(2);
      expect(useAuthStore.getState().status).toBe("signed-in");

      // Exhaust the bounded retry so the background settle actually reaches a
      // network-error verdict rather than stalling mid-backoff.
      for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
        await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(service.currentSubscriptionStatus()).toBeNull();
      expect(emissions).toBe(2);

      restoreFetch();
      restoreFetch = installFetch(() => okWithUser("user-1", "PRO"));
      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("valid");
      expect(service.currentSubscriptionStatus()).toBe("PRO");
      // Same-user valid revalidation commits entitlement only - no re-sign-in,
      // so no further announcement.
      expect(emissions).toBe(2);
    });

    it("C14: a rejected verdict clears the session BEFORE rotating, so a transient rotate outcome still ends signed-out rather than stranding a dead session", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, validSnapshotEnvelope("user-1", "FREE"));
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      await service.start();
      expect(useAuthStore.getState().status).toBe("signed-in");

      host.tokenStore.rotate = () =>
        Promise.resolve({ outcome: "lock-busy" as const, pair: null });
      deferred.resolve(await status(401));
      await flush();

      expect(useAuthStore.getState().status).toBe("signed-out");
    });

    // Pins: a background settle straggling from an aborted provisional boot
    // cannot disturb the state an interactive sign-in FAILURE already
    // established (no rotate call, `AUTH_ERROR_LAUNCH_FAILED` stays put).
    //
    // What carries it: `signIn()` bumps `identityGeneration` as its very first
    // statement, before it can even reach the launch failure, and
    // `applyInteractiveFailure` -> `applySignedOut()` nulls the live bearer.
    // Either fence alone already makes `settleProvisionalSession`'s entry
    // checks (`shouldStopStartFlow`'s generation compare, and separately
    // `currentBearerIs(stored.token)`) refuse the stale verdict - three
    // independent guards catch this one stimulus.
    //
    // What this does NOT pin: `start()`'s own `settlesInBackground` guard
    // (`if (!settlesInBackground) { this.starting = false; }` in the
    // `finally`). Reverting it to an unconditional `this.starting = false`
    // leaves this test green - none of the three guards above depend on
    // `starting`/`authResolvedDuringStart` for this particular recipe. That
    // guard is defence-in-depth for what `authResolvedDuringStart` is
    // documented to mean elsewhere, not something this recipe can isolate:
    // doing so would need the device flow to land the exact bearer already on
    // disk, which is contrived enough to be pinning the fixture rather than
    // the behaviour. Do not read this test as covering that guard.
    it("C15: an interactive sign-in that fails at launch fences off the background settle, so a later rejected verdict does not further disturb the launch-failure state", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(host, validSnapshotEnvelope("user-1", "FREE"));
      const deferred = createDeferredResponse();
      restoreFetch();
      restoreFetch = installFetch(() => deferred.promise);

      let rotateCalls = 0;
      const originalRotate = host.tokenStore.rotate.bind(host.tokenStore);
      host.tokenStore.rotate = (args) => {
        rotateCalls += 1;
        return originalRotate(args);
      };

      await service.start();
      expect(useAuthStore.getState().status).toBe("signed-in");

      vi.spyOn(host.deviceFlow, "start").mockRejectedValue(
        new Error("launch failed"),
      );
      await service.signIn();
      expect(service.getLastError()).toBe(AUTH_ERROR_LAUNCH_FAILED);

      deferred.resolve(await status(401));
      await flush();

      expect(rotateCalls).toBe(0);
      expect(service.getLastError()).toBe(AUTH_ERROR_LAUNCH_FAILED);
    });

    // C.7 - `revalidateCurrentContextOnce`'s same-user `valid` arm (auth-service.ts
    // :2303-2316) is the exact predicate A5/A6 pin at BOOT, unapplied at the
    // mid-session revalidation this reactive 401 path drives. It commits
    // subscription status only and never calls `reprojectSameUserIdentity`.
    it("C16: a mid-session same-user valid verdict re-projects a profile that changed since the last projection", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(
        host,
        validSnapshotEnvelopeWithName("user-1", "FREE", "Old Name"),
      );
      restoreFetch();
      restoreFetch = installFetch(() =>
        okWithUserNamed("user-1", "FREE", "Old Name"),
      );

      await service.start();
      expect(useAuthStore.getState().profile?.userName).toBe("Old Name");

      restoreFetch();
      restoreFetch = installFetch(() =>
        okWithUserNamed("user-1", "FREE", "New Name"),
      );
      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("valid");

      // THE REDDENING ONE - today this arm only commits the subscription
      // status, so this stays "Old Name" instead of picking up the changed
      // display name.
      expect(useAuthStore.getState().profile?.userName).toBe("New Name");
    });

    it("C19: the re-projection also moves the SERVICE's own profile copy, not just the store's", async () => {
      // C16 pins the store; this pins the other half of the same write. The
      // service keeps `currentProfile` beside `currentBearer` as one live
      // credential pair, and `getCurrentSessionSnapshot()` - the persistence
      // boundary the windows bridge projects to every other window - reads the
      // profile from THERE, not from the store. Left behind, it is also
      // self-perpetuating: the rotation path re-commits `this.currentProfile`
      // verbatim, so every later refresh re-writes the stale name.
      //
      // Asserted through the snapshot rather than the store for the reason C18
      // gives about its own read: the store says "New Name" under the bug, so
      // an assertion there is green either way.
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(
        host,
        validSnapshotEnvelopeWithName("user-1", "FREE", "Old Name"),
      );
      restoreFetch();
      restoreFetch = installFetch(() =>
        okWithUserNamed("user-1", "FREE", "Old Name"),
      );

      await service.start();
      expect(service.getCurrentSessionSnapshot().profile?.userName).toBe(
        "Old Name",
      );
      const tokenBefore = service.getCurrentSessionSnapshot().token;

      restoreFetch();
      restoreFetch = installFetch(() =>
        okWithUserNamed("user-1", "FREE", "New Name"),
      );
      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("valid");

      const snapshot = service.getCurrentSessionSnapshot();
      expect(snapshot.profile?.userName).toBe("New Name");
      // The pair is written TOGETHER: re-projecting an identity must not
      // disturb the bearer, which this path never mints.
      expect(snapshot.token).toBe(tokenBefore);
    });

    it("C20: the re-projection reaches session-snapshot subscribers, so other windows do not keep the old identity", async () => {
      // The pushed half of C19. The windows bridge holds a copy delivered
      // through `onSessionSnapshotChange`, so a fix that repaired only the
      // pull-side read would leave every other window painting the old name
      // until something unrelated emitted.
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(
        host,
        validSnapshotEnvelopeWithName("user-1", "FREE", "Old Name"),
      );
      restoreFetch();
      restoreFetch = installFetch(() =>
        okWithUserNamed("user-1", "FREE", "Old Name"),
      );

      await service.start();

      const names: Array<string | undefined> = [];
      service.onSessionSnapshotChange((snapshot) => {
        names.push(snapshot.profile?.userName);
      });
      // The subscribe itself fires synchronously with the current value, so
      // drop that one and watch only what the re-projection pushes.
      names.length = 0;

      restoreFetch();
      restoreFetch = installFetch(() =>
        okWithUserNamed("user-1", "FREE", "New Name"),
      );
      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("valid");

      expect(names).toContain("New Name");
    });

    it("C18: a mid-session same-user re-projection also PERSISTS, so the next launch does not repaint the old identity", async () => {
      // C16 pins the projection; this pins the durable half, and the store
      // write alone is not it. `applySignedIn` is the only other writer of
      // this snapshot and this path deliberately avoids it, so on this branch
      // nothing else persists anything: the next launch paints the cached
      // identity again, and if that launch's validation takes the accepted
      // network-error path (C13) the stale name and avatar stand for the whole
      // session. `settleProvisionalSession` pairs the projection and the write
      // for exactly this reason; the live-revalidation path had only the first
      // half.
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(
        host,
        validSnapshotEnvelopeWithName("user-1", "FREE", "Old Name"),
      );
      restoreFetch();
      restoreFetch = installFetch(() =>
        okWithUserNamed("user-1", "FREE", "Old Name"),
      );

      await service.start();
      await flush();

      restoreFetch();
      restoreFetch = installFetch(() =>
        okWithUserNamed("user-1", "FREE", "New Name"),
      );
      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("valid");
      // The write is fire-and-forget, like its sibling in D16.
      await flush();

      const raw = host.secureStorageEntries.get(SNAPSHOT_KEY);
      if (raw === undefined) {
        throw new Error("expected a provisional snapshot to have been written");
      }
      const decoded: unknown = JSON.parse(raw);
      // Read through the SNAPSHOT rather than the store: the store already
      // says "New Name" under the bug (C16 made sure of that), so asserting
      // there would be green either way. The persisted name is the only thing
      // the next launch reads.
      const envelope = z
        .object({
          userId: z.string(),
          user: z.object({ user: z.object({ name: z.string().nullable() }) }),
        })
        .parse(decoded);
      expect(envelope.userId).toBe("user-1");
      expect(envelope.user.user.name).toBe("New Name"); // red today: "Old Name"
    });

    it("C17: an identical mid-session same-user verdict leaves the store's profile object untouched", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      seedSnapshot(
        host,
        validSnapshotEnvelopeWithName("user-1", "FREE", "Stable Name"),
      );
      restoreFetch();
      restoreFetch = installFetch(() =>
        okWithUserNamed("user-1", "FREE", "Stable Name"),
      );

      await service.start();
      const before = useAuthStore.getState().profile;

      const outcome = await service.revalidateCurrentContext();
      expect(outcome?.kind).toBe("valid");

      // CONTROL, green both sides - what stops pin C16 being satisfied by an
      // unconditional write, which would fire one `Analytics.identify` per
      // revalidation instead of only when identity actually moved.
      expect(useAuthStore.getState().profile).toBe(before);
    });
  });

  describe("D - snapshot lifecycle", () => {
    it("D16: a normal successful boot writes the snapshot, keyed to the signed-in user", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      restoreFetch();
      restoreFetch = installFetch(() => okWithUser("user-1", "PRO"));

      await service.start();
      expect(useAuthStore.getState().status).toBe("signed-in");
      await flush();

      const raw = host.secureStorageEntries.get(SNAPSHOT_KEY);
      if (raw === undefined) {
        throw new Error("expected a provisional snapshot to have been written");
      }
      const decoded: unknown = JSON.parse(raw);
      const envelope = z.object({ userId: z.string() }).parse(decoded);
      expect(envelope.userId).toBe("user-1");
    });

    it("D17: signOut() deletes the snapshot", async () => {
      const { service, host } = makeService();
      await signInStoredCredentials(host, "user-1", "persisted-token");
      restoreFetch();
      restoreFetch = installFetch(() => okWithUser("user-1", "PRO"));

      await service.start();
      await flush();
      expect(host.secureStorageEntries.has(SNAPSHOT_KEY)).toBe(true);

      await service.signOut();
      expect(host.secureStorageEntries.has(SNAPSHOT_KEY)).toBe(false);
    });
  });
});
