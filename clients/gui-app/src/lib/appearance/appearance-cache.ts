import { createStore, get, clear, del } from "idb-keyval";
import {
  workspaceAppearanceReadSchema,
  type WorkspaceAppearanceRead,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import { PERSIST_PREFIX } from "@/lib/persist/keys";
import { useAuthStore } from "@/stores/auth/auth-store";

export const APPEARANCE_DB_NAME = `${PERSIST_PREFIX}:appearance`;
export const APPEARANCE_CACHE_LIMIT = 64 * 1024 * 1024;
const store = createStore(APPEARANCE_DB_NAME, "appearance");
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

export function appearanceScopeKey(scope: AppearanceScope): string {
  return JSON.stringify([
    scope.accountId,
    scope.hostId,
    scope.canonicalSourceRoot,
  ]);
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
    const entry: unknown = await get(key, store);
    return allowed(accountId, captured) && isEntry(entry) ? entry.value : null;
  } catch {
    return null;
  }
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
  await store(
    "readwrite",
    (objectStore) =>
      new Promise<void>((resolve, reject) => {
        const transaction = objectStore.transaction;
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ??
              new Error("Appearance cache transaction failed."),
          );
        transaction.onabort = () =>
          reject(
            transaction.error ?? new Error("Appearance cache write aborted."),
          );
        // ponytail: oldest-write eviction avoids a write on every read; add LRU if cache churn warrants it.
        const candidates: {
          key: IDBValidKey;
          size: number;
          accessed: number;
        }[] = [];
        let retainPinned = false;
        const cursorRequest = objectStore.openCursor();
        cursorRequest.onsuccess = () => {
          if (!allowed(accountId, captured)) {
            transaction.abort();
            return;
          }
          const cursor = cursorRequest.result;
          if (cursor !== null) {
            const entry: unknown = cursor.value;
            if (isEntry(entry)) {
              if (cursor.key === key) retainPinned ||= entry.pinned;
              else if (!entry.pinned)
                candidates.push({
                  key: cursor.key,
                  size: entry.size,
                  accessed: entry.accessed,
                });
            }
            cursor.continue();
            return;
          }
          let total = candidates.reduce(
            (sum, entry) => sum + entry.size,
            retainPinned ? 0 : size,
          );
          candidates.sort((a, b) => a.accessed - b.accessed);
          for (const candidate of candidates) {
            if (total <= APPEARANCE_CACHE_LIMIT) break;
            objectStore.delete(candidate.key);
            total -= candidate.size;
          }
          objectStore.put(
            {
              value,
              size,
              pinned: retainPinned,
              accessed: Date.now(),
            } satisfies CacheEntry,
            key,
          );
        };
      }),
  );
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
    `source:${JSON.stringify([accountId, hostId, workspacePath])}`,
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
    `source:${JSON.stringify([accountId, hostId, workspacePath])}`,
    source,
    (source?.length ?? 0) * 2 + 128,
    accountId,
  );
}

export function appearanceAssetKey(
  scope: AppearanceScope | null,
  identity: string,
): string {
  return JSON.stringify([
    scope === null ? "global" : appearanceScopeKey(scope),
    identity,
  ]);
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
  await clear(store);
}

export async function pinGlobalAppearanceBlob(
  identity: string | null,
): Promise<void> {
  if (wiping) throw new Error("Appearance cache is being cleared.");
  const pinnedKey =
    identity === null ? null : `blob:${appearanceAssetKey(null, identity)}`;
  await store(
    "readwrite",
    (objectStore) =>
      new Promise<void>((resolve, reject) => {
        const transaction = objectStore.transaction;
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ??
              new Error("Appearance cache transaction failed."),
          );
        transaction.onabort = () =>
          reject(
            transaction.error ?? new Error("Appearance image is not cached."),
          );
        const candidates: {
          key: IDBValidKey;
          size: number;
          accessed: number;
        }[] = [];
        let found = pinnedKey === null;
        const request = objectStore.openCursor();
        request.onsuccess = () => {
          if (wiping) {
            transaction.abort();
            return;
          }
          const cursor = request.result;
          if (cursor !== null) {
            const entry: unknown = cursor.value;
            if (isEntry(entry)) {
              const pinned =
                cursor.key === pinnedKey && entry.value instanceof Blob;
              if (pinned) found = true;
              else
                candidates.push({
                  key: cursor.key,
                  size: entry.size,
                  accessed: entry.accessed,
                });
              if (pinned !== entry.pinned) cursor.update({ ...entry, pinned });
            }
            cursor.continue();
            return;
          }
          if (!found) {
            transaction.abort();
            return;
          }
          let total = candidates.reduce((sum, entry) => sum + entry.size, 0);
          candidates.sort((a, b) => a.accessed - b.accessed);
          for (const candidate of candidates) {
            if (total <= APPEARANCE_CACHE_LIMIT) break;
            objectStore.delete(candidate.key);
            total -= candidate.size;
          }
        };
      }),
  );
}

export function captureAppearanceSession(): number {
  return generation;
}

export function isAppearanceSessionCurrent(
  accountId: string | null,
  session: number,
): boolean {
  return allowed(accountId, session);
}

export async function removeAppearanceBlob(
  scope: AppearanceScope | null,
  identity: string,
): Promise<void> {
  if (!allowed(scope?.accountId ?? null, generation)) return;
  await del(`blob:${appearanceAssetKey(scope, identity)}`, store);
}
