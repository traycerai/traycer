import { z } from "zod";
import {
  sameViewReplicaIdentity,
  viewReplicaKey,
  viewReplicaSlotKey,
  type ViewReplicaAddress,
  type ViewReplicaIdentity,
  type ViewReplicaSourceEpoch,
} from "./identity";
import {
  sameRowScope,
  viewReplicaRowScopeSchema,
  type ViewReplicaRowScope,
} from "./row-scope";
import type { ViewReplicaRow, ViewReplicaService } from "./service";

/**
 * The client replica tier: one durable store of the account-wide pages the
 * app paints before their serving tier answers (History, the notification
 * feed, the environment list).
 *
 * It is a RENDER-BEFORE-CONFIRM cache, which this client did not have before:
 * a cached page paints at once, stating that it is cached, and is replaced by
 * the serving tier's answer when that arrives. The fetch is never put in front
 * of the paint, and the paint never waits on the store either: a read answers
 * synchronously from memory, which {@link ViewReplicaStore.warm} fills at
 * startup, off the paint path. A read before warming is a miss.
 *
 * What makes a cached page safe to show:
 *
 * - IDENTITY. A page is keyed by every member of {@link ViewReplicaIdentity},
 *   account first. Any difference - another account, tier, request, source
 *   epoch or client canonical version - is a miss, never a down-projection.
 * - READ-YOUR-WRITE FLOOR. A confirmed write (a pin, a mark-read) raises the
 *   floor of its service; a page observed before the floor is a miss, so a
 *   stale page never visibly reverts what the person just did.
 * - ROW PROVENANCE. Every row carries the scope that authorized it, so losing
 *   a team withdraws that team's rows and keeps the page.
 * - EVICTION BY CLASS ({@link ViewReplicaEviction}): what an authority loss
 *   does to the replica depends on what was lost.
 */
export class ViewReplicaStore {
  readonly #backend: ViewReplicaBackend | null;
  readonly #records = new Map<string, ViewReplicaStoredRecord>();
  readonly #meta = new Map<string, ViewReplicaAccountMeta>();
  readonly #warm = new Set<string>();
  readonly #warming = new Map<string, Promise<void>>();
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #version = 0;
  #writes: Promise<void> = Promise.resolve();

  constructor(backend: ViewReplicaBackend | null) {
    this.#backend = backend;
  }

