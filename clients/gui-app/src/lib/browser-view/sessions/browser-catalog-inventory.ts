import { z } from "zod";
import { createStore, get, update, type UseStore } from "idb-keyval";
import {
  browserCatalogReadinessSchema,
  browserOwnerInventoryEvidenceSchema,
  type BrowserCatalogIdentity,
  type BrowserCatalogReadiness,
  type BrowserCatalogRecord,
  type BrowserCatalogSnapshot,
  type BrowserOwnerInventoryEvidence,
} from "@traycer/protocol/host/browser/catalog-contracts";
import type { BrowserCatalogReadResponse } from "@traycer/protocol/host/browser/discovery-contracts";
import { useAuthStore } from "@/stores/auth/auth-store";
import { installCrossWindowRehydrate } from "@/lib/persist/cross-window-rehydrate";
import { persistKey } from "@/lib/persist/keys";

export const BROWSER_CATALOG_DB_NAME = persistKey("browser-catalog-v1");

export interface BrowserCatalogScope {
  readonly userId: string;
  readonly epicId: string;
}

const durableSchema = z.object({
  epoch: z.number().int().nonnegative(),
  blocked: z.enum(["local-only", "inaccessible"]).nullable(),
  version: z.number().int().nonnegative().nullable(),
  catalog: z.array(browserOwnerInventoryEvidenceSchema),
  journal: z.array(browserOwnerInventoryEvidenceSchema),
  readiness: z.array(browserCatalogReadinessSchema),
  revokedHostIds: z.array(z.string()),
});
type DurableInventory = z.infer<typeof durableSchema>;

export type BrowserCatalogStatus =
  | "loading"
  | "cached"
  | "available"
  | "unavailable"
  | "local-only"
  | "inaccessible"
  | "unsupported";

export interface BrowserCatalogInventory {
  readonly status: BrowserCatalogStatus;
  readonly records: readonly BrowserCatalogRecord[];
  readonly readiness: readonly BrowserCatalogReadiness[];
  readonly version: number | null;
  readonly pendingCount: number;
  /** Permanent authority barrier, including when directory metadata still looks online. */
  readonly revokedHostIds: readonly string[];
}

/** The updater runs in the backend's read/write transaction, also across windows. */
export interface BrowserCatalogBackend {
  read(key: string): Promise<unknown>;
  change(
    key: string,
    apply: (value: unknown) => DurableInventory,
  ): Promise<DurableInventory>;
  clear(): Promise<void>;
}

function emptyInventory(): DurableInventory {
  return {
    epoch: 0,
    blocked: null,
    version: null,
    catalog: [],
    journal: [],
    readiness: [],
    revokedHostIds: [],
  };
}

function parseInventory(value: unknown, epicId: string): DurableInventory {
  const parsed = durableSchema.safeParse(value);
  if (!parsed.success) return emptyInventory();
  return {
    ...parsed.data,
    catalog: parsed.data.catalog.filter(
      (entry) => identity(entry).epicId === epicId,
    ),
    journal: parsed.data.journal.filter(
      (entry) => identity(entry).epicId === epicId,
    ),
  };
}

function identity(
  evidence: BrowserOwnerInventoryEvidence,
): BrowserCatalogIdentity & { readonly inventoryRevision: number } {
  return evidence.kind === "live" ? evidence.record : evidence.deletion;
}

function identityKey(value: BrowserCatalogIdentity): string {
  return JSON.stringify([value.hostId, value.sessionId]);
}

function scopeKey(scope: BrowserCatalogScope): string {
  return JSON.stringify([scope.userId, scope.epicId]);
}

function mergeEvidence(
  current: BrowserOwnerInventoryEvidence | undefined,
  next: BrowserOwnerInventoryEvidence,
): BrowserOwnerInventoryEvidence {
  if (current === undefined) return next;
  // A session id names one lifetime. A fence is permanent even against a delayed save.
  if (current.kind === "deleted" && next.kind === "live") return current;
  if (current.kind === "live" && next.kind === "deleted") return next;
  return identity(next).inventoryRevision > identity(current).inventoryRevision
    ? next
    : current;
}

