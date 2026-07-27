/**
 * End-to-end §6 legacy→file migration tests, driving the real
 * `FileTokenStore.migrateLegacyCredentials` against a real temp-dir credentials
 * file (real lock/WAL, real access-only probe + refresh helpers). `fetch` is the
 * only faked boundary: `/api/v3/user` answers the identity probe and
 * `/api/v3/auth/refresh` answers the spend, keyed on the request's bearer /
 * refresh token so a single handler drives every branch.
 *
 * Spec: credentials-file token-store tech plan §6.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import {
  readCredentialsFile,
  writeCredentialsFile,
  type StoredCredentials,
} from "@traycer/protocol/config/credentials";

const AUTHN_BASE_URL = "http://authn.credentials-migration.test";
const ENVIRONMENT = "development";
const USER_URL = `${AUTHN_BASE_URL}/api/v3/user`;
const REFRESH_URL = `${AUTHN_BASE_URL}/api/v3/auth/refresh`;

vi.mock("electron", () => ({
  app: {
    getPath: (): string =>
      join(tmpdir(), "traycer-credentials-migration-userdata"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

type FetchInit = {
  readonly method?: string;
  readonly body?: string | null;
  readonly headers?: Record<string, string>;
};
type FetchHandler = (
  input: unknown,
  init: FetchInit | undefined,
) => Promise<Response>;

function installFetch(handler: FetchHandler): () => void {
  const original: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: handler,
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

function bearer(init: FetchInit | undefined): string {
  const auth = init?.headers?.Authorization ?? "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
}

function refreshTokenOf(init: FetchInit | undefined): string {
  const raw = typeof init?.body === "string" ? init.body : "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "refreshToken" in parsed
    ) {
      const rt = (parsed as { refreshToken?: unknown }).refreshToken;
      return typeof rt === "string" ? rt : "";
    }
  } catch {
    return "";
  }
  return "";
}

// A valid `/api/v3/user` body for `userId` (the shape the auth record schema
// parses into an `AuthenticatedUser`).
function userResponse(userId: string): Response {
  return new Response(
    JSON.stringify({
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
        id: "sub-1",
        userID: userId,
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
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

type Verdict = string | "reject" | "network";

// One handler drives every branch: `users` maps an access token to a user id (or
// rejects / errors it); `refresh` maps a refresh token to an outcome. Records the
// refresh tokens actually spent so tests can assert nothing leaked.
function installMigrationFetch(cfg: {
  readonly users: Record<string, Verdict>;
  readonly refresh: Record<string, "ok" | "reject" | "network">;
  readonly spent: string[];
}): () => void {
  return installFetch((input, init) => {
    const url = typeof input === "string" ? input : String(input);
    if (url === USER_URL) {
      const verdict = cfg.users[bearer(init)];
      if (verdict === undefined || verdict === "reject") {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      if (verdict === "network") {
        return Promise.reject(new Error("user probe network error"));
      }
      return Promise.resolve(userResponse(verdict));
    }
    if (url === REFRESH_URL) {
      const rt = refreshTokenOf(init);
      cfg.spent.push(rt);
      const verdict = cfg.refresh[rt];
      if (verdict === "ok") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ token: `${rt}-tok`, refreshToken: `${rt}-ref` }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (verdict === "network") {
        return Promise.reject(new Error("refresh network error"));
      }
      return Promise.resolve(new Response(null, { status: 400 }));
    }
    return Promise.resolve(new Response(null, { status: 500 }));
  });
}

function fileCreds(over: Partial<StoredCredentials>): StoredCredentials {
  return {
    token: "F-access",
    refreshToken: "F-refresh",
    authnBaseUrl: AUTHN_BASE_URL,
    savedAt: "2024-01-01T00:00:00.000Z",
    user: { id: "user-a", email: "a@example.com", name: "A" },
    ...over,
  };
}

describe("FileTokenStore.migrateLegacyCredentials (real fs + lock/WAL)", () => {
  let homeDir: string;
  let previousHome: string | undefined;
  let restoreFetch: () => void = () => undefined;
  let FileTokenStore: typeof import("../file-token-store").FileTokenStore;
  const stores: Array<InstanceType<typeof FileTokenStore>> = [];

  function credentialsPath(): string {
    return cliCredentialsPath(ENVIRONMENT);
  }

  function makeStore(): InstanceType<typeof FileTokenStore> {
    const store = new FileTokenStore({
      environment: ENVIRONMENT,
      authnBaseUrl: AUTHN_BASE_URL,
    });
    stores.push(store);
    return store;
  }

  async function seedFile(over: Partial<StoredCredentials>): Promise<void> {
    await writeCredentialsFile(credentialsPath(), fileCreds(over), 0);
  }

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "traycer-credentials-migration-"));
    previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    vi.resetModules();
    ({ FileTokenStore } = await import("../file-token-store"));
  });

  afterEach(() => {
    for (const store of stores) {
      store.dispose();
    }
    stores.length = 0;
    restoreFetch();
    restoreFetch = () => undefined;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("step 2: F access-valid, different user → file-wins, nothing spent, F intact", async () => {
    await seedFile({
      token: "F-access",
      user: { id: "user-a", email: "a@x", name: "A" },
    });
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "F-access": "user-a", "L-access": "user-b" },
      refresh: {},
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("file-wins");
    expect(spent).toEqual([]);
    expect((await readCredentialsFile(credentialsPath()))?.token).toBe(
      "F-access",
    );
  });

  it("step 3: F access-valid, same user, L refresh live → committed with L's rotated pair", async () => {
    await seedFile({ token: "F-access" });
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "F-access": "user-a", "L-access": "user-a" },
      refresh: { "L-refresh": "ok" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("committed");
    expect(spent).toEqual(["L-refresh"]); // L preferred, spent exactly once
    const onDisk = await readCredentialsFile(credentialsPath());
    expect(onDisk?.token).toBe("L-refresh-tok");
    expect(onDisk?.refreshToken).toBe("L-refresh-ref");
    expect(onDisk?.user.id).toBe("user-a");
  });

  it("step 3: L refresh dead but F's own refresh live → fallback-file-validated, F rotated on its own token", async () => {
    await seedFile({ token: "F-access", refreshToken: "F-refresh" });
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "F-access": "user-a", "L-access": "user-a" },
      refresh: { "L-refresh": "reject", "F-refresh": "ok" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("fallback-file-validated");
    // L tried first (rejected), then F's own token in a fresh hold.
    expect(spent).toEqual(["L-refresh", "F-refresh"]);
    expect((await readCredentialsFile(credentialsPath()))?.token).toBe(
      "F-refresh-tok",
    );
  });

  it("step 3: both L and F refresh dead but F access valid → fallback-file-validated, F untouched", async () => {
    await seedFile({ token: "F-access", refreshToken: "F-refresh" });
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "F-access": "user-a", "L-access": "user-a" },
      refresh: { "L-refresh": "reject", "F-refresh": "reject" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("fallback-file-validated");
    expect(spent).toEqual(["L-refresh", "F-refresh"]);
    // The session stands on the pair it already holds.
    expect((await readCredentialsFile(credentialsPath()))?.token).toBe(
      "F-access",
    );
  });

  it("step 4: F absent, L live → committed, file created from L's rotated pair + probed identity", async () => {
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "L-access": "user-b" },
      refresh: { "L-refresh": "ok" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("committed");
    expect(spent).toEqual(["L-refresh"]);
    const onDisk = await readCredentialsFile(credentialsPath());
    expect(onDisk?.token).toBe("L-refresh-tok");
    expect(onDisk?.user.id).toBe("user-b");
    expect(onDisk?.authnBaseUrl).toBe(AUTHN_BASE_URL);
  });

  it("step 4: F absent, L refresh explicitly rejected → terminal-dead, no file created", async () => {
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "L-access": "user-b" },
      refresh: { "L-refresh": "reject" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("terminal-dead");
    expect(spent).toEqual(["L-refresh"]);
    expect(await readCredentialsFile(credentialsPath())).toBeNull();
  });

  it("step 4: F absent, L access expired → identity-unknown, nothing spent", async () => {
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "L-access": "reject" },
      refresh: { "L-refresh": "ok" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("identity-unknown");
    expect(spent).toEqual([]); // identity was never known → never spent
    expect(await readCredentialsFile(credentialsPath())).toBeNull();
  });

  it("step 4: F present-but-invalid, same user → committed, invalid F overwritten by L's rotated pair", async () => {
    await seedFile({
      token: "F-stale",
      user: { id: "user-a", email: "a@x", name: "A" },
    });
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "F-stale": "reject", "L-access": "user-a" },
      refresh: { "L-refresh": "ok" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("committed");
    expect(spent).toEqual(["L-refresh"]);
    expect((await readCredentialsFile(credentialsPath()))?.token).toBe(
      "L-refresh-tok",
    );
  });

  it("step 4: F present-but-invalid, different user → file-wins, invalid F kept for start() to revive", async () => {
    await seedFile({
      token: "F-stale",
      user: { id: "user-a", email: "a@x", name: "A" },
    });
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "F-stale": "reject", "L-access": "user-b" },
      refresh: { "L-refresh": "ok" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("file-wins");
    expect(spent).toEqual([]);
    expect((await readCredentialsFile(credentialsPath()))?.token).toBe(
      "F-stale",
    );
  });

  it("probe network error on the L leg → retryable, nothing spent", async () => {
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "L-access": "network" },
      refresh: { "L-refresh": "ok" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("retryable");
    expect(spent).toEqual([]);
  });

  it("a committed sign-out tombstone is never resurrected → tombstoned", async () => {
    const store = makeStore();
    // Establish then explicitly sign out: F absent + a sign-out tombstone in the
    // sidecar. A stale legacy remnant must not recreate the signed-out session.
    await store.signIn(
      { token: "prev", refreshToken: "prev-r" },
      {
        id: "user-a",
        email: "a@x",
        name: "A",
      },
    );
    await store.delete();
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "L-access": "user-b" },
      refresh: { "L-refresh": "ok" },
      spent,
    });

    const outcome = await store.migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("tombstoned");
    expect(spent).toEqual([]); // guard-before-spend: refused before any refresh
    expect(await readCredentialsFile(credentialsPath())).toBeNull();
  });

  it("step 3: F access-valid but L identity unknowable (access expired) → F-own rotate, L refresh NEVER spent (no cross-user spend)", async () => {
    await seedFile({
      token: "F-access",
      refreshToken: "F-refresh",
      user: { id: "user-a", email: "a@x", name: "A" },
    });
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      // L's access is expired → its identity is unknowable; both refreshes WOULD
      // mint if spent, so an assertion on `spent` proves L's is never sent.
      users: { "F-access": "user-a", "L-access": "reject" },
      refresh: { "F-refresh": "ok", "L-refresh": "ok" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });

    expect(outcome).toBe("fallback-file-validated");
    // L's refresh token — whose owner cannot be verified — is never spent; F is
    // rotated on its own token instead, so no foreign family lands under F's id.
    expect(spent).toEqual(["F-refresh"]);
    const onDisk = await readCredentialsFile(credentialsPath());
    expect(onDisk?.token).toBe("F-refresh-tok");
    expect(onDisk?.user.id).toBe("user-a");
  });

  it("step 4: F absent + L valid but empty refresh slot → terminal-dead without a guaranteed-reject spend", async () => {
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "L-access": "user-b" },
      refresh: {}, // must not be called
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "", // empty legacy refresh slot
    });

    expect(outcome).toBe("terminal-dead");
    expect(spent).toEqual([]); // no doomed refresh call, no retryable re-burn loop
    expect(await readCredentialsFile(credentialsPath())).toBeNull();
  });

  it("step 3: F access-valid + empty legacy refresh → F-own rotate, empty L never spent", async () => {
    await seedFile({
      token: "F-access",
      refreshToken: "F-refresh",
      user: { id: "user-a", email: "a@x", name: "A" },
    });
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "F-access": "user-a", "L-access": "user-a" },
      refresh: { "F-refresh": "ok" },
      spent,
    });

    const outcome = await makeStore().migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "",
    });

    expect(outcome).toBe("fallback-file-validated");
    expect(spent).toEqual(["F-refresh"]);
  });

  it("single-flights concurrent calls across windows → one migration, spent once", async () => {
    const spent: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "L-access": "user-b" },
      refresh: { "L-refresh": "ok" },
      spent,
    });
    const store = makeStore();

    const [a, b] = await Promise.all([
      store.migrateLegacyCredentials({
        token: "L-access",
        refreshToken: "L-refresh",
      }),
      store.migrateLegacyCredentials({
        token: "L-access",
        refreshToken: "L-refresh",
      }),
    ]);

    expect(a).toBe("committed");
    expect(b).toBe("committed");
    expect(spent).toEqual(["L-refresh"]); // coalesced: the refresh ran exactly once
  });

  it("re-arms the single-flight after a transient retryable so a later attempt still migrates", async () => {
    const store = makeStore();
    const spent1: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "L-access": "network" }, // probe fails → retryable, nothing spent
      refresh: {},
      spent: spent1,
    });
    const first = await store.migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });
    expect(first).toBe("retryable");
    expect(spent1).toEqual([]);

    // Connectivity returns; a later window on the SAME process must re-run, not
    // re-serve the cached retryable for the process lifetime.
    restoreFetch();
    const spent2: string[] = [];
    restoreFetch = installMigrationFetch({
      users: { "L-access": "user-b" },
      refresh: { "L-refresh": "ok" },
      spent: spent2,
    });
    const second = await store.migrateLegacyCredentials({
      token: "L-access",
      refreshToken: "L-refresh",
    });
    expect(second).toBe("committed");
    expect(spent2).toEqual(["L-refresh"]);
  });
});