  /**
   * Loads the account's pages into memory. Called at startup, off the paint
   * path; reads miss until it resolves. A wipe while it runs discards it.
   */
  warm(accountId: string): Promise<void> {
    if (this.#warm.has(accountId)) return Promise.resolve();
    const pending = this.#warming.get(accountId);
    if (pending !== undefined) return pending;
    const generation = this.#generation;
    const loading = this.#load(accountId, generation).finally(() => {
      if (this.#warming.get(accountId) === loading) {
        this.#warming.delete(accountId);
      }
    });
    this.#warming.set(accountId, loading);
    return loading;
  }

  isWarm(accountId: string): boolean {
    return this.#warm.has(accountId);
  }

  /** The cached page at `address`, or `null`: a miss of any kind. */
  read<Page>(
    service: ViewReplicaService<Page>,
    address: ViewReplicaAddress,
  ): ViewReplicaHit<Page> | null {
    if (!this.#warm.has(address.accountId)) return null;
    const identity = this.identityFor(service, address);
    const record = this.#records.get(viewReplicaKey(identity));
    if (record === undefined) return null;
    if (!sameViewReplicaIdentity(record.identity, identity)) return null;
    const floor = this.#metaFor(address.accountId).floors[service.service];
    if (floor !== undefined && record.savedAt < floor) return null;
    const page = service.join(
      record.shell,
      record.rows.map((row) => row.value),
    );
    if (page === null) return null;
    return {
      page: service.asCached(page, record.withdrawnScopes),
      savedAt: record.savedAt,
      sourceGeneration: record.sourceGeneration,
      withdrawnScopes: record.withdrawnScopes,
    };
  }

  /**
   * Records the serving tier's answer. `observedAt` is when the request that
   * produced it was sent: a row of a scope withdrawn after that moment is
   * dropped, and a page observed before a confirmed write never paints.
   * An answer older than the held page by the source's generation stamp is
   * ignored.
   */
  write<Page>(
    service: ViewReplicaService<Page>,
    address: ViewReplicaAddress,
    page: Page,
    stamp: {
      readonly observedAt: number;
      readonly sourceGeneration: number | null;
    },
  ): void {
    const identity = this.identityFor(service, address);
    const key = viewReplicaKey(identity);
    const held = this.#records.get(key);
    if (
      held !== undefined &&
      held.sourceGeneration !== null &&
      stamp.sourceGeneration !== null &&
      stamp.sourceGeneration < held.sourceGeneration
    ) {
      return;
    }
    const meta = this.#metaFor(address.accountId);
    const parts = service.split(page);
    const rows = parts.rows.filter(
      (row) =>
        !meta.withdrawals.some(
          (withdrawal) =>
            withdrawal.at > stamp.observedAt &&
            sameRowScope(withdrawal.scope, row.scope),
        ),
    );
    const record: ViewReplicaStoredRecord = {
      version: 1,
      key,
      identity,
      shell: parts.shell,
      rows,
      withdrawnScopes: [],
      savedAt: stamp.observedAt,
      sourceGeneration: stamp.sourceGeneration,
    };
    // One slot holds one page: a page under a superseded epoch or canonical
    // version is unreachable once this one exists, so it goes now.
    const slot = viewReplicaSlotKey(address);
    const superseded = [...this.#records.values()]
      .filter(
        (candidate) =>
          candidate.key !== key &&
          viewReplicaSlotKey(candidate.identity) === slot,
      )
      .map((candidate) => candidate.key);
    for (const supersededKey of superseded) this.#records.delete(supersededKey);
    this.#records.set(key, record);
    this.#persist([record], superseded, null);
    this.#changed();
  }

  /**
   * The source epoch the serving tier reported. Pages cached under any other
   * epoch for that tier stop being readable.
   */
  observeSourceEpoch(
    accountId: string,
    servingTier: string,
    epoch: ViewReplicaSourceEpoch,
  ): void {
    const meta = this.#metaFor(accountId);
    const current = meta.epochs[servingTier];
    if (
      current !== undefined &&
      current.source === epoch.source &&
      current.value === epoch.value
    ) {
      return;
    }
    this.#setMeta({
      ...meta,
      epochs: { ...meta.epochs, [servingTier]: epoch },
    });
  }

  /**
   * A write to `service` was confirmed at `at`. Every page of that service
   * observed before it is a miss from now on.
   */
  noteConfirmedWrite(accountId: string, service: string, at: number): void {
    const meta = this.#metaFor(accountId);
    if ((meta.floors[service] ?? -1) >= at) return;
    this.#setMeta({ ...meta, floors: { ...meta.floors, [service]: at } });
  }

  /** Applies one authority loss. See {@link ViewReplicaEviction}. */
  evict(eviction: ViewReplicaEviction): Promise<void> {
    switch (eviction.kind) {
      case "transport-unavailable":
      case "credential-refused":
        return this.#writes;
      case "scope-withdrawn":
        this.#withdrawScope(eviction.accountId, eviction.scope, eviction.at);
        return this.#writes;
      case "account-refused":
        return this.#dropAccount(eviction.accountId);
      case "identity-retired":
        return this.#wipe();
    }
  }

  /** The full identity `address` resolves to now. */
  identityFor(
    service: { readonly canonicalVersion: string },
    address: ViewReplicaAddress,
  ): ViewReplicaIdentity {
    return {
      ...address,
      sourceEpoch:
        this.#metaFor(address.accountId).epochs[address.servingTier] ?? null,
      canonicalVersion: service.canonicalVersion,
    };
  }

  /** Fires after every change a read could observe; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Increments with every change; a snapshot for `useSyncExternalStore`. */
  version(): number {
    return this.#version;
  }

  /** Resolves when every queued disk write has settled. */
  drain(): Promise<void> {
    return this.#writes;
  }

  #withdrawScope(
    accountId: string,
    scope: ViewReplicaRowScope,
    at: number,
  ): void {
    const meta = this.#metaFor(accountId);
    const nextMeta: ViewReplicaAccountMeta = {
      ...meta,
      withdrawals: [...meta.withdrawals, { scope, at }],
    };
    this.#meta.set(accountId, nextMeta);
    const changed: ViewReplicaStoredRecord[] = [];
    for (const record of this.#records.values()) {
      if (record.identity.accountId !== accountId) continue;
      const rows = record.rows.filter((row) => !sameRowScope(row.scope, scope));
      if (rows.length === record.rows.length) continue;
      const withdrawn: ViewReplicaStoredRecord = {
        ...record,
        rows,
        withdrawnScopes: record.withdrawnScopes.some((held) =>
          sameRowScope(held, scope),
        )
          ? record.withdrawnScopes
          : [...record.withdrawnScopes, scope],
      };
      this.#records.set(record.key, withdrawn);
      changed.push(withdrawn);
    }
    this.#persist(changed, [], nextMeta);
    this.#changed();
  }

  #dropAccount(accountId: string): Promise<void> {
    for (const [key, record] of this.#records) {
      if (record.identity.accountId === accountId) this.#records.delete(key);
    }
    this.#meta.delete(accountId);
    this.#changed();
    const backend = this.#backend;
    if (backend === null) return this.#writes;
    return this.#enqueue(() => backend.deleteAccount(accountId));
  }

  /** Fences queued writes and in-flight warms, then clears everything. */
  #wipe(): Promise<void> {
    this.#generation += 1;
    this.#records.clear();
    this.#meta.clear();
    this.#warm.clear();
    this.#warming.clear();
    this.#changed();
    const backend = this.#backend;
    if (backend === null) return this.#writes;
    return this.#enqueue(() => backend.clear());
  }

  async #load(accountId: string, generation: number): Promise<void> {
    await this.#writes;
    const loaded =
      this.#backend === null
        ? { records: [], meta: null }
        : await this.#backend.load(accountId).catch(() => null);
    if (generation !== this.#generation) return;
    if (loaded !== null) {
      const meta = accountMetaSchema.safeParse(loaded.meta);
      if (meta.success && meta.data.accountId === accountId) {
        this.#meta.set(accountId, meta.data);
      }
      const corrupt: string[] = [];
      for (const raw of loaded.records) {
        const record = storedRecordSchema.safeParse(raw);
        if (
          !record.success ||
          record.data.identity.accountId !== accountId ||
          record.data.key !== viewReplicaKey(record.data.identity)
        ) {
          const key = rawKey(raw);
          if (key !== null) corrupt.push(key);
          continue;
        }
        // A page written in this session before the load finished is newer.
        if (!this.#records.has(record.data.key)) {
          this.#records.set(record.data.key, record.data);
        }
      }
      if (corrupt.length > 0) this.#persist([], corrupt, null);
    }
    this.#warm.add(accountId);
    this.#changed();
  }

  #metaFor(accountId: string): ViewReplicaAccountMeta {
    return (
      this.#meta.get(accountId) ?? {
        accountId,
        epochs: {},
        floors: {},
        withdrawals: [],
      }
    );
  }

  #setMeta(meta: ViewReplicaAccountMeta): void {
    this.#meta.set(meta.accountId, meta);
    this.#persist([], [], meta);
    this.#changed();
  }

  #persist(
    records: readonly ViewReplicaStoredRecord[],
    deleteKeys: readonly string[],
    meta: ViewReplicaAccountMeta | null,
  ): void {
    const backend = this.#backend;
    if (backend === null) return;
    if (records.length === 0 && deleteKeys.length === 0 && meta === null) {
      return;
    }
    const generation = this.#generation;
    void this.#enqueue(async () => {
      if (generation !== this.#generation) return;
      await backend.write(records, deleteKeys, meta);
    });
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    // A failed disk write leaves memory correct for this session; the next
    // write of the slot replaces it.
    const next = this.#writes.then(work, work).catch(() => undefined);
    this.#writes = next;
    return next;
  }

  #changed(): void {
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }
}

