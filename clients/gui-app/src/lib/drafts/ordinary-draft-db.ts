import type {
  DraftBase,
  DraftCloudDocument,
  DraftCloudTombstone,
} from "@traycer/protocol/host/drafts";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { PERSIST_PREFIX } from "@/lib/persist/keys";

export const ORDINARY_DRAFT_DB_NAME = `${PERSIST_PREFIX}:ordinary-drafts`;
const STORES = ["scopes", "drafts", "cursors", "images", "stages"] as const;
type Store = (typeof STORES)[number];

export interface OrdinaryDraftScope {
  readonly partition: string;
  readonly ownerId: string;
  readonly scopeId: string;
}

interface StoredOrdinaryDraftScope extends OrdinaryDraftScope {
  readonly openedSeq: number;
}

export interface OrdinaryDraftEvidence {
  readonly base: DraftBase;
  readonly kind: "live" | "tombstone";
  readonly operationId: string | null | undefined;
  readonly identity: string | null;
  readonly writeIdentity?: string;
  readonly ambiguous: boolean;
}

export interface OrdinaryDraftEditor {
  readonly surface: "chat" | "modal" | "landing";
  readonly slot: string;
  readonly value: unknown;
  readonly occurrence: string;
  readonly dirty: boolean;
  readonly roots?: readonly string[];
}

export interface OrdinaryDraftRow {
  readonly partition: string;
  readonly draftId: string;
  readonly evidence: OrdinaryDraftEvidence | null;
  readonly accepted: DraftBase | null;
  readonly acceptedEntry?: DraftCloudDocument | null;
  readonly pending?: {
    readonly entry: DraftCloudDocument | DraftCloudTombstone;
    readonly reason: "held" | "refused";
  } | null;
  readonly editor: OrdinaryDraftEditor | null;
  readonly recovery: DraftCloudDocument | null;
  readonly roots: readonly string[];
}

interface StoredOrdinaryDraftRow extends OrdinaryDraftRow {
  readonly imageKeys: readonly string[];
  readonly editorSlot: readonly [string, string, string] | undefined;
}

export interface OrdinaryDraftCursor {
  readonly partition: string;
  readonly peerId: string;
  readonly seq: number;
}

interface OrdinaryDraftStage {
  readonly partition: string;
  readonly id: string;
  readonly imageKeys: readonly string[];
}

interface OrdinaryDraftImage {
  readonly partition: string;
  readonly hash: string;
  readonly bytes: ImageBytes;
}

let opening: Promise<IDBDatabase> | null = null;

export function resetOrdinaryDraftDatabaseForTests(): void {
  const previous = opening;
  opening = null;
  void previous?.then(
    (db) => db.close(),
    () => {},
  );
}

function ordinaryStageLocks(): LockManager | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}

function openOrdinaryDraftDatabase(): Promise<IDBDatabase> {
  if (opening !== null) return opening;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ORDINARY_DRAFT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("scopes", { keyPath: "partition" });
      const drafts = db.createObjectStore("drafts", {
        keyPath: ["partition", "draftId"],
      });
      drafts.createIndex("partition", "partition");
      drafts.createIndex("image", "imageKeys", { multiEntry: true });
      drafts.createIndex("editor-slot", "editorSlot");
      const cursors = db.createObjectStore("cursors", {
        keyPath: ["partition", "peerId"],
      });
      cursors.createIndex("partition", "partition");
      const images = db.createObjectStore("images", {
        keyPath: ["partition", "hash"],
      });
      images.createIndex("partition", "partition");
      const stages = db.createObjectStore("stages", {
        keyPath: ["partition", "id"],
      });
      stages.createIndex("partition", "partition");
      stages.createIndex("image", "imageKeys", { multiEntry: true });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (opening === pending) opening = null;
      };
      resolve(db);
    };
    request.onerror = () =>
      reject(new Error("Ordinary draft storage unavailable"));
  });
  opening = pending;
  void pending.catch(() => {
    if (opening === pending) opening = null;
  });
  return pending;
}

interface OrdinaryTransaction<Result> {
  readonly store: (store: Store) => IDBObjectStore;
  complete(result: Result): void;
  refuse(): void;
}

