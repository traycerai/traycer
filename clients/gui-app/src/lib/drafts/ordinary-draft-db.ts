import type {
  DraftBase,
  DraftCloudDocument,
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
  readonly editor: OrdinaryDraftEditor | null;
  readonly recovery: DraftCloudDocument | null;
  readonly roots: readonly string[];
}

interface StoredOrdinaryDraftRow extends OrdinaryDraftRow {
  readonly imageKeys: readonly string[];
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

export function writeOrdinaryDraftCursor(
  cursor: OrdinaryDraftCursor,
): Promise<void> {
  return runTransaction(["scopes", "cursors"], "readwrite", (transaction) => {
    const cursors = transaction.store("cursors");
    requestValue<OrdinaryDraftCursor | undefined>(
      cursors.get([cursor.partition, cursor.peerId]),
      (previous) => {
        if (previous !== undefined && previous.seq > cursor.seq) {
          transaction.refuse();
          return;
        }
        requestValue<IDBValidKey | undefined>(
          transaction.store("scopes").getKey(cursor.partition),
          (scope) => {
            if (scope === undefined) {
              transaction.refuse();
              return;
            }
            cursors.put(cursor);
            transaction.complete(undefined);
          },
        );
      },
    );
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

export function writeOrdinaryDraftRow(
  input: OrdinaryDraftRowWrite,
): Promise<OrdinaryDraftRow> {
  return runTransaction(
    ["scopes", "drafts", "cursors", "images", "stages"],
    "readwrite",
    (transaction) => {
      const drafts = transaction.store("drafts");
      const cursors = transaction.store("cursors");
      const images = transaction.store("images");
      const stages = transaction.store("stages");
      const { partition, draftId, cursor, stageId, signal } = input;
      if (
        signal?.aborted ||
        (cursor !== null && cursor.partition !== partition)
      ) {
        transaction.refuse();
        return;
      }

      requestValue<StoredOrdinaryDraftRow | undefined>(
        drafts.get([partition, draftId]),
        (previous) => {
          const row = input.decide(previous);
          if (
            row === undefined ||
            row.partition !== partition ||
            row.draftId !== draftId ||
            (previous !== undefined &&
              previous.evidence !== null &&
              (row.evidence === null ||
                row.evidence.base.revision < previous.evidence.base.revision))
          ) {
            transaction.refuse();
            return;
          }
          const rootedHashes = new Set(row.roots);
          const imageKeys = [...rootedHashes].map((hash) =>
            imageKey(partition, hash),
          );
          let stagedHashes: readonly string[] = [];
          const commit = () => {
            if (signal?.aborted || input.isCurrent?.() === false) {
              transaction.refuse();
              return;
            }
            drafts.put({ ...row, imageKeys } satisfies StoredOrdinaryDraftRow);
            if (cursor !== null) cursors.put(cursor);
            if (stageId !== null) stages.delete([partition, stageId]);
            for (const hash of new Set([
              ...(previous?.roots ?? []),
              ...stagedHashes,
            ])) {
              if (!rootedHashes.has(hash))
                removeUnrootedOrdinaryImage(transaction, partition, hash);
            }
            transaction.complete(row);
          };

          let remaining =
            1 +
            row.roots.length +
            Number(cursor !== null) +
            Number(stageId !== null);
          const checked = () => {
            remaining -= 1;
            if (remaining === 0) commit();
          };
          requestValue<IDBValidKey | undefined>(
            transaction.store("scopes").getKey(partition),
            (scope) => {
              if (scope === undefined) transaction.refuse();
              else checked();
            },
          );
          for (const hash of row.roots) {
            requestValue<IDBValidKey | undefined>(
              images.getKey([partition, hash]),
              (key) => {
                if (key === undefined) transaction.refuse();
                else checked();
              },
            );
          }
          if (cursor !== null) {
            requestValue<OrdinaryDraftCursor | undefined>(
              cursors.get([partition, cursor.peerId]),
              (existing) => {
                if (existing !== undefined && existing.seq > cursor.seq)
                  transaction.refuse();
                else checked();
              },
            );
          }
          if (stageId !== null) {
            requestValue<OrdinaryDraftStage | undefined>(
              stages.get([partition, stageId]),
              (stage) => {
                if (stage === undefined) transaction.refuse();
                else {
                  stagedHashes = ordinaryStageHashes(stage);
                  checked();
                }
              },
            );
          }
        },
      );
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

/** The list of candidates is advisory. Both sorts of roots are checked while deleting. */
export async function sweepOrdinaryDraftImages(
  partition: string,
): Promise<void> {
  const candidates = await runTransaction<IDBValidKey[]>(
    ["images"],
    "readonly",
    (transaction) => {
      requestValue<IDBValidKey[]>(
        transaction.store("images").index("partition").getAllKeys(partition),
        (keys) => transaction.complete(keys),
      );
    },
  );
  await runTransaction<void>(
    ["drafts", "stages", "images"],
    "readwrite",
    (transaction) => {
      for (const key of candidates) {
        if (
          !Array.isArray(key) ||
          key[0] !== partition ||
          typeof key[1] !== "string"
        )
          continue;
        removeUnrootedOrdinaryImage(transaction, partition, key[1]);
      }
      transaction.complete(undefined);
    },
  );
}