export interface ViewReplicaHit<Page> {
  /** The page as it paints: already marked as cached by its service. */
  readonly page: Page;
  readonly savedAt: number;
  readonly sourceGeneration: number | null;
  /** Scopes withdrawn from the page since it was written. */
  readonly withdrawnScopes: readonly ViewReplicaRowScope[];
}

/**
 * The five eviction classes. What an authority loss does to the replica
 * follows from what was lost, and only a confirmed loss removes anything:
 *
 * - `transport-unavailable` - the serving tier or authn could not be reached.
 *   KEEP: nothing about the person's authority changed, and the cached page
 *   is exactly what should paint while it is unreachable.
 * - `credential-refused` - a token was refused (400/401, including a
 *   `revocation_scope: user_epoch` "sign out everywhere"). KEEP: a statement
 *   about a credential, not about what the person may see; signing back in
 *   returns to the same pages.
 * - `scope-withdrawn` - a confirmed loss of one scope: a membership removed,
 *   or a 403/404 on a scope. WITHDRAW exactly that scope's rows from every
 *   page of the account, keep the pages, and fence answers observed before
 *   the loss so a late one cannot bring the rows back.
 * - `account-refused` - the account itself was refused (403/404 on the
 *   account). DROP the account's replica. Unlike the local, disk-served plane
 *   (which stays readable because refusing it is unenforceable), these pages
 *   exist on the device only by virtue of a cloud read the account no longer
 *   has.
 * - `identity-retired` - sign-out, a credentials file found deleted,
 *   tombstoned or owned by another user, or the person wiping local state.
 *   WIPE everything, fencing queued writes and in-flight loads.
 */
