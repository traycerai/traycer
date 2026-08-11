import {
  InMemoryChatPartCache,
  type ChatPartCache,
} from "@traycer-clients/shared/cloud-chat/part-cache";

/**
 * The renderer's content-addressed store for published chat parts.
 *
 * ## Cache API rather than IndexedDB
 *
 * Both were viable and the Cache API wins on the two things that matter here.
 * It is built for opaque byte bodies, so a part is one `Response` rather than a
 * blob column plus a schema plus a migration story. And its eviction is the
 * browser's, under the origin's quota - which is exactly the policy this cache
 * wants, because eviction is the ONLY policy it has. A part is named by the
 * sha256 of its own bytes, so an entry can never be stale, only absent; there
 * is nothing to invalidate and nothing to version. Losing an entry costs one
 * refetch.
 *
 * ## One store for every viewer on the installation, deliberately
 *
 * Chat parts are chat CONTENT, so sharing a store across signed-in users looks
 * like a leak and is not one. A digest is unguessable and unlisted: the only
 * way to learn a part's address is to resolve a head the server authorized you
 * for, and the only way to read a cached entry is to know its address. A second
 * viewer who can name a digest is a viewer the server already let read that
 * chat. Partitioning per viewer would therefore buy no confidentiality and cost
 * the whole dedup - two accounts on one machine reading the same shared task
 * would hold two copies of every shard.
 *
 * What it does NOT survive is a deliberate sign-out: {@link clearChatPartCache}
 * exists for that, because "leave the account" reasonably means "leave the
 * content", and the cost of honoring it is a cold read next time.
 */

/**
 * The slice of `CacheStorage` this adapter actually uses.
 *
 * Narrowed rather than taking the DOM type whole, for the reason every port in
 * this reader is narrowed: it states the real dependency, and it lets a test
 * supply a faithful stand-in without a chained cast through `unknown`. The real
 * `CacheStorage` satisfies it structurally - its methods accept WIDER request
 * types than `string` - so nothing at the call site changes.
 */
export interface ChatPartCacheStorage {
  open(name: string): Promise<ChatPartCacheStore>;
  delete(name: string): Promise<boolean>;
}

export interface ChatPartCacheStore {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

/**
 * Bumping this name is how a defect in what we STORE gets fixed - stale entries
 * are simply abandoned under the old name and evicted as quota demands. It is
 * not a schema version: the entries have no schema, they are the bytes.
 */
const PART_CACHE_NAME = "traycer-chat-parts-v1";

/**
 * The Cache API keys on requests, so a digest is spelled as a URL under a
 * reserved name. `.invalid` is guaranteed never to resolve (RFC 2606), so a
 * stray fetch of one of these keys cannot leave the machine.
 */
function requestFor(sha256: string): string {
  return `https://chat-parts.traycer.invalid/${sha256}`;
}

/**
 * The store, over a `CacheStorage`.
 *
 * Takes the storage rather than reaching for the `caches` global so a test can
 * drive it, and so the "no secure context, no Cache API" fallback below is a
 * decision at one call site instead of a `typeof` check buried in every method.
 */
export function createCacheApiChatPartCache(
  storage: ChatPartCacheStorage,
): ChatPartCache {
  // Opened once and shared. `open` on an existing name is cheap, but a read
  // burst for a p99 chat is ~165 concurrent calls and there is no reason for
  // each to pay it.
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
        // A fresh ArrayBuffer, not the view: `bytes` may sit inside a larger
        // buffer (every subarray does), and a `Response` built from the view's
        // buffer would store the whole thing - bytes that then fail their own
        // digest on the way back out.
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

/**
 * The store this renderer should use, or a session-scoped one when there is no
 * Cache API to use.
 *
 * The fallback is not a degradation to nothing: within one session a reader
 * that scrolls back into a chat still asks the host for no parts at all. What
 * it loses is the across-restart property, which is the interesting half.
 */
export function resolveChatPartCache(
  storage: ChatPartCacheStorage | undefined,
): ChatPartCache {
  return storage === undefined
    ? new InMemoryChatPartCache()
    : createCacheApiChatPartCache(storage);
}

/**
 * The `CacheStorage` this renderer actually has, or `undefined`.
 *
 * One spelling of the `typeof` probe, because there are now two callers with
 * opposite jobs - the reader that opens the store and the sign-out that drops it
 * - and two copies of "which storage" is how one of them ends up looking at a
 * different one. `undefined` outside a secure context (and in jsdom), which both
 * callers already handle: the reader falls back to a session-scoped store, and
 * the clear has nothing to do.
 */
export function browserChatPartCacheStorage():
  ChatPartCacheStorage | undefined {
  return typeof globalThis.caches === "undefined"
    ? undefined
    : globalThis.caches;
}

/**
 * The renderer's one store, built on first use.
 *
 * Module-level rather than per-caller for the reason the adapter opens its Cache
 * once: a p99 chat is ~165 concurrent gets and they should all reach the same
 * store. Owned HERE, next to the clear, because the two are one mechanism -
 * dropping the entries without dropping the handle that holds them clears
 * nothing (see {@link clearChatPartCache}).
 */
let activeCache: ChatPartCache | null = null;

export function activeChatPartCache(): ChatPartCache {
  activeCache =
    activeCache ?? resolveChatPartCache(browserChatPartCacheStorage());
  return activeCache;
}

/**
 * Drops every cached part, and the adapter holding them.
 *
 * For sign-out. Deliberately a plain function rather than a method on the cache:
 * clearing is not something a reader ever does, and putting it on the interface
 * would invite one to.
 *
 * Both halves are load-bearing, and deleting the storage entry alone was neither
 * of them for two live cases. `CacheStorage.delete` unlinks a NAME: an adapter
 * that already resolved its `Cache` keeps a working handle to the deleted
 * object, so it goes on serving - and storing - the signed-out account's bytes
 * for the life of the renderer. And where there is no Cache API at all the store
 * is the in-memory fallback, which `CacheStorage` never knew about, so the clear
 * was a no-op over the very environment the fallback exists for.
 *
 * Dropping the singleton covers both: the next read builds a fresh adapter over
 * a fresh cache. Ordered first, so an account's bytes stop being reachable even
 * if the storage delete then fails.
 */
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
