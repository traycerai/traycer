import { createStore, get, clear, del, type UseStore } from "idb-keyval";
import {
  workspaceAppearanceReadSchema,
  type WorkspaceAppearanceRead,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import { PERSIST_PREFIX } from "@/lib/persist/keys";
import { useAuthStore } from "@/stores/auth/auth-store";

// This is a second budgeted IndexedDB blob store alongside
// `@/lib/composer/landing-image-store.ts`. It is NOT a duplicate: it also
// persists JSON snapshots and workspace-path->source-root string mappings
// (not just image bytes), and every entry is scoped by account+host, with a
// GLOBAL "pinned" identity (the wallpaper) exempt from budget eviction -
// neither account scoping nor pinning exists in `landing-image-store`, whose
// content-addressed keying is desktop-window-partitioned only. Reusing it
// would mean adding both capabilities there; keeping the stores separate
// avoids that cross-cutting change.
export const APPEARANCE_DB_NAME = `${PERSIST_PREFIX}:appearance`;
export const APPEARANCE_CACHE_LIMIT = 64 * 1024 * 1024;
// Opened on first use, like `landing-image-store` and `file-edit-recovery-store`:
// `createStore` opens the database eagerly, and no surface that never reads an
// appearance should pay for that at module load.
let cachedStore: UseStore | null = null;
function appearanceStore(): UseStore {
  cachedStore ??= createStore(APPEARANCE_DB_NAME, "appearance");
  return cachedStore;
}
let generation = 0;
let wiping = false;
useAuthStore.subscribe((state, previous) => {
  if (
    state.contextMetadata?.userId !== previous.contextMetadata?.userId ||
    state.status !== previous.status
  )
    generation += 1;
});

export interface AppearanceScope {
  readonly accountId: string;
  readonly hostId: string;
  readonly canonicalSourceRoot: string;
}

function compositeKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

export function appearanceScopeKey(scope: AppearanceScope): string {
  return compositeKey([
    scope.accountId,
    scope.hostId,
    scope.canonicalSourceRoot,
  ]);
}

export function appearanceAssetKey(
  scope: AppearanceScope | null,
  identity: string,
): string {
  return compositeKey([
    scope === null ? "global" : appearanceScopeKey(scope),
    identity,
  ]);
}

function appearanceSourceKey(
  accountId: string,
  hostId: string,
  workspacePath: string,
): string {
  return compositeKey([accountId, hostId, workspacePath]);
}

function allowed(accountId: string | null, captured: number): boolean {
  return (
    !wiping &&
    (accountId === null ||
      (captured === generation &&
        useAuthStore.getState().contextMetadata?.userId === accountId))
  );
}

interface CacheEntry {
  readonly value: unknown;
  readonly size: number;
  readonly accessed: number;
  readonly pinned: boolean;
}

function isEntry(value: unknown): value is CacheEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "size" in value &&
    typeof value.size === "number" &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    "accessed" in value &&
    typeof value.accessed === "number" &&
    Number.isFinite(value.accessed) &&
    "pinned" in value &&
    typeof value.pinned === "boolean"
  );
}

async function read(key: string, accountId: string | null): Promise<unknown> {
  const captured = generation;
  if (!allowed(accountId, captured)) return null;
  try {
    const entry: unknown = await get(key, appearanceStore());
    return allowed(accountId, captured) && isEntry(entry) ? entry.value : null;
  } catch {
    return null;
  }
}

interface EvictionCandidate {
  readonly key: IDBValidKey;
  readonly size: number;
  readonly accessed: number;
}

