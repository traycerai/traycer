import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserCatalogRecord,
  BrowserCatalogSnapshot,
  BrowserOwnerInventoryEvidence,
} from "@traycer/protocol/host/browser/catalog-contracts";
import type { BrowserCatalogReadResponse } from "@traycer/protocol/host/browser/discovery-contracts";
import {
  BrowserCatalogInventoryStore,
  type BrowserCatalogBackend,
  type BrowserCatalogScope,
} from "../browser-catalog-inventory";

const EPIC = "epic-1";
const scope: BrowserCatalogScope = { userId: "user-1", epicId: EPIC };

function record(
  hostId: string,
  sessionId: string,
  inventoryRevision: number,
): BrowserCatalogRecord {
  return {
    epicId: EPIC,
    hostId,
    sessionId,
    inventoryRevision,
    lastActivityAt: 1,
    tabs: [{ tabId: "tab-1", title: null, url: "https://example.test" }],
  };
}

function liveEvidence(
  hostId: string,
  sessionId: string,
  rev: number,
): BrowserOwnerInventoryEvidence {
  return { kind: "live", record: record(hostId, sessionId, rev) };
}

function deletedEvidence(
  hostId: string,
  sessionId: string,
  rev: number,
): BrowserOwnerInventoryEvidence {
  return {
    kind: "deleted",
    deletion: { epicId: EPIC, hostId, sessionId, inventoryRevision: rev },
  };
}

function fence(hostId: string, sessionId: string, rev: number) {
  return {
    kind: "fenced" as const,
    epicId: EPIC,
    hostId,
    sessionId,
    inventoryRevision: rev,
  };
}

function noFence(hostId: string, sessionId: string) {
  return { kind: "no-fence" as const, epicId: EPIC, hostId, sessionId };
}

interface SnapshotParts {
  readonly records: readonly BrowserCatalogRecord[];
  readonly fences: BrowserCatalogSnapshot["fences"];
  readonly revokedHostIds: readonly string[];
}

interface EvidenceParts {
  readonly fences: BrowserCatalogSnapshot["fences"];
}

function snapshot(
  version: number,
  parts: SnapshotParts,
): BrowserCatalogReadResponse {
  return {
    kind: "available",
    snapshot: {
      kind: "snapshot",
      version,
      records: [...parts.records],
      fences: [...parts.fences],
      readiness: [],
      revokedHostIds: [...parts.revokedHostIds],
    },
  };
}

function notModified(
  version: number,
  parts: EvidenceParts,
): BrowserCatalogReadResponse {
  return {
    kind: "available",
    snapshot: {
      kind: "not-modified",
      version,
      fences: [...parts.fences],
      readiness: [],
      revokedHostIds: [],
    },
  };
}

function evidenceOnly(
  headVersion: number,
  parts: EvidenceParts,
): BrowserCatalogReadResponse {
  return {
    kind: "available",
    snapshot: {
      kind: "evidence",
      headVersion,
      fences: [...parts.fences],
      readiness: [],
      revokedHostIds: [],
    },
  };
}