function evidenceMap(
  entries: readonly BrowserOwnerInventoryEvidence[],
): Map<string, BrowserOwnerInventoryEvidence> {
  const map = new Map<string, BrowserOwnerInventoryEvidence>();
  for (const entry of entries) {
    const key = identityKey(identity(entry));
    map.set(key, mergeEvidence(map.get(key), entry));
  }
  return map;
}

function covered(
  overlay: BrowserOwnerInventoryEvidence,
  catalog: BrowserOwnerInventoryEvidence | undefined,
): boolean {
  if (catalog === undefined) return false;
  if (catalog.kind === "deleted") return true;
  return (
    overlay.kind === "live" &&
    catalog.record.inventoryRevision >= overlay.record.inventoryRevision
  );
}

function reconcile(data: DurableInventory): DurableInventory {
  const revoked = new Set(data.revokedHostIds);
  const catalog = evidenceMap(
    data.catalog.filter((entry) => !revoked.has(identity(entry).hostId)),
  );
  const journal = evidenceMap(
    data.journal.filter((entry) => !revoked.has(identity(entry).hostId)),
  );
  for (const [key, entry] of journal) {
    if (covered(entry, catalog.get(key))) journal.delete(key);
  }
  return {
    ...data,
    catalog: [...catalog.values()],
    journal: [...journal.values()],
  };
}

function applySnapshot(
  data: DurableInventory,
  snapshot: BrowserCatalogSnapshot,
): DurableInventory {
  const catalog = evidenceMap(data.catalog);
  const acceptsLive =
    snapshot.kind !== "evidence" &&
    (data.version === null || snapshot.version >= data.version);
  if (snapshot.kind === "snapshot" && acceptsLive) {
    for (const record of snapshot.records) {
      const key = identityKey(record);
      catalog.set(
        key,
        mergeEvidence(catalog.get(key), { kind: "live", record }),
      );
    }
  }
  for (const fence of snapshot.fences) {
    if (fence.kind !== "fenced") continue;
    const { kind: _kind, ...deletion } = fence;
    const key = identityKey(deletion);
    catalog.set(
      key,
      mergeEvidence(catalog.get(key), { kind: "deleted", deletion }),
    );
  }
  const readiness = new Map(
    data.readiness.map((entry) => [entry.hostId, entry]),
  );
  for (const entry of snapshot.readiness) {
    const current = readiness.get(entry.hostId);
    if (
      current === undefined ||
      entry.indexingRevision >= current.indexingRevision
    )
      readiness.set(entry.hostId, entry);
  }
  return reconcile({
    epoch: data.epoch,
    blocked: null,
    version: acceptsLive ? snapshot.version : data.version,
    catalog: [...catalog.values()],
    journal: data.journal,
    readiness: [...readiness.values()],
    revokedHostIds: [
      ...new Set([...data.revokedHostIds, ...snapshot.revokedHostIds]),
    ],
  });
}

function project(
  data: DurableInventory,
  status: BrowserCatalogStatus,
): BrowserCatalogInventory {
  const visible =
    status !== "inaccessible" &&
    status !== "local-only" &&
    status !== "unsupported";
  const merged = evidenceMap([...data.catalog, ...data.journal]);
  return {
    status,
    records: visible
      ? [...merged.values()].flatMap((entry) =>
          entry.kind === "live" ? [entry.record] : [],
        )
      : [],
    readiness: visible
      ? data.readiness.filter(
          (entry) => !data.revokedHostIds.includes(entry.hostId),
        )
      : [],
    version: data.version,
    pendingCount: data.journal.length,
    revokedHostIds: data.revokedHostIds,
  };
}

interface InventoryEntry {
  data: DurableInventory;
  state: BrowserCatalogInventory;
  loaded: Promise<void> | null;
  blocked: boolean;
  pendingPurge: {
    readonly reason: "local-only" | "inaccessible";
    readonly epoch: number;
    readonly issuedEpoch: number | null;
  } | null;
  purging: Promise<void> | null;
}

/** One private cache/journal per caller/task, independent of owner stream refcounts. */
export class BrowserCatalogInventoryStore {
  private readonly entries = new Map<string, InventoryEntry>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private clearing: Promise<void> | null = null;
  private clearRequired = false;