async function runTransaction<Result>(
  stores: readonly Store[],
  mode: IDBTransactionMode,
  run: (transaction: OrdinaryTransaction<Result>) => void,
): Promise<Result> {
  const database = await openOrdinaryDraftDatabase();
  return new Promise<Result>((resolve, reject) => {
    const transaction = database.transaction([...stores], mode);
    let finish = () =>
      reject(new Error("Ordinary draft transaction incomplete"));
    transaction.oncomplete = () => finish();
    transaction.onabort = () =>
      reject(new Error("Ordinary draft transaction refused"));
    try {
      run({
        store: (name) => transaction.objectStore(name),
        complete: (result) => {
          finish = () => resolve(result);
        },
        refuse: () => transaction.abort(),
      });
    } catch {
      transaction.abort();
    }
  });
}

function requestValue<Value>(
  request: {
    readonly result: unknown;
    readonly transaction: IDBTransaction | null;
    onsuccess: ((event: Event) => void) | null;
  },
  receive: (result: Value) => void,
): void {
  request.onsuccess = () => {
    try {
      receive(request.result as Value);
    } catch {
      request.transaction?.abort();
    }
  };
}

export function resolveOrdinaryDraftScope(
  ownerId: string,
  scopeId: string | null,
): Promise<OrdinaryDraftScope | null> {
  return runTransaction(["scopes"], "readwrite", (transaction) => {
    const store = transaction.store("scopes");
    requestValue<StoredOrdinaryDraftScope[]>(store.getAll(), (scopes) => {
      if (scopeId === null) {
        const current = scopes.reduce<StoredOrdinaryDraftScope | null>(
          (latest, scope) =>
            scope.ownerId === ownerId &&
            (latest === null || scope.openedSeq > latest.openedSeq)
              ? scope
              : latest,
          null,
        );
        transaction.complete(current);
        return;
      }
      const current = scopes.find(
        (scope) => scope.ownerId === ownerId && scope.scopeId === scopeId,
      );
      const openedSeq =
        1 + scopes.reduce((max, scope) => Math.max(max, scope.openedSeq), 0);
      const scope = {
        ownerId,
        scopeId,
        partition: current?.partition ?? crypto.randomUUID(),
        openedSeq,
      };
      store.put(scope);
      transaction.complete(scope);
    });
  });
}

export interface OrdinaryDraftPartition {
  readonly rows: readonly OrdinaryDraftRow[];
  readonly cursors: readonly OrdinaryDraftCursor[];
}

export function readOrdinaryDraftRow(
  partition: string,
  draftId: string,
): Promise<OrdinaryDraftRow | undefined> {
  return runTransaction(["drafts"], "readonly", (transaction) => {
    requestValue<OrdinaryDraftRow | undefined>(
      transaction.store("drafts").get([partition, draftId]),
      (row) => transaction.complete(row),
    );
  });
}

export function readOrdinaryDraftPartition(
  partition: string,
): Promise<OrdinaryDraftPartition> {
  return runTransaction(["drafts", "cursors"], "readonly", (transaction) => {
    const drafts = transaction
      .store("drafts")
      .index("partition")
      .getAll(partition);
    requestValue<OrdinaryDraftRow[]>(drafts, (rows) => {
      const cursors = transaction
        .store("cursors")
        .index("partition")
        .getAll(partition);
      requestValue<OrdinaryDraftCursor[]>(cursors, (saved) => {
        transaction.complete({ rows, cursors: saved });
      });
    });
  });
}

function imageKey(partition: string, hash: string): string {
  return `${partition}:${hash}`;
}

