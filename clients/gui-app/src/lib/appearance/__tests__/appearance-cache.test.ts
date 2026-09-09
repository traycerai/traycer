import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { createStore, set as idbSet } from "idb-keyval";
import type { WorkspaceAppearanceRead } from "@traycer/protocol/host/workspace/appearance-schemas";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";

// `Response.blob()` (Node's `undici`) and the fake IndexedDB's real
// `structuredClone` both operate on Node's OWN `Blob` (from `node:buffer`),
// a different class than jsdom's ambient `Blob` global - a blob round-tripped
// through the cache fails `instanceof Blob` (the read-side check in
// `appearance-cache.ts`) against whichever class was in scope. Stubbing the
// global to Node's `Blob` for every test in this file makes every fixture
// `new Blob(...)` and the cache's own `instanceof Blob` check agree.
beforeEach(() => {
  vi.stubGlobal("Blob", NodeBlob);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type CacheModule = typeof import("../appearance-cache");
type AuthModule = typeof import("@/stores/auth/auth-store");

/**
 * The cache module opens its IndexedDB store and subscribes to the auth store
 * ONCE, at import time, and its `generation`/`wiping` module state is never
 * exported or resettable - `clearAppearanceCache()` in particular locks the
 * module for the rest of its lifetime (by design: production only calls it
 * right before `window.location.reload()`). So every test gets a fresh
 * `indexedDB` AND a fresh dynamic import of both modules, and must use the
 * `authStore` returned here (not any statically-imported one) so the cache's
 * internal `useAuthStore.subscribe` actually observes the mutation.
 */
async function loadAppearanceCache(): Promise<{
  readonly cache: CacheModule;
  readonly authStore: AuthModule["useAuthStore"];
}> {
  vi.resetModules();
  installFreshIndexedDb();
  const { useAuthStore } = await import("@/stores/auth/auth-store");
  const cache = await import("../appearance-cache");
  return { cache, authStore: useAuthStore };
}

function signIn(authStore: AuthModule["useAuthStore"], userId: string): void {
  authStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

function signOut(authStore: AuthModule["useAuthStore"]): void {
  authStore.setState({ status: "signed-out", contextMetadata: null });
}

function appearanceRead(
  overrides: Partial<WorkspaceAppearanceRead> & {
    readonly canonicalSourceRoot: string;
  },
): WorkspaceAppearanceRead {
  return {
    workspacePath: "/repo",
    status: "present",
    appearance: { version: 1, color: "#112233" },
    invalidFields: [],
    messages: [],
    ...overrides,
  };
}

function blob(sizeBytes: number, marker: number): Blob {
  const bytes = new Uint8Array(sizeBytes);
  bytes[0] = marker;
  return new Blob([bytes], { type: "image/png" });
}

/**
 * FIFO eviction orders candidates by `write()`'s own `Date.now()` call, so
 * these tests need explicit control over that ordering across several real
 * (awaited) IndexedDB writes. `vi.useFakeTimers()` is the wrong tool here:
 * fake timers also intercept the task/microtask scheduling `idb-keyval`'s
 * real transactions depend on, which stalls them instead of speeding them up.
 * Spying on `Date.now()` alone controls the ordering value without touching
 * how real async work is scheduled.
 */
function useAdvancingClock(): {
  readonly advance: () => void;
  readonly restore: () => void;
} {
  let now = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
  return {
    advance: () => {
      now += 1_000;
    },
    restore: () => spy.mockRestore(),
  };
}

async function blobMarker(candidate: Blob): Promise<number> {
  return new Uint8Array(await candidate.arrayBuffer())[0];
}

function requireBlob(candidate: Blob | null): Blob {
  if (candidate === null) throw new Error("expected a non-null blob");
  return candidate;
}

describe("appearance-cache: snapshot scoping", () => {
  it("round-trips a snapshot within its own account/host/source scope", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };
    const snapshot = appearanceRead({
      canonicalSourceRoot: scope.canonicalSourceRoot,
    });

    await cache.writeAppearanceSnapshot(scope, snapshot);

    expect(await cache.readAppearanceSnapshot(scope)).toEqual(snapshot);
  });

  it("misses a snapshot written under a different host", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };
    await cache.writeAppearanceSnapshot(
      scope,
      appearanceRead({ canonicalSourceRoot: scope.canonicalSourceRoot }),
    );

    const otherHost = { ...scope, hostId: "host-2" };
    expect(await cache.readAppearanceSnapshot(otherHost)).toBeNull();
  });

  it("misses a snapshot written under a different canonical source root", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };
    await cache.writeAppearanceSnapshot(
      scope,
      appearanceRead({ canonicalSourceRoot: scope.canonicalSourceRoot }),
    );

    const otherRoot = { ...scope, canonicalSourceRoot: "/repo/other-root" };
    expect(await cache.readAppearanceSnapshot(otherRoot)).toBeNull();
  });

  it("silently drops a snapshot write whose canonicalSourceRoot disagrees with the scope", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };

    await cache.writeAppearanceSnapshot(
      scope,
      appearanceRead({ canonicalSourceRoot: "/repo/mismatched" }),
    );

    expect(await cache.readAppearanceSnapshot(scope)).toBeNull();
  });

  it("treats a persisted snapshot whose canonicalSourceRoot no longer matches the scope as a miss (defensive read-side check)", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };
    // Bypass the module's own write-side guard to simulate a corrupted/aliased
    // record already sitting in the store under this scope's key.
    const rawStore = createStore(cache.APPEARANCE_DB_NAME, "appearance");
    await idbSet(
      `snapshot:${cache.appearanceScopeKey(scope)}`,
      {
        value: appearanceRead({ canonicalSourceRoot: "/repo/wrong-root" }),
        size: 1,
        accessed: Date.now(),
        pinned: false,
      },
      rawStore,
    );

    expect(await cache.readAppearanceSnapshot(scope)).toBeNull();
  });
});