export type ViewReplicaEviction =
  | { readonly kind: "transport-unavailable" }
  | { readonly kind: "credential-refused" }
  | {
      readonly kind: "scope-withdrawn";
      readonly accountId: string;
      readonly scope: ViewReplicaRowScope;
      readonly at: number;
    }
  | { readonly kind: "account-refused"; readonly accountId: string }
  | { readonly kind: "identity-retired" };

export type ViewReplicaEvictionClass = ViewReplicaEviction["kind"];

/** Where the replica keeps its pages. Each call is one transaction. */
export interface ViewReplicaBackend {
  load(accountId: string): Promise<{
    readonly records: readonly unknown[];
    readonly meta: unknown;
  }>;
  write(
    records: readonly ViewReplicaStoredRecord[],
    deleteKeys: readonly string[],
    meta: ViewReplicaAccountMeta | null,
  ): Promise<void>;
  deleteAccount(accountId: string): Promise<void>;
  clear(): Promise<void>;
}

const sourceEpochSchema = z.object({
  source: z.string(),
  value: z.string(),
});

const identitySchema = z.object({
  accountId: z.string().min(1),
  service: z.string().min(1),
  servingTier: z.string().min(1),
  requestScope: z.string(),
  sourceEpoch: sourceEpochSchema.nullable(),
  canonicalVersion: z.string().min(1),
});

const storedRecordSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  identity: identitySchema,
  shell: z.unknown(),
  rows: z.array(
    z.object({ scope: viewReplicaRowScopeSchema, value: z.unknown() }),
  ),
  withdrawnScopes: z.array(viewReplicaRowScopeSchema),
  savedAt: z.number().nonnegative(),
  sourceGeneration: z.number().nullable(),
});

const accountMetaSchema = z.object({
  accountId: z.string().min(1),
  epochs: z.record(z.string(), sourceEpochSchema),
  floors: z.record(z.string(), z.number()),
  withdrawals: z.array(
    z.object({ scope: viewReplicaRowScopeSchema, at: z.number() }),
  ),
});

export interface ViewReplicaStoredRecord {
  readonly version: 1;
  readonly key: string;
  readonly identity: ViewReplicaIdentity;
  readonly shell: unknown;
  readonly rows: readonly ViewReplicaRow[];
  readonly withdrawnScopes: readonly ViewReplicaRowScope[];
  readonly savedAt: number;
  readonly sourceGeneration: number | null;
}

export interface ViewReplicaAccountMeta {
  readonly accountId: string;
  /** The source epoch each serving tier last reported. */
  readonly epochs: Readonly<Record<string, ViewReplicaSourceEpoch>>;
  /** The read-your-write floor of each service. */
  readonly floors: Readonly<Record<string, number>>;
  /** Every confirmed scope loss, fencing answers observed before it. */
  readonly withdrawals: readonly {
    readonly scope: ViewReplicaRowScope;
    readonly at: number;
  }[];
}

function rawKey(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const key: unknown = Reflect.get(raw, "key");
  return typeof key === "string" ? key : null;
}