export function stageOrdinaryDraftBytes(input: {
  readonly partition: string;
  readonly stageId: string;
  readonly images: ReadonlyMap<string, ImageBytes>;
}): Promise<void> {
  const { partition, stageId, images } = input;
  return runTransaction(
    ["scopes", "images", "stages"],
    "readwrite",
    (transaction) => {
      requestValue<IDBValidKey | undefined>(
        transaction.store("scopes").getKey(partition),
        (scope) => {
          if (scope === undefined) {
            transaction.refuse();
            return;
          }
          const store = transaction.store("images");
          for (const [hash, bytes] of images) {
            const image: OrdinaryDraftImage = { partition, hash, bytes };
            store.put(image);
          }
          const stage: OrdinaryDraftStage = {
            partition,
            id: stageId,
            imageKeys: [...images.keys()].map((hash) =>
              imageKey(partition, hash),
            ),
          };
          transaction.store("stages").add(stage);
          transaction.complete(undefined);
        },
      );
    },
  );
}

export interface OrdinaryDraftImageHold {
  readonly stageId: string;
  release(): Promise<void>;
}

function ordinaryStageLockName(partition: string, stageId: string): string {
  return `${ORDINARY_DRAFT_DB_NAME}:${partition}:${stageId}`;
}

export async function holdOrdinaryDraftImages(input: {
  readonly partition: string;
  readonly images: ReadonlyMap<string, ImageBytes>;
  readonly signal: AbortSignal;
}): Promise<OrdinaryDraftImageHold> {
  const { partition, images, signal } = input;
  signal.throwIfAborted();
  const stageId = crypto.randomUUID();
  const locks = ordinaryStageLocks();
  const released = Promise.withResolvers<void>();
  if (locks !== undefined) {
    const acquired = Promise.withResolvers<void>();
    void locks
      .request(
        ordinaryStageLockName(partition, stageId),
        { signal },
        async () => {
          acquired.resolve();
          await released.promise;
        },
      )
      .catch(acquired.reject);
    await acquired.promise;
  }
  try {
    signal.throwIfAborted();
    await stageOrdinaryDraftBytes({ partition, stageId, images });
  } catch (error) {
    released.resolve();
    throw error;
  }
  return {
    stageId,
    async release() {
      try {
        await releaseOrdinaryDraftStage(partition, stageId);
      } finally {
        released.resolve();
      }
    },
  };
}

export async function recoverAbandonedOrdinaryDraftStages(
  partition: string,
): Promise<void> {
  const locks = ordinaryStageLocks();
  if (locks === undefined) return;
  const markers = await runTransaction<OrdinaryDraftStage[]>(
    ["stages"],
    "readonly",
    (transaction) => {
      requestValue<OrdinaryDraftStage[]>(
        transaction.store("stages").index("partition").getAll(partition),
        (result) => transaction.complete(result),
      );
    },
  );
  await Promise.all(
    markers.map(({ id }) =>
      locks.request(
        ordinaryStageLockName(partition, id),
        { ifAvailable: true },
        async (lock) => {
          if (lock !== null) await releaseOrdinaryDraftStage(partition, id);
        },
      ),
    ),
  );
}

export function readOrdinaryDraftBytes(
  partition: string,
  hash: string,
): Promise<ImageBytes | undefined> {
  return runTransaction(["images"], "readonly", (transaction) => {
    requestValue<OrdinaryDraftImage | undefined>(
      transaction.store("images").get([partition, hash]),
      (image) => transaction.complete(image?.bytes),
    );
  });
}

export function readRootedOrdinaryDraftBytes(
  partition: string,
  hash: string,
): Promise<ImageBytes | undefined> {
  return runTransaction(["drafts", "images"], "readonly", (transaction) => {
    requestValue<IDBValidKey | undefined>(
      transaction
        .store("drafts")
        .index("image")
        .getKey(imageKey(partition, hash)),
      (root) => {
        if (root === undefined) {
          transaction.complete(undefined);
          return;
        }
        requestValue<OrdinaryDraftImage | undefined>(
          transaction.store("images").get([partition, hash]),
          (image) => transaction.complete(image?.bytes),
        );
      },
    );
  });
}

export interface OrdinaryDraftRowWrite {
  readonly partition: string;
  readonly draftId: string;
  readonly cursor: OrdinaryDraftCursor | null;
  readonly stageId: string | null;
  readonly signal: AbortSignal | null;
  readonly isCurrent?: () => boolean;
  decide(previous: OrdinaryDraftRow | undefined): OrdinaryDraftRow | undefined;
}