  constructor(private readonly backend: BrowserCatalogBackend) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private entry(scope: BrowserCatalogScope): InventoryEntry {
    const key = scopeKey(scope);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      const data = emptyInventory();
      entry = {
        data,
        state: project(data, "loading"),
        loaded: null,
        blocked: false,
        pendingPurge: null,
        purging: null,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  read(scope: BrowserCatalogScope): BrowserCatalogInventory {
    return this.entry(scope).state;
  }

  private publish(
    entry: InventoryEntry,
    data: DurableInventory,
    status: BrowserCatalogStatus,
  ): void {
    entry.data = data;
    entry.state = project(data, status);
    this.listeners.forEach((listener) => listener());
  }

  private flushClear(): Promise<void> {
    if (this.clearing !== null) return this.clearing;
    if (!this.clearRequired) return Promise.resolve();
    const run = Promise.resolve()
      .then(() => this.backend.clear())
      .then(() => {
        this.clearRequired = false;
      })
      .finally(() => {
        // Failed attempts may be retried, but private reads stay fenced until
        // one succeeds. Discarding the rejection alone would expose old rows.
        this.clearing = null;
      });
    this.clearing = run;
    return run;
  }

  private async flushPurge(
    scope: BrowserCatalogScope,
    entry: InventoryEntry,
  ): Promise<void> {
    const stamp = this.generation;
    await this.flushClear();
    while (entry.pendingPurge !== null) {
      if (entry.purging === null) {
        const pending = entry.pendingPurge;
        entry.purging = Promise.resolve()
          .then(async () => {
            const outcome = { applied: false };
            const next = await this.backend.change(scopeKey(scope), (raw) => {
              if (stamp !== this.generation)
                throw new Error("Browser inventory identity changed.");
              const data = parseInventory(raw, scope.epicId);
              if (
                pending.issuedEpoch !== null &&
                data.epoch > pending.issuedEpoch
              )
                return data;
              outcome.applied = true;
              return {
                ...emptyInventory(),
                epoch: Math.max(data.epoch + 1, pending.epoch),
                blocked: pending.reason,
              };
            });
            if (stamp !== this.generation)
              throw new Error("Browser inventory identity changed.");
            if (entry.pendingPurge !== pending) return;
            entry.pendingPurge = null;
            entry.blocked = next.blocked !== null;
            this.publish(entry, next, next.blocked ?? "cached");
            if (!outcome.applied)
              throw new Error("Browser inventory access changed.");
          })
          .finally(() => {
            // Keep the intent after a failed write: fallback outcomes and window
            // rehydration must not restore the private row left on disk.
            entry.purging = null;
          });
      }
      await entry.purging;
    }
  }

  private suppress(
    scope: BrowserCatalogScope,
    reason: "local-only" | "inaccessible",
    issuedEpoch: number | null,
  ): Promise<void> {
    const entry = this.entry(scope);
    if (issuedEpoch !== null && issuedEpoch !== entry.data.epoch)
      return Promise.reject(new Error("Browser inventory access changed."));
    const epoch = entry.data.epoch + 1;
    entry.pendingPurge = { reason, epoch, issuedEpoch };
    entry.blocked = true;
    this.publish(
      entry,
      { ...emptyInventory(), epoch, blocked: reason },
      reason,
    );
    return this.flushPurge(scope, entry);
  }

  async load(scope: BrowserCatalogScope): Promise<void> {
    const entry = this.entry(scope);
    if (entry.loaded !== null) return entry.loaded;
    const stamp = this.generation;
    const state = entry.state;
    entry.loaded = this.flushClear()
      .then(() => this.flushPurge(scope, entry))
      .then(() =>
        this.backend.change(scopeKey(scope), (raw) => {
          if (entry.pendingPurge !== null)
            throw new Error("Browser inventory access changed.");
          return parseInventory(raw, scope.epicId);
        }),
      )
      .then((raw) => {
        if (stamp !== this.generation || entry.state !== state) return;
        const data = reconcile(parseInventory(raw, scope.epicId));
        entry.blocked = data.blocked !== null;
        this.publish(entry, data, data.blocked ?? "cached");
      })
      .catch((error: unknown) => {
        entry.loaded = null;
        throw error;
      });
    return entry.loaded;
  }

  epoch(scope: BrowserCatalogScope): number {
    return this.entry(scope).data.epoch;
  }

  async rehydrate(): Promise<void> {
    const generation = this.generation;
    await this.flushClear();
    if (generation !== this.generation) return;
    await Promise.all(
      [...this.entries.keys()].map(async (key) => {
        const entry = this.entries.get(key);
        if (entry === undefined) return;
        const scope: unknown = JSON.parse(key);
        if (!Array.isArray(scope) || typeof scope[1] !== "string") return;
        if (typeof scope[0] !== "string") return;
        await this.flushPurge({ userId: scope[0], epicId: scope[1] }, entry);
        const stamp = this.generation;
        const state = entry.state;
        const raw = await this.backend.read(key);
        if (stamp !== this.generation || state !== entry.state) return;
        const data = reconcile(parseInventory(raw, scope[1]));
        entry.blocked = data.blocked !== null;
        this.publish(entry, data, data.blocked ?? "cached");
      }),
    );
  }

  probes(scope: BrowserCatalogScope): readonly BrowserCatalogIdentity[] {
    const data = this.entry(scope).data;
    // Include cached-only owners for revocation evidence, not just journal identities.
    return [
      ...evidenceMap([
        ...data.catalog.filter((entry) => entry.kind === "live"),
        ...data.journal,
      ]).values(),
    ].map((entry) => {
      const { epicId, hostId, sessionId } = identity(entry);
      return { epicId, hostId, sessionId };
    });
  }

  confirmsTabClosed(
    scope: BrowserCatalogScope,
    target: {
      readonly hostId: string;
      readonly sessionId: string;
      readonly tabId: string;
      readonly minimumRevision: number | null;
    },
  ): boolean {
    const { hostId, sessionId, tabId, minimumRevision } = target;
    const entry = this.entry(scope);
    if (entry.blocked) return false;
    const evidence = evidenceMap([
      ...entry.data.catalog,
      ...entry.data.journal,
    ]).get(identityKey({ epicId: scope.epicId, hostId, sessionId }));
    if (evidence === undefined) return false;
    return (
      evidence.kind === "deleted" ||
      (minimumRevision !== null &&
        evidence.record.inventoryRevision >= minimumRevision &&
        !evidence.record.tabs.some((tab) => tab.tabId === tabId))
    );
  }

  async owner(
    scope: BrowserCatalogScope,
    hostId: string,
    evidence: readonly BrowserOwnerInventoryEvidence[],
  ): Promise<void> {
    const stamp = this.generation;
    await this.load(scope);
    if (stamp !== this.generation)
      throw new Error("Browser inventory identity changed.");
    const entry = this.entry(scope);
    if (entry.blocked)
      throw new Error("Browser inventory is unavailable for this task.");
    for (const item of evidence) {
      const value = identity(item);
      if (value.epicId !== scope.epicId || value.hostId !== hostId)
        throw new Error("Browser inventory owner does not match.");
    }
    await this.change(
      scope,
      (data) => {
        if (data.blocked) throw new Error("Browser inventory access changed.");
        const journal = evidenceMap(data.journal);
        for (const item of evidence) {
          const key = identityKey(identity(item));
          journal.set(key, mergeEvidence(journal.get(key), item));
        }
        return reconcile({ ...data, journal: [...journal.values()] });
      },
      entry.state.status,
      this.epoch(scope),
    );
  }

  async accept(
    scope: BrowserCatalogScope,
    response: BrowserCatalogReadResponse,
    epoch: number,
  ): Promise<void> {
    const entry = this.entry(scope);
    if (response.kind === "inaccessible" || response.kind === "local-only") {
      await this.suppress(scope, response.kind, epoch);
      return;
    }
    if (response.kind !== "available") {
      await this.change(scope, (data) => data, response.kind, epoch);
      return;
    }
    const identities =
      response.snapshot.kind === "snapshot"
        ? [...response.snapshot.records, ...response.snapshot.fences]
        : response.snapshot.fences;
    if (identities.some((value) => value.epicId !== scope.epicId))
      throw new Error("Browser inventory task does not match.");
    await this.change(
      scope,
      (data) => applySnapshot(data, response.snapshot),
      response.snapshot.kind === "evidence" ? entry.state.status : "available",
      epoch,
    );
  }

  private async change(
    scope: BrowserCatalogScope,
    apply: (data: DurableInventory) => DurableInventory,
    status: BrowserCatalogStatus,
    epoch: number | null,
  ): Promise<void> {
    const entry = this.entry(scope);
    const stamp = this.generation;
    await this.flushClear();
    await this.flushPurge(scope, entry);
    const next = await this.backend.change(scopeKey(scope), (raw) => {
      if (stamp !== this.generation)
        throw new Error("Browser inventory identity changed.");
      if (entry.pendingPurge !== null)
        throw new Error("Browser inventory access changed.");
      const data = parseInventory(raw, scope.epicId);
      return epoch === null || data.epoch === epoch ? apply(data) : data;
    });
    if (stamp !== this.generation)
      throw new Error("Browser inventory identity changed.");
    if (entry.pendingPurge !== null)
      throw new Error("Browser inventory access changed.");
    if (next.epoch < entry.data.epoch)
      throw new Error("Browser inventory access changed.");
    entry.blocked = next.blocked !== null;
    this.publish(entry, next, next.blocked ?? status);
    if (
      epoch !== null &&
      next.epoch !== epoch &&
      status !== "inaccessible" &&
      status !== "local-only"
    )
      throw new Error("Browser inventory access changed.");
  }

  async purge(scope: BrowserCatalogScope): Promise<void> {
    await this.suppress(scope, "inaccessible", null);
  }

  async clear(): Promise<void> {
    this.generation += 1;
    this.clearRequired = true;
    this.entries.clear();
    this.listeners.forEach((listener) => listener());
    await this.flushClear();
  }
}

let database: UseStore | null = null;
function browserCatalogDatabase(): UseStore {
  if (database === null) {
    const opened = createStore(BROWSER_CATALOG_DB_NAME, "inventory");
    database = (mode, callback) =>
      opened(mode, (store) => {
        store.transaction.db.onversionchange = () => {
          store.transaction.db.close();
          database = null;
        };
        return callback(store);
      });
  }
  return database;
}

export const browserCatalogInventory = new BrowserCatalogInventoryStore({
  read: (key) => get<unknown>(key, browserCatalogDatabase()),
  change: async (key, apply) => {
    let next = emptyInventory();
    await update<unknown>(
      key,
      (raw) => {
        next = apply(raw);
        return next;
      },
      browserCatalogDatabase(),
    );
    notifyOtherWindows();
    return next;
  },
  clear: () => {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return browserCatalogDatabase()(
      "readwrite",
      (store) =>
        new Promise<void>((resolve, reject) => {
          const request = store.openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor === null) return;
            const parsed = durableSchema.safeParse(cursor.value);
            cursor.update({
              ...emptyInventory(),
              epoch: (parsed.success ? parsed.data.epoch : 0) + 1,
              blocked: "inaccessible",
            });
            cursor.continue();
          };
          store.transaction.oncomplete = () => {
            notifyOtherWindows();
            resolve();
          };
          store.transaction.onerror = () =>
            reject(
              store.transaction.error ??
                new Error("Could not clear browser inventory."),
            );
          store.transaction.onabort = () =>
            reject(
              store.transaction.error ??
                new Error("Could not clear browser inventory."),
            );
        }),
    );
  },
});

// The signal contains no inventory. Other windows re-read the same transactional store.
const CATALOG_CHANGE_KEY = persistKey("browser-catalog-change");
installCrossWindowRehydrate(
  { persist: { rehydrate: () => browserCatalogInventory.rehydrate() } },
  CATALOG_CHANGE_KEY,
);
function notifyOtherWindows(): void {
  try {
    window.localStorage.setItem(CATALOG_CHANGE_KEY, crypto.randomUUID());
  } catch {
    /* IndexedDB remains authoritative. */
  }
}

useAuthStore.subscribe((next, previous) => {
  const previousUser = previous.contextMetadata?.userId ?? null;
  const nextUser = next.contextMetadata?.userId ?? null;
  const retired = previousUser !== null && previousUser !== nextUser;
  const revoked =
    next.status === "unverified" &&
    next.cloudVerdictLoss === "account-unavailable" &&
    (previous.status !== "unverified" ||
      previous.cloudVerdictLoss !== next.cloudVerdictLoss);
  if (retired || revoked)
    void browserCatalogInventory.clear().catch(() => undefined);
});