/**
 * Owns the transaction lifecycle (oncomplete/onerror/onabort), the cursor
 * walk, and the LRU/oldest-write budget eviction shared by `write()` and
 * `pinGlobalAppearanceBlob()` - previously two ~60-line copies of the same
 * mechanics.
 *
 * `guard` re-checks mid-walk (on every cursor step) whether the transaction
 * is still allowed to proceed, aborting it otherwise - this is what makes an
 * account switch or a `clearAppearanceCache()` wipe mid-cursor-walk roll the
 * whole transaction back, including any `cursor.update()` calls already
 * issued this walk.
 *
 * `onEntry` runs once per stored entry and returns an eviction candidate to
 * pool, or `null` to exclude it (a pinned entry, or the entry the caller is
 * specifically handling); it may also mutate the entry via `cursor.update()`.
 * `onWalkEnd` runs once the cursor is exhausted, with every pooled
 * candidate, and returns either `"abort"` or the extra size the caller is
 * about to add to the budget (0 when nothing new is being written, as in
 * `pinGlobalAppearanceBlob`); it may perform its own writes (e.g. the final
 * `objectStore.put`) before returning.
 *
 * ponytail: oldest-write eviction avoids a write on every read; add LRU if
 * cache churn warrants it.
 */
interface EvictionTransactionHandlers {
  readonly onEntry: (
    cursor: IDBCursorWithValue,
    entry: CacheEntry,
  ) => EvictionCandidate | null;
  readonly onWalkEnd: (
    candidates: readonly EvictionCandidate[],
  ) => "abort" | number;
  readonly abortMessage: string;
}

function runEvictionTransaction(
  objectStore: IDBObjectStore,
  guard: () => boolean,
  handlers: EvictionTransactionHandlers,
): Promise<void> {
  const { onEntry, onWalkEnd, abortMessage } = handlers;
  const transaction = objectStore.transaction;
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Appearance cache transaction failed."),
      );
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(abortMessage));
    const candidates: EvictionCandidate[] = [];
    const cursorRequest = objectStore.openCursor();
    cursorRequest.onsuccess = () => {
      if (!guard()) {
        transaction.abort();
        return;
      }
      const cursor = cursorRequest.result;
      if (cursor !== null) {
        const entry: unknown = cursor.value;
        if (isEntry(entry)) {
          const candidate = onEntry(cursor, entry);
          if (candidate !== null) candidates.push(candidate);
        }
        cursor.continue();
        return;
      }
      const outcome = onWalkEnd(candidates);
      if (outcome === "abort") {
        transaction.abort();
        return;
      }
      let total = candidates.reduce((sum, entry) => sum + entry.size, outcome);
      const sorted = [...candidates].sort((a, b) => a.accessed - b.accessed);
      for (const candidate of sorted) {
        if (total <= APPEARANCE_CACHE_LIMIT) break;
        objectStore.delete(candidate.key);
        total -= candidate.size;
      }
    };
  });
}

async function write(
  key: string,
  value: unknown,
  size: number,
  accountId: string | null,
): Promise<void> {
  const captured = generation;
  if (!allowed(accountId, captured))
    throw new Error("Appearance cache session is no longer active.");
  if (size > APPEARANCE_CACHE_LIMIT)
    throw new Error("Appearance image exceeds the cache budget.");
  await appearanceStore()("readwrite", (objectStore) => {
    let retainPinned = false;
    return runEvictionTransaction(
      objectStore,
      () => allowed(accountId, captured),
      {
        onEntry: (cursor, entry) => {
          if (cursor.key === key) {
            retainPinned ||= entry.pinned;
            return null;
          }
          return entry.pinned
            ? null
            : { key: cursor.key, size: entry.size, accessed: entry.accessed };
        },
        onWalkEnd: () => {
          objectStore.put(
            {
              value,
              size,
              pinned: retainPinned,
              accessed: Date.now(),
            } satisfies CacheEntry,
            key,
          );
          return retainPinned ? 0 : size;
        },
        abortMessage: "Appearance cache write aborted.",
      },
    );
  });
}

export async function readAppearanceSnapshot(
  scope: AppearanceScope,
): Promise<WorkspaceAppearanceRead | null> {
  const parsed = workspaceAppearanceReadSchema.safeParse(
    await read(`snapshot:${appearanceScopeKey(scope)}`, scope.accountId),
  );
  return parsed.success &&
    parsed.data.canonicalSourceRoot === scope.canonicalSourceRoot
    ? parsed.data
    : null;
}