export interface OrdinaryDraftBatchRowWrite {
  readonly draftId: string;
  readonly stageId: string | null;
  readonly isCurrent?: () => boolean;
  readonly parkIfOccupied?: (
    row: OrdinaryDraftRow,
  ) => OrdinaryDraftRow | undefined;
  decide(previous: OrdinaryDraftRow | undefined): OrdinaryDraftRow | undefined;
}

export async function writeOrdinaryDraftRow(
  input: OrdinaryDraftRowWrite,
): Promise<OrdinaryDraftRow> {
  const [row] = await writeOrdinaryDraftBatch({
    partition: input.partition,
    cursor: input.cursor,
    signal: input.signal,
    rows: [input],
  });
  return row;
}

export function writeOrdinaryDraftBatch(input: {
  readonly partition: string;
  readonly cursor: OrdinaryDraftCursor | null;
  readonly signal: AbortSignal | null;
  readonly rows: readonly OrdinaryDraftBatchRowWrite[];
}): Promise<readonly OrdinaryDraftRow[]> {
  return runTransaction(
    ["scopes", "drafts", "cursors", "images", "stages"],
    "readwrite",
    (transaction) => {
      const { partition, cursor, signal, rows: writes } = input;
      const cursors = transaction.store("cursors");
      const stages = transaction.store("stages");
      const retiredHashes = new Set<string>();
      const claimedSlots = new Set<string>();
      const rows: OrdinaryDraftRow[] = [];
      let remaining = 1 + Number(cursor !== null) + writes.length;
      const checked = () => {
        if (--remaining !== 0) return;
        if (
          signal?.aborted ||
          writes.some((write) => write.isCurrent?.() === false)
        ) {
          transaction.refuse();
          return;
        }
        if (cursor !== null) cursors.put(cursor);
        for (const hash of retiredHashes)
          removeUnrootedOrdinaryImage(transaction, partition, hash);
        transaction.complete(rows);
      };
      if (
        signal?.aborted ||
        (cursor !== null && cursor.partition !== partition) ||
        new Set(writes.map(({ draftId }) => draftId)).size !== writes.length
      ) {
        transaction.refuse();
        return;
      }
      requestValue<IDBValidKey | undefined>(
        transaction.store("scopes").getKey(partition),
        (key) => (key === undefined ? transaction.refuse() : checked()),
      );
      if (cursor !== null) {
        requestValue<OrdinaryDraftCursor | undefined>(
          cursors.get([partition, cursor.peerId]),
          (previous) => {
            if (previous !== undefined && previous.seq > cursor.seq)
              transaction.refuse();
            else checked();
          },
        );
      }
      for (const write of writes) {
        prepareOrdinaryRow(
          transaction,
          partition,
          write,
          (prepared, removed, unchanged) => {
            const finish = (row: OrdinaryDraftRow) => {
              if (write.stageId !== null)
                stages.delete([partition, write.stageId]);
              for (const hash of removed) retiredHashes.add(hash);
              rows.push(row);
              checked();
            };
            if (unchanged) finish(prepared);
            else
              storePreparedOrdinaryRow({
                transaction,
                write,
                prepared,
                claimedSlots,
                stored: finish,
              });
          },
        );
      }
    },
  );
}

function storePreparedOrdinaryRow<Result>(input: {
  readonly transaction: OrdinaryTransaction<Result>;
  readonly write: OrdinaryDraftBatchRowWrite;
  readonly prepared: OrdinaryDraftRow;
  readonly claimedSlots: Set<string>;
  readonly stored: (row: OrdinaryDraftRow) => void;
}): void {
  const { transaction, write, prepared, claimedSlots, stored } = input;
  const drafts = transaction.store("drafts");
  const put = (
    row: OrdinaryDraftRow,
    slot: StoredOrdinaryDraftRow["editorSlot"],
  ) => {
    drafts.put({
      ...row,
      editorSlot: slot,
      imageKeys: row.roots.map((hash) => imageKey(row.partition, hash)),
    } satisfies StoredOrdinaryDraftRow);
    stored(row);
  };
  const editor = prepared.editor;
  if (editor === null || prepared.recovery !== null) {
    put(prepared, undefined);
    return;
  }
  const slot = [prepared.partition, editor.surface, editor.slot] as const;
  requestValue<IDBValidKey | undefined>(
    drafts.index("editor-slot").getKey([...slot]),
    (key) => {
      const slotKey = JSON.stringify(slot);
      const sameRow = Array.isArray(key) && key[1] === prepared.draftId;
      if ((key === undefined || sameRow) && !claimedSlots.has(slotKey)) {
        claimedSlots.add(slotKey);
        put(prepared, slot);
        return;
      }
      const parked = write.parkIfOccupied?.(prepared);
      if (parked === undefined) transaction.refuse();
      else put(parked, undefined);
    },
  );
}

