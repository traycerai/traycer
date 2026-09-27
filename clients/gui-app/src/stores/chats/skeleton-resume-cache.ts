import { rowSkeletonEntrySchema } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  buildSkeletonResumeOffer,
  type ChatSkeletonResume,
} from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";
import {
  clearDurableSkeletons,
  hasDurableSkeletonHint,
  hintedDurableSkeletonKeysForUser,
  loadDurableSkeleton,
  removeDurableSkeleton,
  saveDurableSkeleton,
  skeletonResumeStorageKey,
} from "./skeleton-resume-durable-cache";

/**
 * Complete skeletons from this window, kept so a later `chat.subscribe@1.19`
 * can resume instead of re-downloading them.
 *
 * A warm chat session already resumes on reconnect: it still holds its
 * skeleton, and its offer is built from that. A session the warm pool evicted,
 * or whose epic was parked, holds nothing - so the next open of the same chat
 * used to cost the whole skeleton again, which on a phone switching between a
 * handful of tasks is most opens. This keeps just enough to describe that
 * skeleton to the host: the claim, and the entries it describes.
 *
 * ## Compact, not resident
 *
 * The entries are held as ONE JSON string, not as the entry objects. A string
 * is a single heap cell the garbage collector does not walk, where the same
 * rows as objects are thousands of cells it walks on every cycle - and GC
 * pressure, not byte count, is what a phone pays for. The string is parsed only
 * when a host actually resumes from it. Everything is bounded by
 * {@link SKELETON_RESUME_CACHE_MAX_CHARS} across all chats, oldest out first.
 *
 * The same bounded entry is persisted in an account-partitioned IndexedDB
 * store. It is erased on sign-out and on the explicit persisted-state wipe.
 * A cold load is attempted only when the tiny presence hint names this chat.
 *
 * A stale entry is harmless by construction: the host compares digests, and a
 * skeleton that moved since it was cached simply matches fewer blocks.
 */

/** The whole cache's budget, in UTF-16 code units of cached JSON. */
export const SKELETON_RESUME_CACHE_MAX_CHARS = 4 * 1024 * 1024;

/** Chats one cache holds at most, whatever their size. */
export const SKELETON_RESUME_CACHE_MAX_CHATS = 8;

export interface SkeletonResumeCacheKey {
  readonly userId: string | null;
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
}

/** A cached skeleton, as the offer path reads it. */
export interface CachedSkeletonResume {
  readonly claim: ChatSkeletonResume;
  /** The described entries, parsed on demand - see the module doc. */
  readEntries(): readonly RowSkeletonEntry[];
}

type Stored = {
  readonly claim: ChatSkeletonResume;
  readonly entriesJson: string;
};

const cache = new Map<string, Stored>();
let cachedChars = 0;
let resetEpoch = 0;

function keyOf(key: SkeletonResumeCacheKey): string {
  return skeletonResumeStorageKey(key);
}

function drop(cacheKey: string): void {
  const stored = cache.get(cacheKey);
  if (stored === undefined) return;
  cachedChars -= stored.entriesJson.length;
  cache.delete(cacheKey);
}

/**
 * Keep what a closing chat's window could offer. A window with nothing to
 * offer - incomplete, invalidated, or under one block - forgets any older copy
 * instead, since an older skeleton of a chat the client no longer trusts is
 * not worth its budget.
 */