export async function writeAppearanceSnapshot(
  scope: AppearanceScope,
  snapshot: WorkspaceAppearanceRead,
): Promise<void> {
  if (snapshot.canonicalSourceRoot !== scope.canonicalSourceRoot) return;
  await write(
    `snapshot:${appearanceScopeKey(scope)}`,
    snapshot,
    JSON.stringify(snapshot).length * 2,
    scope.accountId,
  );
}

// A selected worktree path can resolve to a different source root. Persist only
// that association, so offline lookup never guesses by repository name/remote.
export async function readAppearanceSource(
  accountId: string,
  hostId: string,
  workspacePath: string,
): Promise<string | null> {
  const value = await read(
    `source:${appearanceSourceKey(accountId, hostId, workspacePath)}`,
    accountId,
  );
  return typeof value === "string" ? value : null;
}

export async function writeAppearanceSource(
  accountId: string,
  hostId: string,
  workspacePath: string,
  source: string | null,
): Promise<void> {
  await write(
    `source:${appearanceSourceKey(accountId, hostId, workspacePath)}`,
    source,
    (source?.length ?? 0) * 2 + 128,
    accountId,
  );
}

export async function readAppearanceBlob(
  scope: AppearanceScope | null,
  identity: string,
): Promise<Blob | null> {
  const value = await read(
    `blob:${appearanceAssetKey(scope, identity)}`,
    scope?.accountId ?? null,
  );
  return value instanceof Blob ? value : null;
}

export async function writeAppearanceBlob(
  scope: AppearanceScope | null,
  identity: string,
  blob: Blob,
): Promise<void> {
  await write(
    `blob:${appearanceAssetKey(scope, identity)}`,
    blob,
    blob.size,
    scope?.accountId ?? null,
  );
}

export async function clearAppearanceCache(): Promise<void> {
  wiping = true;
  generation += 1;
  await clear(appearanceStore());
}

export async function pinGlobalAppearanceBlob(
  identity: string | null,
): Promise<void> {
  if (wiping) throw new Error("Appearance cache is being cleared.");
  const pinnedKey =
    identity === null ? null : `blob:${appearanceAssetKey(null, identity)}`;
  await appearanceStore()("readwrite", (objectStore) => {
    let found = pinnedKey === null;
    return runEvictionTransaction(objectStore, () => !wiping, {
      onEntry: (cursor, entry) => {
        const pinned = cursor.key === pinnedKey && entry.value instanceof Blob;
        if (pinned) found = true;
        if (pinned !== entry.pinned) cursor.update({ ...entry, pinned });
        return pinned
          ? null
          : { key: cursor.key, size: entry.size, accessed: entry.accessed };
      },
      onWalkEnd: () => (found ? 0 : "abort"),
      abortMessage: "Appearance image is not cached.",
    });
  });
}

/**
 * A single-use handle capturing "the signed-in session as of right now".
 * `isCurrent(accountId)` answers whether that session is still the live one.
 *
 * Query keys alone (every key in this feature carries `accountId`) already
 * isolate account A's cache entries from account B's. What they cannot see
 * is a sign-OUT followed by a sign-back-IN to the SAME account: `accountId`
 * is unchanged, so a stale in-flight read/write from the old session would
 * otherwise land in the new session's query/IndexedDB state. This handle
 * also lets `runEvictionTransaction`'s cursor walk abort mid-transaction on
 * an account switch or a `clearAppearanceCache()` wipe - a race
 * react-query's own `AbortSignal` cannot reach into, since it only cancels
 * the RPC, not the IndexedDB write/eviction that follows it.
 */
export interface AppearanceSession {
  readonly isCurrent: (accountId: string | null) => boolean;
}

export function captureAppearanceSession(): AppearanceSession {
  const captured = generation;
  return { isCurrent: (accountId) => allowed(accountId, captured) };
}

export async function removeAppearanceBlob(
  scope: AppearanceScope | null,
  identity: string,
): Promise<void> {
  if (!allowed(scope?.accountId ?? null, generation)) return;
  await del(`blob:${appearanceAssetKey(scope, identity)}`, appearanceStore());
}