function prepareOrdinaryRow<Result>(
  transaction: OrdinaryTransaction<Result>,
  partition: string,
  write: OrdinaryDraftBatchRowWrite,
  ready: (
    row: OrdinaryDraftRow,
    retiredHashes: ReadonlySet<string>,
    unchanged: boolean,
  ) => void,
): void {
  const { draftId, stageId } = write;
  requestValue<StoredOrdinaryDraftRow | undefined>(
    transaction.store("drafts").get([partition, draftId]),
    (previous) => {
      const row = write.decide(previous);
      if (
        row === undefined ||
        row.partition !== partition ||
        row.draftId !== draftId ||
        (previous?.evidence !== undefined &&
          previous.evidence !== null &&
          (row.evidence === null ||
            row.evidence.base.revision < previous.evidence.base.revision))
      ) {
        transaction.refuse();
        return;
      }
      const unchanged = row === previous;
      const retired = new Set(previous?.roots);
      const roots = new Set(row.roots);
      let remaining =
        (unchanged ? 0 : roots.size) + Number(stageId !== null) + 1;
      const checked = () => {
        if (--remaining !== 0) return;
        for (const hash of roots) retired.delete(hash);
        ready(row, retired, unchanged);
      };
      for (const hash of unchanged ? [] : roots) {
        requestValue<IDBValidKey | undefined>(
          transaction.store("images").getKey([partition, hash]),
          (key) => (key === undefined ? transaction.refuse() : checked()),
        );
      }
      if (stageId !== null) {
        requestValue<OrdinaryDraftStage | undefined>(
          transaction.store("stages").get([partition, stageId]),
          (stage) => {
            if (stage === undefined) transaction.refuse();
            else {
              for (const hash of ordinaryStageHashes(stage)) retired.add(hash);
              checked();
            }
          },
        );
      }
      checked();
    },
  );
}

function ordinaryStageHashes(stage: OrdinaryDraftStage): readonly string[] {
  const prefix = `${stage.partition}:`;
  return stage.imageKeys.flatMap((key) =>
    key.startsWith(prefix) ? [key.slice(prefix.length)] : [],
  );
}

function removeUnrootedOrdinaryImage<Result>(
  transaction: OrdinaryTransaction<Result>,
  partition: string,
  hash: string,
): void {
  const image = imageKey(partition, hash);
  requestValue<IDBValidKey | undefined>(
    transaction.store("drafts").index("image").getKey(image),
    (draft) => {
      if (draft !== undefined) return;
      requestValue<IDBValidKey | undefined>(
        transaction.store("stages").index("image").getKey(image),
        (stage) => {
          if (stage === undefined)
            transaction.store("images").delete([partition, hash]);
        },
      );
    },
  );
}

export function releaseOrdinaryDraftStage(
  partition: string,
  stageId: string,
): Promise<void> {
  return runTransaction<void>(
    ["drafts", "stages", "images"],
    "readwrite",
    (transaction) => {
      const stages = transaction.store("stages");
      const key = [partition, stageId];
      requestValue<OrdinaryDraftStage | undefined>(stages.get(key), (stage) => {
        if (stage !== undefined) {
          stages.delete(key);
          for (const hash of ordinaryStageHashes(stage))
            removeUnrootedOrdinaryImage(transaction, partition, hash);
        }
        transaction.complete(undefined);
      });
    },
  );
}
