import { z } from "zod";
import {
  chatSkeletonResumeSchema,
  type ChatSkeletonResume,
} from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";
import { persistKey } from "@/lib/persist/keys";

/** A fixed, account-partitioned origin store. Keys never enter logs or telemetry. */
export const SKELETON_RESUME_DB_NAME = persistKey("chat-skeleton-resume-v1");
const PRESENCE_KEY = persistKey("chat-skeleton-resume-present-v1");
const MAX_CHARS = 4 * 1024 * 1024; // UTF-16: at most 8 MiB of entry strings.
const MAX_CHATS = 8;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const recordSchema = z.object({
  version: z.literal(1),
  claim: chatSkeletonResumeSchema,
  entriesJson: z.string().max(MAX_CHARS),
  savedAt: z.number().int().nonnegative(),
});
const metaSchema = z.object({
  key: z.string(),
  chars: z.number().int().nonnegative(),
  touchedAt: z.number().int().nonnegative(),
});

export interface DurableSkeleton {
  readonly claim: ChatSkeletonResume;
  readonly entriesJson: string;
}

let opened: Promise<IDBDatabase | null> | null = null;
let generation = 0;
let writes: Promise<void> = Promise.resolve();

function isCurrentGeneration(stamp: number): boolean {
  return stamp === generation;
}

export function skeletonResumeStorageKey(input: {
  readonly userId: string | null;
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
}): string {
  return JSON.stringify([
    input.userId,
    input.hostId,
    input.epicId,
    input.chatId,
  ]);
}

function presence(): string[] {
  try {
    const raw = globalThis.localStorage.getItem(PRESENCE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

function writePresence(keys: readonly string[]): void {
  try {
    if (keys.length === 0) globalThis.localStorage.removeItem(PRESENCE_KEY);
    else globalThis.localStorage.setItem(PRESENCE_KEY, JSON.stringify(keys));
  } catch {
    // Storage may be disabled. The hint is an optimization, not authority.
  }
}

/** An absent hint means there is no IndexedDB load on the chat-open path. */
export function hasDurableSkeletonHint(key: string): boolean {
  return presence().includes(key);
}

function database(): Promise<IDBDatabase | null> {
  if (opened !== null) return opened;
  if (typeof globalThis.indexedDB === "undefined") return Promise.resolve(null);
  opened = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = globalThis.indexedDB.open(SKELETON_RESUME_DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("entries"))
        db.createObjectStore("entries");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opened = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opened = null;
      resolve(null);
    };
    request.onblocked = () => {
      opened = null;
      resolve(null);
    };
  });
  return opened;
}

function enqueue(work: () => Promise<void>): Promise<void> {
  const next = writes.then(work, work);
  writes = next.catch(() => undefined);
  return next;
}

function transactionDone(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

export function removeDurableSkeleton(key: string): Promise<void> {
  writePresence(presence().filter((present) => present !== key));
  return enqueue(async () => {
    const db = await database();
    if (db === null) return;
    const tx = db.transaction(["entries", "meta"], "readwrite");
    tx.objectStore("entries").delete(key);
    tx.objectStore("meta").delete(key);
    await transactionDone(tx);
  });
}

/** A corrupt, expired, or unreadable entry is a miss. */
export function loadDurableSkeleton(
  key: string,
): Promise<DurableSkeleton | null> {
  return loadDurableSkeletonBestEffort(key).catch(() => null);
}

async function loadDurableSkeletonBestEffort(
  key: string,
): Promise<DurableSkeleton | null> {
  const readGeneration = generation;
  await writes;
  const db = await database();
  if (db === null || readGeneration !== generation) return null;
  const raw = await new Promise<unknown>((resolve) => {
    const request = db
      .transaction("entries", "readonly")
      .objectStore("entries")
      .get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  if (readGeneration !== generation) return null;
  const parsed = recordSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.savedAt > Date.now() ||
    Date.now() - parsed.data.savedAt > MAX_AGE_MS
  ) {
    void removeDurableSkeleton(key).catch(() => undefined);
    return null;
  }
  // Recency is advisory. A failed touch does not invalidate a sound entry.
  void enqueue(async () => {
    const current = await database();
    if (current === null || readGeneration !== generation) return;
    const tx = current.transaction("meta", "readwrite");
    tx.objectStore("meta").put(
      { key, chars: parsed.data.entriesJson.length, touchedAt: Date.now() },
      key,
    );
    await transactionDone(tx);
  }).catch(() => undefined);
  return { claim: parsed.data.claim, entriesJson: parsed.data.entriesJson };
}

/** One readwrite transaction makes the eight-chat/8-MiB bound cross-window safe. */
export function saveDurableSkeleton(
  key: string,
  value: DurableSkeleton,
): Promise<void> {
  if (value.entriesJson.length > MAX_CHARS) return removeDurableSkeleton(key);
  const writeGeneration = generation;
  return enqueue(async () => {
    if (writeGeneration !== generation) return;
    const db = await database();
    if (db === null || writeGeneration !== generation) return;
    const tx = db.transaction(["entries", "meta"], "readwrite");
    const entryStore = tx.objectStore("entries");
    const metaStore = tx.objectStore("meta");
    const retainedKeys: string[] = [];
    const request = metaStore.getAll();
    request.onsuccess = () => {
      const parsed = z.array(metaSchema).safeParse(request.result);
      if (!parsed.success) {
        entryStore.clear();
        metaStore.clear();
      }
      const candidates = (parsed.success ? parsed.data : []).filter(
        (entry) => entry.key !== key,
      );
      candidates.push({
        key,
        chars: value.entriesJson.length,
        touchedAt: Date.now(),
      });
      candidates.sort((left, right) => right.touchedAt - left.touchedAt);
      let chars = 0;
      for (const candidate of candidates) {
        if (
          retainedKeys.length < MAX_CHATS &&
          chars + candidate.chars <= MAX_CHARS
        ) {
          retainedKeys.push(candidate.key);
          chars += candidate.chars;
        } else {
          entryStore.delete(candidate.key);
          metaStore.delete(candidate.key);
        }
      }
      if (retainedKeys.includes(key)) {
        entryStore.put(
          {
            version: 1,
            claim: value.claim,
            entriesJson: value.entriesJson,
            savedAt: Date.now(),
          },
          key,
        );
        metaStore.put(
          { key, chars: value.entriesJson.length, touchedAt: Date.now() },
          key,
        );
      }
    };
    if ((await transactionDone(tx)) && isCurrentGeneration(writeGeneration))
      writePresence(retainedKeys);
  });
}

/** Fence queued writes and in-flight reads before clearing account content. */
export function clearDurableSkeletons(): Promise<void> {
  generation += 1;
  writePresence([]);
  return enqueue(async () => {
    const db = await database();
    if (db === null) return;
    const tx = db.transaction(["entries", "meta"], "readwrite");
    tx.objectStore("entries").clear();
    tx.objectStore("meta").clear();
    await transactionDone(tx);
  });
}

/** Await queued writes in tests that simulate a renderer restart. */
export function drainDurableSkeletonWritesForTests(): Promise<void> {
  return writes;
}
