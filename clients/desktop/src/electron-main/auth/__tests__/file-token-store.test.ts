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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";
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

/**
 * Waits that cross a REAL `fs.watch` need a regression-scale bound, not the
 * implicit 1000 ms `vi.waitFor` default. OS event delivery is unbounded, and
 * the store's own 50 ms debounce only starts once the watcher callback runs,
 * so the default is a wall-clock bet on a loaded machine - and it loses. CI
 * observed `external write fires subscribe...` failing at 1017 ms, and 12
 * parallel local copies of this file reproduce it.
 *
 * A watcher that genuinely never delivers still fails here in seconds, while
 * ordinary scheduler latency no longer does. Only real-delivery waits use
 * this; mock-driven waits elsewhere keep the default deliberately.
 */
const WATCHER_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Per-test timeouts below are `N * WATCHER_DELIVERY_TIMEOUT_MS +
 * TEST_TIMEOUT_BUFFER_MS`, not a bare sum: the enclosing Vitest timer starts
 * before the `signIn`/`rotate`/write calls that precede each `vi.waitFor`,
 * so a sum-only budget leaves zero room for those calls, their assertions,
 * or (for the debounce test) the extra 120 ms post-wait sleep. Sized well
 * above that fixed overhead rather than tuned to the minimum that passes.
 */