/** Stored state is shared across store instances; updater transactions run one at a time. */
function memoryBackend(
  shared: Map<string, unknown>,
  writes: unknown[],
): BrowserCatalogBackend {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read: (key) => Promise.resolve(shared.get(key)),
    change: (key, apply) => {
      const run = queue.then(() => {
        const next = apply(shared.get(key));
        shared.set(key, next);
        writes.push(structuredClone(next));
        return next;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    clear: () => {
      shared.clear();
      return Promise.resolve();
    },
  };
}

async function openStore(shared: Map<string, unknown>, writes: unknown[]) {
  const store = new BrowserCatalogInventoryStore(memoryBackend(shared, writes));
  await store.load(scope);
  return store;
}

function revisionOf(
  store: BrowserCatalogInventoryStore,
  hostId: string,
  sessionId: string,
): number | undefined {
  return store
    .read(scope)
    .records.find(
      (entry) => entry.hostId === hostId && entry.sessionId === sessionId,
    )?.inventoryRevision;
}

describe("browser catalog inventory", () => {
  let shared: Map<string, unknown>;
  beforeEach(() => {
    shared = new Map();
  });

  describe("owner evidence versus a stale catalog", () => {
    it("keeps owner live revision 12 over catalog revision 11, across restart", async () => {
      const store = await openStore(shared, []);
      await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);
      await store.accept(
        scope,
        snapshot(5, {
          records: [record("B", "s1", 11)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );

      expect(revisionOf(store, "B", "s1")).toBe(12);
      expect(store.read(scope).pendingCount).toBe(1);

      const restarted = await openStore(shared, []);
      expect(revisionOf(restarted, "B", "s1")).toBe(12);
      expect(restarted.read(scope).pendingCount).toBe(1);
    });

    it("keeps an owner removal at revision 12 hidden when the catalog still lists revision 11", async () => {
      const store = await openStore(shared, []);
      await store.owner(scope, "B", [deletedEvidence("B", "s1", 12)]);
      await store.accept(
        scope,
        snapshot(5, {
          records: [record("B", "s1", 11)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );

      expect(store.read(scope).records).toEqual([]);

      const restarted = await openStore(shared, []);
      expect(restarted.read(scope).records).toEqual([]);
    });

    it("does not let a late owner save resurrect a fenced session", async () => {
      const store = await openStore(shared, []);
      await store.accept(
        scope,
        snapshot(5, {
          fences: [fence("B", "s1", 12)],
          records: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );
      await store.owner(scope, "B", [liveEvidence("B", "s1", 13)]);

      expect(store.read(scope).records).toEqual([]);
    });
  });

  describe("retiring the journal", () => {
    it("retires an overlay once the catalog carries a revision at or above it, and ignores an older replay", async () => {
      const store = await openStore(shared, []);
      await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);
      await store.accept(
        scope,
        snapshot(6, {
          records: [record("B", "s1", 12)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );

      expect(store.read(scope).pendingCount).toBe(0);
      expect(revisionOf(store, "B", "s1")).toBe(12);

      await store.accept(
        scope,
        snapshot(5, {
          records: [record("B", "s1", 11)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );
      expect(revisionOf(store, "B", "s1")).toBe(12);
      expect(store.read(scope).version).toBe(6);

      const restarted = await openStore(shared, []);
      expect(revisionOf(restarted, "B", "s1")).toBe(12);
      expect(restarted.read(scope).pendingCount).toBe(0);
    });

    it("retires a deletion on an explicit fence at the same head, but not on no-fence", async () => {
      const store = await openStore(shared, []);
      await store.accept(
        scope,
        snapshot(5, {
          records: [record("B", "s1", 11)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );
      await store.owner(scope, "B", [deletedEvidence("B", "s1", 12)]);

      await store.accept(
        scope,
        notModified(5, { fences: [noFence("B", "s1")] }),
        store.epoch(scope),
      );
      expect(store.read(scope).pendingCount).toBe(1);
      expect(store.read(scope).records).toEqual([]);

      await store.accept(
        scope,
        notModified(5, { fences: [fence("B", "s1", 12)] }),
        store.epoch(scope),
      );
      expect(store.read(scope).pendingCount).toBe(0);
      expect(store.read(scope).records).toEqual([]);

      const restarted = await openStore(shared, []);
      expect(restarted.read(scope).pendingCount).toBe(0);
      expect(restarted.read(scope).records).toEqual([]);
    });

    it("persists the covering evidence in the same write that retires the journal entry", async () => {
      const writes: unknown[] = [];
      const store = await openStore(shared, writes);
      await store.owner(scope, "B", [
        deletedEvidence("B", "s1", 12),
        liveEvidence("B", "s2", 7),
      ]);
      await store.accept(
        scope,
        snapshot(9, {
          records: [record("B", "s2", 8)],
          fences: [fence("B", "s1", 12)],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );

      const seen = new Set<string>();
      for (const written of writes) {
        const data = written as {
          catalog: BrowserOwnerInventoryEvidence[];
          journal: BrowserOwnerInventoryEvidence[];
        };
        const inJournal = (id: string) =>
          data.journal.some(
            (entry) =>
              (entry.kind === "live"
                ? entry.record.sessionId
                : entry.deletion.sessionId) === id,
          );
        const inCatalog = (id: string) =>
          data.catalog.some(
            (entry) =>
              (entry.kind === "live"
                ? entry.record.sessionId
                : entry.deletion.sessionId) === id,
          );
        for (const id of ["s1", "s2"]) {
          if (inJournal(id) || inCatalog(id)) seen.add(id);
        }
        for (const id of seen)
          expect(inJournal(id) || inCatalog(id)).toBe(true);
      }
      expect(store.read(scope).pendingCount).toBe(0);
    });
  });

  describe("identity isolation", () => {
    it("keeps a reused session id from two owners apart", async () => {
      const store = await openStore(shared, []);
      await store.owner(scope, "A", [liveEvidence("A", "s1", 3)]);
      await store.owner(scope, "B", [deletedEvidence("B", "s1", 5)]);
      await store.accept(
        scope,
        snapshot(2, {
          records: [record("B", "s1", 4)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );

      expect(revisionOf(store, "A", "s1")).toBe(3);
      expect(revisionOf(store, "B", "s1")).toBeUndefined();
      expect(
        store
          .probes(scope)
          .map((p) => p.hostId)
          .sort(),
      ).toEqual(["A", "B"]);
    });

    it("rejects evidence that does not belong to the stated owner or task", async () => {
      const store = await openStore(shared, []);
      await expect(
        store.owner(scope, "A", [liveEvidence("B", "s1", 1)]),
      ).rejects.toThrow();
    });

    it("keeps two callers on the same task apart", async () => {
      const store = await openStore(shared, []);
      const other: BrowserCatalogScope = { userId: "user-2", epicId: EPIC };
      await store.load(other);
      await store.owner(scope, "A", [liveEvidence("A", "s1", 3)]);

      expect(store.read(other).records).toEqual([]);
      await store.purge(other);
      expect(revisionOf(store, "A", "s1")).toBe(3);
    });
  });

  describe("access outcomes", () => {
    it.each(["inaccessible", "local-only"] as const)(
      "%s hides and clears rows and the journal, and refuses new evidence",
      async (kind) => {
        const store = await openStore(shared, []);
        await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);
        await store.accept(
          scope,
          snapshot(5, {
            records: [record("A", "s2", 1)],
            fences: [],
            revokedHostIds: [],
          }),
          store.epoch(scope),
        );

        await store.accept(scope, { kind }, store.epoch(scope));

        expect(store.read(scope).status).toBe(kind);
        expect(store.read(scope).records).toEqual([]);
        expect(store.read(scope).pendingCount).toBe(0);
        expect(store.probes(scope)).toEqual([]);
        await expect(
          store.owner(scope, "B", [liveEvidence("B", "s1", 13)]),
        ).rejects.toThrow();

        const restarted = await openStore(shared, []);
        expect(restarted.read(scope).records).toEqual([]);
        expect(restarted.read(scope).pendingCount).toBe(0);
      },
    );

    it("purges stored rows from a store that never hydrated the scope", async () => {
      const writer = await openStore(shared, []);
      await writer.owner(scope, "B", [liveEvidence("B", "s1", 12)]);

      const cold = new BrowserCatalogInventoryStore(memoryBackend(shared, []));
      await cold.purge(scope);

      const restarted = await openStore(shared, []);
      expect(restarted.read(scope).records).toEqual([]);
      expect(restarted.read(scope).pendingCount).toBe(0);
    });

    it("restores visibility from a response carrying the post-purge epoch, without the old overlay", async () => {
      const store = await openStore(shared, []);
      await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);
      await store.purge(scope);
      await store.accept(
        scope,
        snapshot(1, {
          records: [record("A", "s2", 1)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );

      expect(store.read(scope).status).toBe("available");
      expect(store.read(scope).records.map((r) => r.sessionId)).toEqual(["s2"]);
    });

    it("rejects a response captured before a purge and leaves the task hidden", async () => {
      const store = await openStore(shared, []);
      const staleEpoch = store.epoch(scope);
      await store.purge(scope);

      await expect(
        store.accept(
          scope,
          snapshot(9, {
            records: [record("A", "s2", 1)],
            fences: [],
            revokedHostIds: [],
          }),
          staleEpoch,
        ),
      ).rejects.toThrow();
      expect(store.read(scope).records).toEqual([]);
      expect(store.read(scope).status).toBe("inaccessible");
    });

    it("keeps authorized stale rows visible through a transient unavailable outcome", async () => {
      const store = await openStore(shared, []);
      await store.accept(
        scope,
        snapshot(5, {
          records: [record("A", "s1", 2)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );
      await store.accept(
        scope,
        { kind: "unavailable", reason: "cloud" },
        store.epoch(scope),
      );

      expect(store.read(scope).status).toBe("unavailable");
      expect(revisionOf(store, "A", "s1")).toBe(2);
    });

    it("hides rows for an unsupported peer without discarding the journal", async () => {
      const store = await openStore(shared, []);
      await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);
      await store.accept(scope, { kind: "unsupported" }, store.epoch(scope));

      expect(store.read(scope).records).toEqual([]);
      const restarted = await openStore(shared, []);
      expect(revisionOf(restarted, "B", "s1")).toBe(12);
    });

    it("drops rows, journal and readiness of a revoked owner", async () => {
      const store = await openStore(shared, []);
      await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);
      await store.accept(
        scope,
        snapshot(5, {
          records: [record("A", "s2", 1), record("B", "s3", 1)],
          revokedHostIds: ["B"],
          fences: [],
        }),
        store.epoch(scope),
      );

      expect(store.read(scope).records.map((r) => r.hostId)).toEqual(["A"]);
      expect(store.read(scope).pendingCount).toBe(0);
    });
  });

  describe("evidence-only reads", () => {
    it("never advance the live version or add live rows, yet still apply fences", async () => {
      const store = await openStore(shared, []);
      await store.accept(
        scope,
        snapshot(5, {
          records: [record("B", "s1", 11)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );
      await store.owner(scope, "B", [deletedEvidence("B", "s1", 12)]);

      await store.accept(
        scope,
        evidenceOnly(99, { fences: [fence("B", "s1", 12)] }),
        store.epoch(scope),
      );

      expect(store.read(scope).version).toBe(5);
      expect(store.read(scope).pendingCount).toBe(0);
      expect(store.read(scope).status).toBe("available");
    });

    it("leave a never-synced inventory without a version", async () => {
      const store = await openStore(shared, []);
      await store.accept(
        scope,
        evidenceOnly(40, { fences: [] }),
        store.epoch(scope),
      );
      expect(store.read(scope).version).toBeNull();
    });

    it("ignore live rows from a snapshot older than the cached head but still apply its fences", async () => {
      const store = await openStore(shared, []);
      await store.accept(
        scope,
        snapshot(8, {
          records: [record("A", "s1", 1)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );
      await store.accept(
        scope,
        snapshot(4, {
          records: [record("A", "s9", 1)],
          fences: [fence("A", "s1", 2)],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );

      expect(store.read(scope).records).toEqual([]);
      expect(store.read(scope).version).toBe(8);
    });
  });

  describe("probes", () => {
    it("name cached-only owners as well as pending journal identities", async () => {
      const store = await openStore(shared, []);
      await store.accept(
        scope,
        snapshot(5, {
          records: [record("A", "s1", 2)],
          fences: [],
          revokedHostIds: [],
        }),
        store.epoch(scope),
      );
      await store.owner(scope, "B", [liveEvidence("B", "s2", 3)]);

      expect(store.probes(scope)).toEqual(
        expect.arrayContaining([
          { epicId: EPIC, hostId: "A", sessionId: "s1" },
          { epicId: EPIC, hostId: "B", sessionId: "s2" },
        ]),
      );
    });
  });

  describe("clear", () => {
    it("empties every loaded scope and notifies subscribers", async () => {
      const store = await openStore(shared, []);
      await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);
      const listener = vi.fn();
      store.subscribe(listener);

      await store.clear();

      expect(listener).toHaveBeenCalled();
      expect(store.read(scope).records).toEqual([]);
      await store.load(scope);
      expect(store.read(scope).records).toEqual([]);
    });

    interface ClearGate {
      failing: boolean;
    }

    /** A clear that fails leaves the stored rows exactly where they were. */
    function gatedClearBackend(
      stored: Map<string, unknown>,
      gate: ClearGate,
    ): BrowserCatalogBackend {
      const base = memoryBackend(stored, []);
      return {
        ...base,
        clear: () =>
          gate.failing
            ? Promise.reject(new Error("clear failed"))
            : base.clear(),
      };
    }

    it("rejects a failed clear, empties memory, and never lets the old stored rows back in while clearing still fails", async () => {
      const gate: ClearGate = { failing: true };
      const store = new BrowserCatalogInventoryStore(
        gatedClearBackend(shared, gate),
      );
      await store.load(scope);
      await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);

      await expect(store.clear()).rejects.toThrow("clear failed");
      expect(store.read(scope).records).toEqual([]);
      expect(shared.size).toBe(1);

      await store.load(scope).catch(() => undefined);
      expect(store.read(scope).records).toEqual([]);
      expect(store.read(scope).pendingCount).toBe(0);

      // `read` recreated the entry, so rehydrate walks it: a path distinct from load.
      await expect(store.rehydrate()).rejects.toThrow("clear failed");
      expect(store.read(scope).records).toEqual([]);

      // Private writes cannot slip past the required clear either.
      await expect(
        store.accept(
          scope,
          snapshot(9, {
            records: [record("A", "s9", 1)],
            fences: [],
            revokedHostIds: [],
          }),
          store.epoch(scope),
        ),
      ).rejects.toThrow();
      await expect(
        store.owner(scope, "B", [liveEvidence("B", "s2", 3)]),
      ).rejects.toThrow();
      expect(store.read(scope).records).toEqual([]);
      expect(shared.size).toBe(1);

      gate.failing = false;
      await store.clear();
      expect(shared.size).toBe(0);
      expect(store.read(scope).records).toEqual([]);
    });

    it("retries the pending clear before the next load once the backend recovers, so the old rows are never read", async () => {
      const gate: ClearGate = { failing: true };
      const store = new BrowserCatalogInventoryStore(
        gatedClearBackend(shared, gate),
      );
      await store.load(scope);
      await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);
      await expect(store.clear()).rejects.toThrow("clear failed");

      gate.failing = false;
      await store.load(scope);

      // The load may persist a fresh empty row; the old private row must be gone.
      expect(JSON.stringify([...shared.values()])).not.toContain('"s1"');
      expect(store.read(scope).records).toEqual([]);
      expect(store.read(scope).pendingCount).toBe(0);
    });
  });
});

describe("browser catalog inventory on IndexedDB", () => {
  const idbScope: BrowserCatalogScope = { userId: "idb-user", epicId: EPIC };

  async function freshModule() {
    vi.resetModules();
    return import("../browser-catalog-inventory");
  }

  it("survives a module reload, and a clear invalidates the stored rows for every later load", async () => {
    const first = await freshModule();
    await first.browserCatalogInventory.load(idbScope);
    await first.browserCatalogInventory.owner(idbScope, "B", [
      liveEvidence("B", "s1", 12),
    ]);
    await first.browserCatalogInventory.accept(
      idbScope,
      snapshot(5, {
        records: [record("B", "s1", 11)],
        fences: [],
        revokedHostIds: [],
      }),
      first.browserCatalogInventory.epoch(idbScope),
    );

    const restarted = await freshModule();
    await restarted.browserCatalogInventory.load(idbScope);
    expect(
      restarted.browserCatalogInventory
        .read(idbScope)
        .records.map((r) => r.inventoryRevision),
    ).toEqual([12]);
    expect(restarted.browserCatalogInventory.read(idbScope).pendingCount).toBe(
      1,
    );

    const staleEpoch = restarted.browserCatalogInventory.epoch(idbScope);
    await restarted.browserCatalogInventory.clear();

    const afterClear = await freshModule();
    await afterClear.browserCatalogInventory.load(idbScope);
    expect(afterClear.browserCatalogInventory.read(idbScope).records).toEqual(
      [],
    );
    expect(afterClear.browserCatalogInventory.read(idbScope).status).toBe(
      "inaccessible",
    );
    expect(afterClear.browserCatalogInventory.epoch(idbScope)).toBeGreaterThan(
      staleEpoch,
    );
  });
});
