import {
  InMemoryChatPartCache,
  type ChatPartCache,
} from "@traycer-clients/shared/cloud-chat/part-cache";

/** The renderer's content-addressed store for published chat parts. */

/** The slice of `CacheStorage` this adapter actually uses. */
export interface ChatPartCacheStorage {
  open(name: string): Promise<ChatPartCacheStore>;
  delete(name: string): Promise<boolean>;
}

export interface ChatPartCacheStore {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

/**
 * Bumping this name is how a defect in what we STORE gets fixed - stale entries are simply abandoned under the old name and evicted as quota demands.
 * It is not a schema version: the entries have no schema, they are the bytes.
 */
const PART_CACHE_NAME = "traycer-chat-parts-v1";

/**
 * The Cache API keys on requests, so a digest is spelled as a URL under a reserved name.
 * `.invalid` is guaranteed never to resolve (RFC 2606), so a stray fetch of one of these keys cannot leave the machine.
 */
function requestFor(sha256: string): string {
  return `https://chat-parts.traycer.invalid/${sha256}`;
}

/** The store, over a `CacheStorage`. */
export function createCacheApiChatPartCache(
  storage: ChatPartCacheStorage,
): ChatPartCache {
  // Opened once and shared.
  // `open` on an existing name is cheap, but a read burst for a p99 chat is ~165 concurrent calls and there is no reason for each to pay it.
  let opened: Promise<ChatPartCacheStore> | null = null;
  const cache = (): Promise<ChatPartCacheStore> => {
    opened = opened ?? storage.open(PART_CACHE_NAME);
    return opened;
  };

  return {
    get: async (sha256) => {
      try {
        const hit = await (await cache()).match(requestFor(sha256));
        if (hit === undefined) return null;
        return new Uint8Array(await hit.arrayBuffer());
      } catch {
        // A store that cannot answer is a store that does not have it. The
        // reader refetches, which is the whole cost of every failure here.
        opened = null;
        return null;
      }
    },
    put: async (sha256, bytes) => {
      try {
        // A fresh ArrayBuffer, not the view: `bytes` may sit inside a larger buffer (every subarray does), and a `Response` built from the view's buffer would store the whole thing - bytes that then fail their own digest on the way back out.
        const body = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(body).set(bytes);
        await (await cache()).put(requestFor(sha256), new Response(body));
      } catch {
        // Quota exceeded, or a storage error. A failed `put` must never fail
        // the read that was going fine without it - see the cache contract.
        opened = null;
      }
    },
  };
}

/** The store this renderer should use, or a session-scoped one when there is no Cache API to use. */
export function resolveChatPartCache(
  storage: ChatPartCacheStorage | undefined,
): ChatPartCache {
  return storage === undefined
    ? new InMemoryChatPartCache()
    : createCacheApiChatPartCache(storage);
}

/** The `CacheStorage` this renderer actually has, or `undefined`. */
export function browserChatPartCacheStorage():
  | ChatPartCacheStorage
  | undefined {
  return typeof globalThis.caches === "undefined"
    ? undefined
    : globalThis.caches;
}

/** The renderer's one store, built on first use. */
let activeCache: ChatPartCache | null = null;

export function activeChatPartCache(): ChatPartCache {
  activeCache =
    activeCache ?? resolveChatPartCache(browserChatPartCacheStorage());
  return activeCache;
}

/** Drops every cached part, and the adapter holding them. */
export async function clearChatPartCache(
  storage: ChatPartCacheStorage | undefined,
): Promise<void> {
  activeCache = null;
  if (storage === undefined) return;
  try {
    await storage.delete(PART_CACHE_NAME);
  } catch {
    // Nothing a caller can do, and nothing that should fail a sign-out.
  }
}
