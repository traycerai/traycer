import { rowSkeletonEntrySchema } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  buildSkeletonResumeOffer,
  type ChatSkeletonResume,
} from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";

/**
 * The skeletons of chats this window has CLOSED, kept so re-opening one can
 * resume (`chat.subscribe@1.18`) instead of re-downloading it.
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
 * ## Memory only
 *
 * Nothing here is persisted. A skeleton carries the first line of every user
 * message (`preview`), which does not belong on disk on the strength of an
 * optimization, and a reload that loses the cache costs only the saving. It is
 * dropped whole on an identity change (`disposingForIdentityTeardown`), and
 * keyed by user and host as well as chat, so one account can never offer
 * another's rows.
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

function keyOf(key: SkeletonResumeCacheKey): string {
  return JSON.stringify([key.userId, key.hostId, key.epicId, key.chatId]);
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
  drop(cacheKey);
  if (!window.skeletonComplete || window.invalidated) return;
  const offer = buildSkeletonResumeOffer(window.skeleton, window.rowCount);
  if (offer === null) return;
  const entriesJson = JSON.stringify(offer.entries);
  // One chat larger than the whole budget is not cached at all, rather than
  // evicting everything else to make room it still would not have.
  if (entriesJson.length > SKELETON_RESUME_CACHE_MAX_CHARS) return;
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

/** Drop everything: the identity these skeletons belonged to is gone. */
export function forgetAllSkeletonsForResume(): void {
  cache.clear();
  cachedChars = 0;
}

/** The cache's size, for tests. */
export function skeletonResumeCacheStatsForTests(): {
  readonly chats: number;
  readonly chars: number;
} {
  return { chats: cache.size, chars: cachedChars };
}
