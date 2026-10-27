import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_CATALOG_MAX_PROBES,
  type BrowserCatalogReadRequest,
  type BrowserOwnerInventoryEvidence,
} from "@traycer/protocol/host/browser/catalog-contracts";
import type { BrowserCatalogReadResponse } from "@traycer/protocol/host/browser/discovery-contracts";
import {
  BrowserCatalogInventoryStore,
  type BrowserCatalogBackend,
  type BrowserCatalogScope,
} from "../browser-catalog-inventory";
import {
  BrowserCatalogDiscovery,
  type BrowserCatalogReader,
} from "../browser-catalog-discovery";

const EPIC = "epic-1";
const scope: BrowserCatalogScope = { userId: "user-1", epicId: EPIC };

function liveEvidence(
  hostId: string,
  sessionId: string,
  rev: number,
): BrowserOwnerInventoryEvidence {
  return {
    kind: "live",
    record: {
      epicId: EPIC,
      hostId,
      sessionId,
      inventoryRevision: rev,
      lastActivityAt: 1,
      tabs: [{ tabId: "tab-1", title: null, url: "https://example.test" }],
    },
  };
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

interface Fenced {
  readonly kind: "fenced";
  readonly epicId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly inventoryRevision: number;
}

function fenced(hostId: string, sessionId: string, rev: number): Fenced {
  return {
    kind: "fenced" as const,
    epicId: EPIC,
    hostId,
    sessionId,
    inventoryRevision: rev,
  };
}

function snapshotAt(
  version: number,
  records: BrowserOwnerInventoryEvidence[],
  fences: readonly Fenced[],
): BrowserCatalogReadResponse {
  return {
    kind: "available",
    snapshot: {
      kind: "snapshot",
      version,
      records: records.flatMap((entry) =>
        entry.kind === "live" ? [entry.record] : [],
      ),
      fences: [...fences],
      readiness: [],
      revokedHostIds: [],
    },
  };
}

function notModifiedAt(
  version: number,
  fences: readonly Fenced[],
): BrowserCatalogReadResponse {
  return {
    kind: "available",
    snapshot: {
      kind: "not-modified",
      version,
      fences: [...fences],
      readiness: [],
      revokedHostIds: [],
    },
  };
}

function evidenceAt(
  headVersion: number,
  fences: readonly Fenced[],
): BrowserCatalogReadResponse {
  return {
    kind: "available",
    snapshot: {
      kind: "evidence",
      headVersion,
      fences: [...fences],
      readiness: [],
      revokedHostIds: [],
    },
  };
}

function memoryBackend(shared: Map<string, unknown>): BrowserCatalogBackend {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read: (key) => Promise.resolve(shared.get(key)),
    change: (key, apply) => {
      const run = queue.then(() => {
        const next = apply(shared.get(key));
        shared.set(key, next);
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

type ReadFn = (
  request: BrowserCatalogReadRequest,
  signal: AbortSignal,
) => Promise<BrowserCatalogReadResponse>;

function readerOf(read: ReadFn): {
  reader: BrowserCatalogReader;
  calls: BrowserCatalogReadRequest[];
} {
  const calls: BrowserCatalogReadRequest[] = [];
  return {
    calls,
    reader: {
      read: (request, signal) => {
        calls.push(request);
        return read(request, signal);
      },
    },
  };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("browser catalog discovery", () => {
  let shared: Map<string, unknown>;
  let store: BrowserCatalogInventoryStore;
  let discovery: BrowserCatalogDiscovery;

  beforeEach(() => {
    vi.useFakeTimers();
    shared = new Map();
    store = new BrowserCatalogInventoryStore(memoryBackend(shared));
    discovery = new BrowserCatalogDiscovery(scope, store);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one repair loop for several canvases and reads through the newest reader only", async () => {
    const first = readerOf(() => Promise.resolve(snapshotAt(1, [], [])));
    const second = readerOf(() => Promise.resolve(snapshotAt(1, [], [])));
    const releaseFirst = discovery.acquire(first.reader);
    const releaseSecond = discovery.acquire(second.reader);

    await advance(0);

    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(1);
    releaseFirst();
    releaseSecond();
  });

  it("keeps an owner's revision 12 through last-viewer release and reader replacement, then retires it on a same-head fence", async () => {
    await store.load(scope);
    await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);

    const stale = readerOf(() =>
      Promise.resolve(snapshotAt(5, [liveEvidence("B", "s1", 11)], [])),
    );
    const releaseA = discovery.acquire(stale.reader);
    await advance(0);

    expect(stale.calls[0]?.fenceProbes).toEqual([
      { epicId: EPIC, hostId: "B", sessionId: "s1" },
    ]);
    releaseA();
    expect(store.read(scope).records.map((r) => r.inventoryRevision)).toEqual([
      12,
    ]);

    const replacement = readerOf(() =>
      Promise.resolve(snapshotAt(5, [liveEvidence("B", "s1", 11)], [])),
    );
    const releaseB = discovery.acquire(replacement.reader);
    await advance(5_000);

    expect(replacement.calls).toHaveLength(1);
    expect(replacement.calls[0]?.ifVersion).toBe(5);
    expect(replacement.calls[0]?.fenceProbes).toEqual([
      { epicId: EPIC, hostId: "B", sessionId: "s1" },
    ]);
    expect(store.read(scope).records.map((r) => r.inventoryRevision)).toEqual([
      12,
    ]);
    releaseB();

    const covering = readerOf(() =>
      Promise.resolve(notModifiedAt(5, [fenced("B", "s1", 13)])),
    );
    const releaseC = discovery.acquire(covering.reader);
    await advance(5_000);

    expect(covering.calls[0]?.ifVersion).toBe(5);
    expect(store.read(scope).pendingCount).toBe(0);
    expect(store.read(scope).records).toEqual([]);
    releaseC();
  });

  it("carries every probe of an oversized journal through evidence-only batches", async () => {
    const count = BROWSER_CATALOG_MAX_PROBES * 2 + 50;
    await store.load(scope);
    await store.owner(
      scope,
      "B",
      Array.from({ length: count }, (_, i) => liveEvidence("B", `s${i}`, 1)),
    );

    let reads = 0;
    const { reader, calls } = readerOf(() =>
      Promise.resolve(
        ++reads === 1 ? snapshotAt(1, [], []) : evidenceAt(1, []),
      ),
    );
    const release = discovery.acquire(reader);
    await advance(0);
    release();

    expect(calls.map((call) => call.fenceProbes.length)).toEqual([
      BROWSER_CATALOG_MAX_PROBES,
      BROWSER_CATALOG_MAX_PROBES,
      50,
    ]);
    expect(calls.map((call) => call.evidenceOnly)).toEqual([
      undefined,
      true,
      true,
    ]);
    const probed = new Set(
      calls.flatMap((call) => call.fenceProbes.map((probe) => probe.sessionId)),
    );
    expect(probed.size).toBe(count);
  });

  it("continues a journal larger than one repair's batches on the next repair", async () => {
    const count = BROWSER_CATALOG_MAX_PROBES * 6;
    await store.load(scope);
    await store.owner(
      scope,
      "B",
      Array.from({ length: count }, (_, i) => liveEvidence("B", `s${i}`, 1)),
    );

    let reads = 0;
    const { reader, calls } = readerOf(() =>
      Promise.resolve(
        ++reads === 1 ? snapshotAt(1, [], []) : evidenceAt(1, []),
      ),
    );
    const release = discovery.acquire(reader);
    await advance(0);
    expect(calls).toHaveLength(5);

    await advance(31_000);
    release();

    const probed = new Set(
      calls.flatMap((call) => call.fenceProbes.map((probe) => probe.sessionId)),
    );
    expect(probed.size).toBe(count);
  });

  it("re-reads an inventory-limit answer as evidence-only so pending fences still reconcile", async () => {
    await store.load(scope);
    await store.owner(scope, "B", [deletedEvidence("B", "s1", 12)]);

    const { reader, calls } = readerOf((request) =>
      Promise.resolve<BrowserCatalogReadResponse>(
        request.evidenceOnly === true
          ? evidenceAt(9, [fenced("B", "s1", 12)])
          : { kind: "unavailable", reason: "inventory-limit" },
      ),
    );
    const release = discovery.acquire(reader);
    await advance(0);
    release();

    expect(calls.map((call) => call.evidenceOnly)).toEqual([undefined, true]);
    expect(store.read(scope).pendingCount).toBe(0);
    expect(store.read(scope).version).toBeNull();
  });

  it("keeps stale authorized rows when the reader fails", async () => {
    await store.load(scope);
    await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);

    const { reader } = readerOf(() => Promise.reject(new Error("relay down")));
    const release = discovery.acquire(reader);
    await advance(0);
    release();

    expect(store.read(scope).status).toBe("unavailable");
    expect(store.read(scope).records.map((r) => r.inventoryRevision)).toEqual([
      12,
    ]);
  });

  it("clears private rows when the reader reports the task inaccessible", async () => {
    await store.load(scope);
    await store.owner(scope, "B", [liveEvidence("B", "s1", 12)]);

    const { reader } = readerOf(() =>
      Promise.resolve<BrowserCatalogReadResponse>({ kind: "inaccessible" }),
    );
    const release = discovery.acquire(reader);
    await advance(0);
    release();

    expect(store.read(scope).records).toEqual([]);
    expect(store.read(scope).pendingCount).toBe(0);
  });

  it("stops polling once the last reader is released", async () => {
    const { reader, calls } = readerOf(() =>
      Promise.resolve(snapshotAt(1, [], [])),
    );
    const release = discovery.acquire(reader);
    await advance(0);
    release();
    await advance(120_000);

    expect(calls).toHaveLength(1);
  });
});