describe("appearance-cache: source association", () => {
  it("round-trips a workspace path's resolved source root", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    await cache.writeAppearanceSource(
      "acct-1",
      "host-1",
      "/repo/worktree-a",
      "/repo/root",
    );

    expect(
      await cache.readAppearanceSource("acct-1", "host-1", "/repo/worktree-a"),
    ).toBe("/repo/root");
  });

  it("isolates the source association by workspace path", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    await cache.writeAppearanceSource(
      "acct-1",
      "host-1",
      "/repo/worktree-a",
      "/repo/root",
    );

    expect(
      await cache.readAppearanceSource("acct-1", "host-1", "/repo/worktree-b"),
    ).toBeNull();
  });
});

describe("appearance-cache: blob storage", () => {
  it("round-trips a host+source scoped blob", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };
    await cache.writeAppearanceBlob(scope, "appearance/bg.png", blob(1024, 7));

    const stored = await cache.readAppearanceBlob(scope, "appearance/bg.png");
    expect(stored).not.toBeNull();
    expect(await blobMarker(requireBlob(stored))).toBe(7);
  });

  it("does not let a global (scope null) blob collide with a host-scoped blob of the same identity", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };
    await cache.writeAppearanceBlob(scope, "same-name.png", blob(1024, 1));
    await cache.writeAppearanceBlob(null, "same-name.png", blob(1024, 2));

    expect(
      await blobMarker(
        requireBlob(await cache.readAppearanceBlob(scope, "same-name.png")),
      ),
    ).toBe(1);
    expect(
      await blobMarker(
        requireBlob(await cache.readAppearanceBlob(null, "same-name.png")),
      ),
    ).toBe(2);
  });

  it("rejects a single write that exceeds the cache budget on its own, and never stores it", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };

    await expect(
      cache.writeAppearanceBlob(
        scope,
        "too-big.png",
        blob(cache.APPEARANCE_CACHE_LIMIT + 1, 1),
      ),
    ).rejects.toThrow(/exceeds the cache budget/);
    expect(await cache.readAppearanceBlob(scope, "too-big.png")).toBeNull();
  });

  it("evicts the least-recently-written non-pinned entry once a new write pushes the total over budget", async () => {
    const clock = useAdvancingClock();
    try {
      const { cache, authStore } = await loadAppearanceCache();
      signIn(authStore, "acct-1");
      const scope = {
        accountId: "acct-1",
        hostId: "host-1",
        canonicalSourceRoot: "/repo/root",
      };
      const THIRTY_MIB = 30 * 1024 * 1024;
      const TWENTY_MIB = 20 * 1024 * 1024;

      await cache.writeAppearanceBlob(scope, "a.png", blob(THIRTY_MIB, 1));
      clock.advance();
      await cache.writeAppearanceBlob(scope, "b.png", blob(THIRTY_MIB, 2));
      // a(30) + b(30) = 60 MiB, under the 64 MiB cap so far.
      clock.advance();
      // Adding c(20) would push the total to 80 MiB - "a" (the oldest write)
      // must be evicted to make room.
      await cache.writeAppearanceBlob(scope, "c.png", blob(TWENTY_MIB, 3));

      expect(await cache.readAppearanceBlob(scope, "a.png")).toBeNull();
      expect(await cache.readAppearanceBlob(scope, "b.png")).not.toBeNull();
      expect(await cache.readAppearanceBlob(scope, "c.png")).not.toBeNull();
    } finally {
      clock.restore();
    }
  }, 20_000);
});

