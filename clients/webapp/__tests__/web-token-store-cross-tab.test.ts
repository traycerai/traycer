import { describe, expect, it } from "vitest";
import type {
  AuthTokenRefreshResult,
  StoredCredentials,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import {
  WEB_TOKEN_STORE_KEY,
  WebTokenStore,
  type WebCredentialRefresh,
  type WebCredentialStorage,
  type WebIdentityProbe,
  type WebLockManager,
} from "@traycer-clients/webapp/web-token-store";

/**
 * Two tabs of one origin, which is the only configuration in which this store
 * differs from every other shell's. A single-context test would pass against
 * a store with no lock at all, so every case here drives at least two.
 *
 * The doubles model the three facts the real platform supplies: one backing
 * map behind N `localStorage` views, a `storage` event that reaches every
 * context EXCEPT the writer, and a refresh token authn will honour exactly
 * once.
 */
class FakeOrigin {
  private readonly values = new Map<string, string>();
  private readonly contexts: FakeContextHandlers[] = [];

  openContext(): WebCredentialStorage {
    const handlers: FakeContextHandlers = new Map();
    this.contexts.push(handlers);
    return {
      read: (key) => this.values.get(key) ?? null,
      write: (key, value) => {
        this.values.set(key, value);
        this.broadcast(handlers, key);
      },
      remove: (key) => {
        this.values.delete(key);
        this.broadcast(handlers, key);
      },
      onExternalChange: (key, handler) => {
        const existing = handlers.get(key) ?? [];
        existing.push(handler);
        handlers.set(key, existing);
      },
    };
  }

  /** `storage` never fires in the document that performed the write. */
  private broadcast(writer: FakeContextHandlers, key: string): void {
    for (const context of this.contexts) {
      if (context === writer) continue;
      for (const handler of context.get(key) ?? []) {
        handler();
      }
    }
  }
}

type FakeContextHandlers = Map<string, (() => void)[]>;

/** FIFO exclusion over one name, the property `navigator.locks` provides. */
class FifoLockManager implements WebLockManager {
  private readonly chains = new Map<string, Promise<void>>();

  runExclusive<T>(name: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(name) ?? Promise.resolve();
    const run = previous.then(
      () => task(),
      () => task(),
    );
    this.chains.set(
      name,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

/**
 * The discriminating control: same shape, no exclusion. Every test that
 * claims the lock does something re-runs against this one and must observe
 * the damage, or it was not testing the lock.
 */
const noExclusionLocks: WebLockManager = {
  runExclusive: (name, task) => {
    void name;
    return task();
  },
};

/** Single-use refresh tokens, the way authn treats them. */
class FakeAuthn {
  readonly presented: string[] = [];
  private readonly live = new Set<string>();
  private counter = 0;

  constructor(initialRefreshToken: string) {
    this.live.add(initialRefreshToken);
  }

  readonly refresh: WebCredentialRefresh = async (
    request,
  ): Promise<AuthTokenRefreshResult> => {
    this.presented.push(request.refreshToken);
    if (!this.live.has(request.refreshToken)) {
      return { kind: "rejected" };
    }
    this.live.delete(request.refreshToken);
    this.counter += 1;
    const refreshToken = `refresh-${this.counter}`;
    this.live.add(refreshToken);
    return { kind: "refreshed", token: `access-${this.counter}`, refreshToken };
  };
}

const unusedProbe: WebIdentityProbe = async () => ({ kind: "network-error" });

function seedCredentials(
  storage: WebCredentialStorage,
  credentials: StoredCredentials,
): void {
  storage.write(WEB_TOKEN_STORE_KEY, JSON.stringify(credentials));
}

function credentialsFor(
  token: string,
  refreshToken: string,
  userId: string,
): StoredCredentials {
  return {
    token,
    refreshToken,
    savedAt: "2026-01-01T00:00:00.000Z",
    user: { id: userId, email: `${userId}@example.test`, name: userId },
  };
}

interface RaceFixture {
  readonly authn: FakeAuthn;
  readonly first: WebTokenStore;
  readonly second: WebTokenStore;
}

function buildRace(locks: WebLockManager): RaceFixture {
  const origin = new FakeOrigin();
  const firstStorage = origin.openContext();
  const secondStorage = origin.openContext();
  // Seeded through a third context so neither tab treats the seed as its own
  // write and neither starts with a change already delivered.
  seedCredentials(
    origin.openContext(),
    credentialsFor("access-0", "refresh-0", "user-1"),
  );
  const authn = new FakeAuthn("refresh-0");
  const shared = {
    authnBaseUrl: "https://authn.test",
    refresh: authn.refresh,
    probeIdentity: unusedProbe,
  };
  return {
    authn,
    first: new WebTokenStore({ storage: firstStorage, locks, ...shared }),
    second: new WebTokenStore({ storage: secondStorage, locks, ...shared }),
  };
}

const BASE_EXPECTATION = { userId: "user-1", token: "access-0" } as const;

describe("WebTokenStore cross-tab authority", () => {
  it("spends one refresh when two tabs rotate the same pair", async () => {
    const race = buildRace(new FifoLockManager());

    const [firstResult, secondResult] = await Promise.all([
      race.first.rotate(BASE_EXPECTATION),
      race.second.rotate(BASE_EXPECTATION),
    ]);

    expect(race.authn.presented).toEqual(["refresh-0"]);
    expect(firstResult.outcome).toBe("applied");
    expect(secondResult.outcome).toBe("superseded");
  });

  it("hands the loser the winner's committed pair to adopt", async () => {
    const race = buildRace(new FifoLockManager());

    const [firstResult, secondResult] = await Promise.all([
      race.first.rotate(BASE_EXPECTATION),
      race.second.rotate(BASE_EXPECTATION),
    ]);

    expect(firstResult.pair?.token).toBe("access-1");
    // The refusal is not merely a refusal: it carries the pair the caller
    // must switch to, which is what keeps the loser signed in.
    expect(secondResult.pair).toEqual(firstResult.pair);
    expect(await race.second.get()).toEqual(firstResult.pair);
  });

  it("without exclusion both tabs spend and the second is rejected", async () => {
    const race = buildRace(noExclusionLocks);

    const [firstResult, secondResult] = await Promise.all([
      race.first.rotate(BASE_EXPECTATION),
      race.second.rotate(BASE_EXPECTATION),
    ]);

    // The damage the lock prevents, stated as an expectation so the two tests
    // above cannot pass vacuously: the same refresh token is presented twice,
    // authn honours it once, and the losing tab is signed out holding a
    // credential that is still perfectly good in storage.
    expect(race.authn.presented).toEqual(["refresh-0", "refresh-0"]);
    expect(firstResult.outcome).toBe("applied");
    expect(secondResult.outcome).toBe("refresh-rejected");
  });

  it("refuses a rotation whose base another tab already replaced", async () => {
    const race = buildRace(new FifoLockManager());

    await race.first.rotate(BASE_EXPECTATION);
    // A LATER attempt on the stale base, with no concurrency at all: the
    // compare is what refuses it, not the lock's ordering.
    const stale = await race.second.rotate(BASE_EXPECTATION);

    expect(stale.outcome).toBe("superseded");
    expect(race.authn.presented).toEqual(["refresh-0"]);
  });

  it("refuses a rotation once another tab signed a different user in", async () => {
    const race = buildRace(new FifoLockManager());

    await race.first.signIn(
      { token: "other-access", refreshToken: "other-refresh" },
      { id: "user-2", email: "user-2@example.test", name: "user-2" },
    );
    const result = await race.second.rotate(BASE_EXPECTATION);

    expect(result.outcome).toBe("user-mismatch");
    expect(result.pair?.user.id).toBe("user-2");
    expect(race.authn.presented).toEqual([]);
  });

  it("deletes only its own pair when a sibling rotated first", async () => {
    const race = buildRace(new FifoLockManager());

    const [rotation, conditionalDelete] = await Promise.all([
      race.first.rotate(BASE_EXPECTATION),
      race.second.deleteIfToken("access-0"),
    ]);

    expect(rotation.outcome).toBe("applied");
    // The compare and the delete are atomic at the lock, so the sibling's
    // stale expectation loses instead of wiping a session it never saw.
    expect(conditionalDelete).toBe("kept");
    expect(await race.second.get()).not.toBeNull();
  });

  it("without exclusion the same conditional delete wipes the new session", async () => {
    const race = buildRace(noExclusionLocks);

    const [, conditionalDelete] = await Promise.all([
      race.first.rotate(BASE_EXPECTATION),
      race.second.deleteIfToken("access-0"),
    ]);

    expect(conditionalDelete).toBe("deleted");
  });
});

describe("WebTokenStore storage-event adoption", () => {
  it("tells a sibling tab that a sign-in happened", async () => {
    const race = buildRace(new FifoLockManager());
    const seen: TokenStoreChange[] = [];
    race.second.subscribe((change) => {
      seen.push(change);
    });

    await race.first.signIn(
      { token: "next-access", refreshToken: "next-refresh" },
      { id: "user-2", email: "user-2@example.test", name: "user-2" },
    );

    expect(seen.map((change) => change.userId)).toEqual(["user-2"]);
    expect(seen[0]?.present).toBe(true);
    expect((await race.second.get())?.token).toBe("next-access");
  });

  it("tells a sibling tab that a sign-out happened", async () => {
    const race = buildRace(new FifoLockManager());
    const seen: TokenStoreChange[] = [];
    race.second.subscribe((change) => {
      seen.push(change);
    });

    await race.first.delete();

    expect(seen.map((change) => change.present)).toEqual([false]);
    expect(await race.second.get()).toBeNull();
  });

  it("does not re-announce a sibling's write to the writer", async () => {
    const race = buildRace(new FifoLockManager());
    const seen: TokenStoreChange[] = [];
    race.first.subscribe((change) => {
      seen.push(change);
    });

    await race.first.signIn(
      { token: "next-access", refreshToken: "next-refresh" },
      { id: "user-2", email: "user-2@example.test", name: "user-2" },
    );
    // Let the writer's own microtask notification land.
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one: the writer's own, never a duplicate from the adoption
    // edge - which the platform's `storage` event does not deliver to the
    // document that wrote.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.revision).toBe(1);
  });
});