export function rememberSkeletonForResume(
  key: SkeletonResumeCacheKey,
  window: TranscriptWindow,
): void {
  const cacheKey = keyOf(key);
  if (!window.skeletonComplete || window.invalidated) {
    drop(cacheKey);
    if (key.userId !== null)
      void removeDurableSkeleton(cacheKey).catch(() => undefined);
    return;
  }
  const offer = buildSkeletonResumeOffer(window.skeleton, window.rowCount);
  if (offer === null) {
    drop(cacheKey);
    if (key.userId !== null)
      void removeDurableSkeleton(cacheKey).catch(() => undefined);
    return;
  }
  const old = cache.get(cacheKey);
  if (
    old !== undefined &&
    old.claim.blockDigests.length === offer.claim.blockDigests.length &&
    old.claim.blockDigests.every(
      (digest, index) => digest === offer.claim.blockDigests[index],
    )
  ) {
    return;
  }
  const entriesJson = JSON.stringify(offer.entries);
  // One chat larger than the whole budget is not cached at all, rather than
  // evicting everything else to make room it still would not have.
  if (entriesJson.length > SKELETON_RESUME_CACHE_MAX_CHARS) {
    drop(cacheKey);
    if (key.userId !== null)
      void removeDurableSkeleton(cacheKey).catch(() => undefined);
    return;
  }
  drop(cacheKey);
  cache.set(cacheKey, { claim: offer.claim, entriesJson });
  cachedChars += entriesJson.length;
  // Map iteration is insertion order, and `drop` + `set` above re-inserts, so
  // the first key is always the least recently remembered or read.
  while (
    cachedChars > SKELETON_RESUME_CACHE_MAX_CHARS ||
    cache.size > SKELETON_RESUME_CACHE_MAX_CHATS
  ) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
  if (key.userId !== null) {
    void saveDurableSkeleton(cacheKey, {
      claim: offer.claim,
      entriesJson,
    }).catch(() => undefined);
  }
}

/** A no-hint miss requires no IndexedDB work before subscribing. */
export function shouldLoadDurableSkeletonForResume(
  key: SkeletonResumeCacheKey,
): boolean {
  const cacheKey = keyOf(key);
  return (
    key.userId !== null &&
    !cache.has(cacheKey) &&
    hasDurableSkeletonHint(cacheKey)
  );
}

/** Load into the private cache only. No row is published before host confirmation. */
export async function hydrateSkeletonForResume(
  key: SkeletonResumeCacheKey,
): Promise<void> {
  if (!shouldLoadDurableSkeletonForResume(key)) return;
  const epoch = resetEpoch;
  const cacheKey = keyOf(key);
  const loaded = await loadDurableSkeleton(cacheKey);
  if (loaded === null || epoch !== resetEpoch || cache.has(cacheKey)) return;
  if (loaded.entriesJson.length > SKELETON_RESUME_CACHE_MAX_CHARS) return;
  cache.set(cacheKey, loaded);
  cachedChars += loaded.entriesJson.length;
  while (
    cachedChars > SKELETON_RESUME_CACHE_MAX_CHARS ||
    cache.size > SKELETON_RESUME_CACHE_MAX_CHATS
  ) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
}

/** Start account-scoped loads before a chat tab opens; never delay the open. */
export function primeDurableSkeletonsForResume(userId: string): void {
  for (const key of hintedDurableSkeletonKeysForUser(userId)) {
    void hydrateSkeletonForResume(key).catch(() => undefined);
  }
}

/** The cached skeleton for a chat, or `null`. Reading refreshes its recency. */
export function readSkeletonForResume(
  key: SkeletonResumeCacheKey,
): CachedSkeletonResume | null {
  const cacheKey = keyOf(key);
  const stored = cache.get(cacheKey);
  if (stored === undefined) return null;
  cache.delete(cacheKey);
  cache.set(cacheKey, stored);
  let parsed: readonly RowSkeletonEntry[] | null = null;
  return {
    claim: stored.claim,
    readEntries: () => {
      if (parsed === null) {
        const raw: unknown = JSON.parse(stored.entriesJson);
        parsed = Array.isArray(raw)
          ? raw.map((entry) => rowSkeletonEntrySchema.parse(entry))
          : [];
      }
      return parsed;
    },
  };
}

/** Drop memory immediately, then fence and clear the durable cache. */
export function clearAllSkeletonsForResume(): Promise<void> {
  resetEpoch += 1;
  cache.clear();
  cachedChars = 0;
  return clearDurableSkeletons().catch(() => undefined);
}

/** Synchronous identity teardown entry point; the disk clear is queued. */
export function forgetAllSkeletonsForResume(): void {
  void clearAllSkeletonsForResume();
}

/** The cache's size, for tests. */
export function skeletonResumeCacheStatsForTests(): {
  readonly chats: number;
  readonly chars: number;
} {
  return { chats: cache.size, chars: cachedChars };
}

/** Simulate a WebView process eviction without touching IndexedDB. */
export function dropMemorySkeletonsForTests(): void {
  cache.clear();
  cachedChars = 0;
}