describe("appearance-cache: global pinning", () => {
  // `write()` excludes a pinned entry from the candidate pool ENTIRELY (its
  // bytes are not even counted toward the 64 MiB budget) - so proving
  // protection requires pushing the UNPINNED total alone past the cap; two
  // 30 MiB unpinned writes (60 MiB) still fit and would falsely "pass" a
  // weaker version of this test that never actually forced an eviction.
  it("protects only the explicitly pinned identity from eviction, not every scope-null write", async () => {
    const clock = useAdvancingClock();
    try {
      const { cache, authStore } = await loadAppearanceCache();
      signIn(authStore, "acct-1");
      const scope = {
        accountId: "acct-1",
        hostId: "host-1",
        canonicalSourceRoot: "/repo/root",
      };
      const THIRTY_MIB = 30 * 1024 * 1024;

      await cache.writeAppearanceBlob(null, "pinned.png", blob(THIRTY_MIB, 1));
      await cache.pinGlobalAppearanceBlob("pinned.png");
      clock.advance();
      await cache.writeAppearanceBlob(scope, "bulk-a.png", blob(THIRTY_MIB, 2));
      clock.advance();
      await cache.writeAppearanceBlob(scope, "bulk-b.png", blob(THIRTY_MIB, 3));
      clock.advance();
      // Unpinned total is now 90 MiB (a+b+c) - forces an eviction among the
      // unpinned entries alone; "pinned.png" was never in that pool.
      await cache.writeAppearanceBlob(scope, "bulk-c.png", blob(THIRTY_MIB, 4));

      expect(await cache.readAppearanceBlob(null, "pinned.png")).not.toBeNull();
      expect(await cache.readAppearanceBlob(scope, "bulk-a.png")).toBeNull();
    } finally {
      clock.restore();
    }
  }, 20_000);

  it("unpins the previously pinned identity when a new one is pinned", async () => {
    const clock = useAdvancingClock();
    try {
      const { cache, authStore } = await loadAppearanceCache();
      signIn(authStore, "acct-1");
      const scope = {
        accountId: "acct-1",
        hostId: "host-1",
        canonicalSourceRoot: "/repo/root",
      };
      const THIRTY_MIB = 30 * 1024 * 1024;

      await cache.writeAppearanceBlob(null, "old.png", blob(THIRTY_MIB, 1));
      await cache.pinGlobalAppearanceBlob("old.png");
      clock.advance();
      await cache.writeAppearanceBlob(null, "new.png", blob(THIRTY_MIB, 2));
      await cache.pinGlobalAppearanceBlob("new.png");
      clock.advance();

      // "old.png" lost its pin and is now the OLDEST unpinned entry; two more
      // 30 MiB unpinned writes push the unpinned total to 90 MiB and evict it,
      // while "new.png" (the current pin, still excluded from the pool)
      // survives untouched.
      await cache.writeAppearanceBlob(scope, "bulk-a.png", blob(THIRTY_MIB, 3));
      clock.advance();
      await cache.writeAppearanceBlob(scope, "bulk-b.png", blob(THIRTY_MIB, 4));

      expect(await cache.readAppearanceBlob(null, "old.png")).toBeNull();
      expect(await cache.readAppearanceBlob(null, "new.png")).not.toBeNull();
    } finally {
      clock.restore();
    }
  }, 20_000);

  it("unpins everything when pinned with null", async () => {
    const clock = useAdvancingClock();
    try {
      const { cache, authStore } = await loadAppearanceCache();
      signIn(authStore, "acct-1");
      const scope = {
        accountId: "acct-1",
        hostId: "host-1",
        canonicalSourceRoot: "/repo/root",
      };
      const THIRTY_MIB = 30 * 1024 * 1024;

      await cache.writeAppearanceBlob(
        null,
        "was-pinned.png",
        blob(THIRTY_MIB, 1),
      );
      await cache.pinGlobalAppearanceBlob("was-pinned.png");
      await cache.pinGlobalAppearanceBlob(null);
      clock.advance();
      await cache.writeAppearanceBlob(scope, "bulk-a.png", blob(THIRTY_MIB, 2));
      clock.advance();
      await cache.writeAppearanceBlob(scope, "bulk-b.png", blob(THIRTY_MIB, 3));

      expect(await cache.readAppearanceBlob(null, "was-pinned.png")).toBeNull();
    } finally {
      clock.restore();
    }
  }, 20_000);

  it("rejects pinning an identity that was never written, leaving any existing pin untouched", async () => {
    const clock = useAdvancingClock();
    try {
      const { cache, authStore } = await loadAppearanceCache();
      signIn(authStore, "acct-1");
      await cache.writeAppearanceBlob(null, "kept.png", blob(1024, 1));
      await cache.pinGlobalAppearanceBlob("kept.png");

      // The cursor walk this issues would (if it committed) unpin "kept.png"
      // along the way, since it isn't the target - the abort must roll that
      // back too, atomically, not just leave `found` false.
      await expect(
        cache.pinGlobalAppearanceBlob("never-written.png"),
      ).rejects.toThrow();

      const scope = {
        accountId: "acct-1",
        hostId: "host-1",
        canonicalSourceRoot: "/repo/root",
      };
      const THIRTY_MIB = 30 * 1024 * 1024;
      await cache.writeAppearanceBlob(scope, "bulk-a.png", blob(THIRTY_MIB, 2));
      clock.advance();
      await cache.writeAppearanceBlob(scope, "bulk-b.png", blob(THIRTY_MIB, 3));
      clock.advance();
      // Unpinned total now 90 MiB - forces an eviction. If the failed pin
      // attempt HAD unpinned "kept.png", it would be the oldest unpinned
      // entry and get dropped here instead of surviving.
      await cache.writeAppearanceBlob(scope, "bulk-c.png", blob(THIRTY_MIB, 4));

      expect(await cache.readAppearanceBlob(null, "kept.png")).not.toBeNull();
    } finally {
      clock.restore();
    }
  }, 20_000);
});