const TEST_TIMEOUT_BUFFER_MS = 5_000;

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
      watchImpl: undefined,
    });
    stores.push(store);
    return store;
  }

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), "traycer-file-token-store-"));
    previousHome = process.env.HOME;
    sandboxHome(homeDir);
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

  it("signIn stamps savedAt, get round-trips the full identity", async () => {
    const store = makeStore();
    await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);

    const got = await store.get();
    expect(got).toEqual({
      token: "tok-1",
      refreshToken: "rt-1",
      savedAt: expect.any(String),
      user: { ...IDENTITY },
    });
    expect(existsSync(credentialsPath())).toBe(true);
    const onDisk = JSON.parse(
      readFileSync(credentialsPath(), "utf8"),
    ) as StoredCredentials;
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

  /**
   * Replaces a test that asserted `subscribe` "never fires". It does fire:
   * the watcher is installed in the constructor and deliberately notifies on
   * SELF-writes as well as external ones (see the contract note on
   * `FileTokenStore` and on `subscribe` itself), so the old assertion only
   * held while the 50 ms debounce had not yet elapsed - i.e. it was a race
   * that a fast machine won. CI lost it: `expected 1 to be +0`. The suite
   * already knew better one screen down, where a sibling test drains "the
   * self-write emit from signIn" before asserting on a delete.
   *
   * What is actually worth pinning is the unsubscribe contract, and it is
   * pinned without any sleep: a SECOND live listener acts as a positive
   * acknowledgement that a post-unsubscribe write travelled the whole real
   * path (fs.watch delivery -> debounce -> read -> fan-out). Once the probe
   * has observed that event, the unsubscribed listener demonstrably had its
   * chance and did not fire. Sleeping past 50 ms instead would not work:
   * `fs.watch` delivery itself has no upper bound, and the debounce only
   * starts once the watcher callback runs.
   */
  it(
    "unsubscribing stops delivery while the watcher keeps notifying others",
    async () => {
      const store = makeStore();

      let firstCount = 0;
      const unsubscribeFirst = store.subscribe(() => {
        firstCount += 1;
      });

      // Establish that the registration is genuinely live, rather than
      // inferring it from the absence of a call.
      await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);
      await vi.waitFor(
        () => {
          expect(firstCount).toBeGreaterThanOrEqual(1);
        },
        { timeout: WATCHER_DELIVERY_TIMEOUT_MS },
      );

      unsubscribeFirst();
      const countAtUnsubscribe = firstCount;

      // The second mutation is a delete, not another rotate: its
      // `present: false` payload cannot be satisfied by a notification the
      // first (still in-flight) signIn write already queued, which the probe
      // subscribing after unsubscribeFirst could otherwise observe and
      // mistake for acknowledgement of this mutation.
      const probeChanges: TokenStoreChange[] = [];
      const unsubscribeProbe = store.subscribe((change) => {
        probeChanges.push(change);
      });

      await store.delete();
      await vi.waitFor(
        () => {
          expect(probeChanges.some((c) => c.present === false)).toBe(true);
        },
        { timeout: WATCHER_DELIVERY_TIMEOUT_MS },
      );

      // The probe proves an event completed the full path after the first
      // listener unsubscribed, so an unchanged count is a real guarantee.
      expect(firstCount).toBe(countAtUnsubscribe);
      unsubscribeProbe();
    },
    // Two sequential WATCHER_DELIVERY_TIMEOUT_MS waits: give the test itself
    // headroom above their sum, or Vitest's 5s default per-test timeout aborts
    // the test before either wait's own (longer) deadline can take effect.
    2 * WATCHER_DELIVERY_TIMEOUT_MS + TEST_TIMEOUT_BUFFER_MS,
  );

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
      savedAt: "2026-01-01T00:00:00.000Z",
      user: { ...IDENTITY },
    };

    it(
      "external write fires subscribe with present:true, userId, higher revision",
      async () => {
        const store = makeStore();
        const changes: TokenStoreChange[] = [];
        const dispose = store.subscribe((change) => {
          changes.push(change);
        });

        await writeCredentialsFile(credentialsPath(), EXTERNAL, 0);

        await vi.waitFor(
          () => {
            expect(changes.length).toBeGreaterThanOrEqual(1);
          },
          { timeout: WATCHER_DELIVERY_TIMEOUT_MS },
        );
        const last = changes[changes.length - 1];
        expect(last).toEqual({
          present: true,
          userId: IDENTITY.id,
          revision: expect.any(Number),
        });
        expect(last.revision).toBeGreaterThanOrEqual(1);
        dispose();
      },
      WATCHER_DELIVERY_TIMEOUT_MS + TEST_TIMEOUT_BUFFER_MS,
    );

    it(
      "recovers the watch after a failed install and emits a catch-up change",
      async () => {
        // Plant a FILE where the credentials DIRECTORY must go: the
        // constructor's watcher install fails (mkdir ENOTDIR) and schedules
        // the backoff reinstall instead of leaving the store blind forever.
        const credsDir = dirname(credentialsPath());
        mkdirSync(dirname(credsDir), { recursive: true, mode: 0o700 });
        writeFileSync(credsDir, "not a directory", { mode: 0o600 });
        const store = makeStore();
        const changes: TokenStoreChange[] = [];
        const dispose = store.subscribe((change) => {
          changes.push(change);
        });

        // Unblock and land a write BEFORE the reinstall fires - the catch-up
        // emit after the reinstall must surface it even though the watch was
        // down when it happened.
        rmSync(credsDir);
        await writeCredentialsFile(credentialsPath(), EXTERNAL, 0);

        await vi.waitFor(
          () => {
            expect(changes.some((change) => change.present)).toBe(true);
          },
          { timeout: WATCHER_DELIVERY_TIMEOUT_MS + 2_000 },
        );
        dispose();
      },
      WATCHER_DELIVERY_TIMEOUT_MS + TEST_TIMEOUT_BUFFER_MS + 3_000,
    );

    it(
      "external delete fires present:false",
      async () => {
        const store = makeStore();
        await store.signIn({ token: "tok-1", refreshToken: "rt-1" }, IDENTITY);
        // Drain the self-write emit from signIn before asserting on the delete.
        await vi.waitFor(
          async () => {
            expect(await store.get()).not.toBeNull();
          },
          { timeout: WATCHER_DELIVERY_TIMEOUT_MS },
        );

        const changes: TokenStoreChange[] = [];
        const dispose = store.subscribe((change) => {
          changes.push(change);
        });

        await deleteCredentialsFile(credentialsPath());

        await vi.waitFor(
          () => {
            expect(changes.some((c) => c.present === false)).toBe(true);
          },
          { timeout: WATCHER_DELIVERY_TIMEOUT_MS },
        );
        const lastDelete = changes.filter((c) => c.present === false).at(-1);
        expect(lastDelete).toEqual({
          present: false,
          userId: null,
          revision: expect.any(Number),
        });
        dispose();
      },
      2 * WATCHER_DELIVERY_TIMEOUT_MS + TEST_TIMEOUT_BUFFER_MS,
    );

    it(
      "debounce coalesces a burst of external writes into one emit",
      async () => {
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

        await vi.waitFor(
          () => {
            expect(changes.length).toBeGreaterThanOrEqual(1);
          },
          { timeout: WATCHER_DELIVERY_TIMEOUT_MS },
        );
        // Give the debounce window a little more time to prove no late extras.
        await new Promise<void>((resolve) => setTimeout(resolve, 120));
        // A burst must not produce one event per write; coalesce toward one.
        expect(changes.length).toBeLessThan(3);
        expect(changes.at(-1)?.present).toBe(true);
        expect(changes.at(-1)?.userId).toBe(IDENTITY.id);
        dispose();
      },
      WATCHER_DELIVERY_TIMEOUT_MS + TEST_TIMEOUT_BUFFER_MS,
    );
  });
});
