/**
 * End-to-end FileTokenStore tests against a real temp-dir credentials file
 * (lock + WAL via `createCredentialsMutationStore`). Fetch is the only faked
 * boundary — the locked rotate spend hits a stubbed authn refresh endpoint.
 *
 * Spec: credentials-file token-store tech plan §2 / §3 / §4.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import {
  deleteCredentialsFile,
  writeCredentialsFile,
  type StoredCredentials,
} from "@traycer/protocol/config/credentials";
import type { TokenStoreChange } from "@traycer-clients/shared/platform/runner-host";

const AUTHN_BASE_URL = "http://authn.file-token-store.test";
const ENVIRONMENT = "development";
const REFRESH_URL = `${AUTHN_BASE_URL}/api/v3/auth/refresh`;

const IDENTITY = {
  id: "u1",
  email: "ada@traycer.ai",
  name: "Ada",
} as const;

vi.mock("electron", () => ({
  app: {
    getPath: (): string => join(tmpdir(), "traycer-file-token-store-userdata"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

type FetchHandler = (
  input: unknown,
  init:
    { readonly method?: string; readonly body?: BodyInit | null } | undefined,
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

function okRefresh(token: string): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ token, refreshToken: `${token}-refresh` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function status(code: number): Promise<Response> {
  return Promise.resolve(new Response(null, { status: code }));
}

describe("FileTokenStore (real fs + lock/WAL)", () => {
  let homeDir: string;
  let previousHome: string | undefined;
  let restoreFetch: () => void = () => undefined;
  // Dynamically imported after HOME is redirected so `cliCredentialsPath`
  // resolves under the temp home for this suite.
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

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "traycer-file-token-store-"));
    previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    vi.resetModules();
    ({ FileTokenStore } = await import("../file-token-store"));
    // Default: any refresh mints a deterministic rotated pair.
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === REFRESH_URL) {
        return okRefresh("rotated-token");
      }
      return status(500);
    });
  });

  afterEach(() => {
    for (const store of stores) {
      store.dispose();
    }
    stores.length = 0;
    restoreFetch();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("resolves the env-scoped cliCredentialsPath (never slot-scoped)", () => {
    const path = credentialsPath();
    expect(path).toBe(
      join(homeDir, ".traycer", "cli", ENVIRONMENT, "credentials"),
    );
    // Smoke: constructing the store does not throw and targets that path.
    const store = makeStore();
    expect(store).toBeDefined();
  });

  it("signIn stamps authnBaseUrl + savedAt, get round-trips the full identity", async () => {
    const store = makeStore();
    await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);

    const got = await store.get();
    expect(got).toEqual({
      token: "tok-1",
      refreshToken: "rt-1",
      authnBaseUrl: AUTHN_BASE_URL,
      savedAt: expect.any(String),
      user: { ...IDENTITY },
    });
    expect(existsSync(credentialsPath())).toBe(true);
    const onDisk = JSON.parse(
      readFileSync(credentialsPath(), "utf8"),
    ) as StoredCredentials;
    expect(onDisk.authnBaseUrl).toBe(AUTHN_BASE_URL);
    expect(onDisk.user).toEqual(IDENTITY);
  });

  it("rotate with a matching expected token spends once and returns applied", async () => {
    const store = makeStore();
    await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);

    let refreshCalls = 0;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === REFRESH_URL) {
        refreshCalls += 1;
        return okRefresh("tok-1-r");
      }
      return status(500);
    });

    const result = await store.rotate({
      userId: IDENTITY.id,
      token: "tok-1",
    });
    expect(result.outcome).toBe("applied");
    expect(result.pair?.token).toBe("tok-1-r");
    expect(result.pair?.refreshToken).toBe("tok-1-r-refresh");
    expect(refreshCalls).toBe(1);
    expect((await store.get())?.token).toBe("tok-1-r");
  });

  it("rotate with a mismatched expected.token returns superseded without spending", async () => {
    const store = makeStore();
    await store.signIn(
      { token: "file-tok", refreshToken: "file-rt" },
      IDENTITY,
    );

    let refreshCalls = 0;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === REFRESH_URL) {
        refreshCalls += 1;
        return okRefresh("should-not-land");
      }
      return status(500);
    });

    const result = await store.rotate({
      userId: IDENTITY.id,
      token: "stale-expected",
    });
    expect(result.outcome).toBe("superseded");
    expect(result.pair?.token).toBe("file-tok");
    expect(refreshCalls).toBe(0);
  });

  it("rotate against an absent file returns deleted without spending", async () => {
    const store = makeStore();
    let refreshCalls = 0;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === REFRESH_URL) {
        refreshCalls += 1;
        return okRefresh("x");
      }
      return status(500);
    });

    const result = await store.rotate({
      userId: IDENTITY.id,
      token: "any",
    });
    expect(result.outcome).toBe("deleted");
    expect(result.pair).toBeNull();
    expect(refreshCalls).toBe(0);
  });

  it("rotate against a different user returns user-mismatch without spending", async () => {
    const store = makeStore();
    await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);

    let refreshCalls = 0;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === REFRESH_URL) {
        refreshCalls += 1;
        return okRefresh("x");
      }
      return status(500);
    });

    const result = await store.rotate({
      userId: "other-user",
      token: "tok-1",
    });
    expect(result.outcome).toBe("user-mismatch");
    expect(result.pair?.user.id).toBe(IDENTITY.id);
    expect(refreshCalls).toBe(0);
  });

  it("refresh-rejected keeps the credentials file", async () => {
    const store = makeStore();
    await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);

    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === REFRESH_URL) {
        return status(401);
      }
      return status(500);
    });

    const result = await store.rotate({
      userId: IDENTITY.id,
      token: "tok-1",
    });
    expect(result.outcome).toBe("refresh-rejected");
    expect(await store.get()).toEqual({
      token: "tok-1",
      refreshToken: "rt-1",
      authnBaseUrl: AUTHN_BASE_URL,
      savedAt: expect.any(String),
      user: { ...IDENTITY },
    });
    expect(existsSync(credentialsPath())).toBe(true);
  });

  it("delete removes the file", async () => {
    const store = makeStore();
    await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);
    expect(existsSync(credentialsPath())).toBe(true);

    await store.delete();
    expect(await store.get()).toBeNull();
    expect(existsSync(credentialsPath())).toBe(false);
  });

  it("delete rejects when the file cannot be removed", async () => {
    // Freeze the credentials parent so the WAL prepare/apply cannot land a
    // sign-out delete. FileTokenStore must surface the failure (throw) rather
    // than claim signed-out.
    const isWindows = process.platform === "win32";
    const isRoot =
      typeof process.getuid === "function" && process.getuid() === 0;
    if (isWindows || isRoot) {
      // chmod bits are ignored on Windows / as root — skip the negative path.
      return;
    }

    const store = makeStore();
    await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);
    const parent = dirname(credentialsPath());
    chmodSync(parent, 0o500);
    try {
      // Freezing the parent blocks lock acquisition / WAL writes. The surface
      // contract is "delete rejects" (so AuthService stays signed in) — the
      // failure may surface as a typed non-deleted outcome or as an EACCES
      // throw from the lock/WAL path; either way the file must remain.
      await expect(store.delete()).rejects.toThrow();
      expect(existsSync(credentialsPath())).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it("two store instances racing rotate: exactly one spends, the other is superseded", async () => {
    const a = makeStore();
    const b = makeStore();
    await a.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);

    let refreshCalls = 0;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === REFRESH_URL) {
        refreshCalls += 1;
        return okRefresh(`rotated-${refreshCalls}`);
      }
      return status(500);
    });

    const [ra, rb] = await Promise.all([
      a.rotate({ userId: IDENTITY.id, token: "tok-1" }),
      b.rotate({ userId: IDENTITY.id, token: "tok-1" }),
    ]);

    expect(refreshCalls).toBe(1);
    const outcomes = [ra.outcome, rb.outcome].slice().sort();
    expect(outcomes).toEqual(["applied", "superseded"]);
    // Both callers end up looking at a live pair (the winner's write).
    const live = await a.get();
    expect(live?.token.startsWith("rotated-")).toBe(true);
    expect((await b.get())?.token).toBe(live?.token);
  });

  it("subscribe is a live registration that never fires (§4 stub)", async () => {
    const store = makeStore();
    let fired = 0;
    const dispose = store.subscribe(() => {
      fired += 1;
    });
    await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);
    await store.rotate({ userId: IDENTITY.id, token: "tok-1" });
    dispose();
    expect(fired).toBe(0);
  });

  it("signIn on a second instance supersedes a prior sign-out tombstone", async () => {
    const a = makeStore();
    await a.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);
    await a.delete();
    expect(await a.get()).toBeNull();

    const b = makeStore();
    await b.signIn({ token: "tok-2", refreshToken: "rt-2" }, IDENTITY);
    expect((await b.get())?.token).toBe("tok-2");
  });

  it("get awaits recovery: mid-sign-out pending does not ghost-sign-in", async () => {
    // Crash mid-sign-out: F is still present + sidecar pending signOut.
    // Without gating get() on the recovery gate, cold-start rehydration would
    // see F and project a signed-in session that recovery is about to delete.
    const path = credentialsPath();
    const metaPath = `${path}.meta.json`;
    const parent = dirname(path);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(parent, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        token: "ghost-token",
        refreshToken: "ghost-refresh",
        authnBaseUrl: AUTHN_BASE_URL,
        savedAt: "2026-01-01T00:00:00.000Z",
        user: { ...IDENTITY },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      metaPath,
      JSON.stringify({
        epoch: 0,
        lastMutation: null,
        mtimeFloorMs: 0,
        pending: {
          op: "signOut",
          nextEpoch: 1,
          targetDigest: null,
          floorCandidate: 0,
        },
      }),
      { mode: 0o600 },
    );
    expect(existsSync(path)).toBe(true);

    const store = makeStore();
    // get() must await the recovery gate, which completes the pending delete.
    expect(await store.get()).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  describe("owned watcher (§4)", () => {
    const EXTERNAL: StoredCredentials = {
      token: "ext-token",
      refreshToken: "ext-refresh",
      authnBaseUrl: AUTHN_BASE_URL,
      savedAt: "2026-01-01T00:00:00.000Z",
      user: { ...IDENTITY },
    };

    it("external write fires subscribe with present:true, userId, higher revision", async () => {
      const store = makeStore();
      const changes: TokenStoreChange[] = [];
      const dispose = store.subscribe((change) => {
        changes.push(change);
      });

      await writeCredentialsFile(credentialsPath(), EXTERNAL, 0);

      await vi.waitFor(() => {
        expect(changes.length).toBeGreaterThanOrEqual(1);
      });
      const last = changes[changes.length - 1];
      expect(last).toEqual({
        present: true,
        userId: IDENTITY.id,
        revision: expect.any(Number),
      });
      expect(last.revision).toBeGreaterThanOrEqual(1);
      dispose();
    });

    it("external delete fires present:false", async () => {
      const store = makeStore();
      await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);
      // Drain the self-write emit from signIn before asserting on the delete.
      await vi.waitFor(async () => {
        expect(await store.get()).not.toBeNull();
      });

      const changes: TokenStoreChange[] = [];
      const dispose = store.subscribe((change) => {
        changes.push(change);
      });

      await deleteCredentialsFile(credentialsPath());

      await vi.waitFor(() => {
        expect(changes.some((c) => c.present === false)).toBe(true);
      });
      const lastDelete = changes.filter((c) => c.present === false).at(-1);
      expect(lastDelete).toEqual({
        present: false,
        userId: null,
        revision: expect.any(Number),
      });
      dispose();
    });

    it("debounce coalesces a burst of external writes into one emit", async () => {
      const store = makeStore();
      const changes: TokenStoreChange[] = [];
      const dispose = store.subscribe((change) => {
        changes.push(change);
      });

      // Burst of rapid renames through the protocol write primitive.
      await Promise.all([
        writeCredentialsFile(
          credentialsPath(),
          { ...EXTERNAL, token: "burst-1" },
          0,
        ),
        writeCredentialsFile(
          credentialsPath(),
          { ...EXTERNAL, token: "burst-2" },
          0,
        ),
        writeCredentialsFile(
          credentialsPath(),
          { ...EXTERNAL, token: "burst-3" },
          0,
        ),
      ]);

      await vi.waitFor(() => {
        expect(changes.length).toBeGreaterThanOrEqual(1);
      });
      // Give the debounce window a little more time to prove no late extras.
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      // A burst must not produce one event per write; coalesce toward one.
      expect(changes.length).toBeLessThan(3);
      expect(changes.at(-1)?.present).toBe(true);
      expect(changes.at(-1)?.userId).toBe(IDENTITY.id);
      dispose();
    });
  });
});