describe("appearance-cache: account isolation and session guards", () => {
  it("discards an in-flight read whose result resolves after the account switches", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };
    await cache.writeAppearanceSnapshot(
      scope,
      appearanceRead({ canonicalSourceRoot: scope.canonicalSourceRoot }),
    );

    const pending = cache.readAppearanceSnapshot(scope);
    signIn(authStore, "acct-2");

    expect(await pending).toBeNull();
  });

  it("rejects a write for an account that is no longer the signed-in one", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    signIn(authStore, "acct-2");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };

    await expect(
      cache.writeAppearanceSnapshot(
        scope,
        appearanceRead({ canonicalSourceRoot: scope.canonicalSourceRoot }),
      ),
    ).rejects.toThrow(/no longer active/);
  });

  it("captures a session token that a later account switch invalidates", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const session = cache.captureAppearanceSession();
    expect(session.isCurrent("acct-1")).toBe(true);

    signIn(authStore, "acct-2");
    expect(session.isCurrent("acct-1")).toBe(false);
  });

  it("invalidates a captured session across a sign-out and sign-back-in to the SAME account", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const session = cache.captureAppearanceSession();

    signOut(authStore);
    signIn(authStore, "acct-1");

    expect(session.isCurrent("acct-1")).toBe(false);
  });

  it("keeps a global (accountId null) session current across account switches, but not across a wipe", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const session = cache.captureAppearanceSession();

    signIn(authStore, "acct-2");
    expect(session.isCurrent(null)).toBe(true);

    await cache.clearAppearanceCache();
    expect(session.isCurrent(null)).toBe(false);
  });
});

describe("appearance-cache: removal and wipe", () => {
  it("removes a single blob without disturbing others", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };
    await cache.writeAppearanceBlob(scope, "keep.png", blob(1024, 1));
    await cache.writeAppearanceBlob(scope, "drop.png", blob(1024, 2));

    await cache.removeAppearanceBlob(scope, "drop.png");

    expect(await cache.readAppearanceBlob(scope, "drop.png")).toBeNull();
    expect(await cache.readAppearanceBlob(scope, "keep.png")).not.toBeNull();
  });

  it("clears every entry and permanently locks the module out of further reads/writes (production reloads after this)", async () => {
    const { cache, authStore } = await loadAppearanceCache();
    signIn(authStore, "acct-1");
    const scope = {
      accountId: "acct-1",
      hostId: "host-1",
      canonicalSourceRoot: "/repo/root",
    };
    await cache.writeAppearanceSnapshot(
      scope,
      appearanceRead({ canonicalSourceRoot: scope.canonicalSourceRoot }),
    );

    await cache.clearAppearanceCache();

    expect(await cache.readAppearanceSnapshot(scope)).toBeNull();
    await expect(
      cache.writeAppearanceSnapshot(
        scope,
        appearanceRead({ canonicalSourceRoot: scope.canonicalSourceRoot }),
      ),
    ).rejects.toThrow(/no longer active/);
  });
});
