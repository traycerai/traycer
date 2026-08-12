import { describe, expect, it } from "vitest";
import { InMemoryChatPartCache } from "@traycer-clients/shared/cloud-chat/part-cache";
import {
  activeChatPartCache,
  clearChatPartCache,
  createCacheApiChatPartCache,
  resolveChatPartCache,
  type ChatPartCacheStorage,
  type ChatPartCacheStore,
} from "@/lib/chats/cloud-chat-part-cache";

/**
 * jsdom has no Cache API, so the storage is a stand-in - but a FAITHFUL one:
 * it keys on the request string, returns a real `Response`, and answers
 * `undefined` for a miss, which is the whole surface this adapter uses.
 *
 * The assertions are on the stand-in's own state, not on whether a method was
 * called. "Did `put` run" is satisfied by an adapter that stores the wrong
 * bytes under the wrong key; "what is in the store, under what key" is not.
 */

class FakeCache implements ChatPartCacheStore {
  readonly entries = new Map<string, Uint8Array>();
  failNextPut = false;
  failNextMatch = false;

  match(request: string): Promise<Response | undefined> {
    if (this.failNextMatch) {
      this.failNextMatch = false;
      return Promise.reject(new Error("storage unavailable"));
    }
    const bytes = this.entries.get(request);
    if (bytes === undefined) return Promise.resolve(undefined);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return Promise.resolve(new Response(body));
  }

  async put(request: string, response: Response): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("QuotaExceededError");
    }
    this.entries.set(request, new Uint8Array(await response.arrayBuffer()));
  }
}

class FakeCacheStorage implements ChatPartCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  opens = 0;
  deleted: string[] = [];

  open(name: string): Promise<FakeCache> {
    this.opens += 1;
    const existing = this.caches.get(name);
    if (existing !== undefined) return Promise.resolve(existing);
    const created = new FakeCache();
    this.caches.set(name, created);
    return Promise.resolve(created);
  }

  delete(name: string): Promise<boolean> {
    this.deleted.push(name);
    return Promise.resolve(this.caches.delete(name));
  }
}

const DIGEST =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("round trip", () => {
  it("returns exactly the bytes it stored", async () => {
    const fake = new FakeCacheStorage();
    const cache = createCacheApiChatPartCache(fake);
    const bytes = new Uint8Array([0, 1, 254, 255]);

    await cache.put(DIGEST, bytes);

    expect(await cache.get(DIGEST)).toEqual(bytes);
  });

  it("keys on the digest under a name that cannot leave the machine", async () => {
    const fake = new FakeCacheStorage();
    await createCacheApiChatPartCache(fake).put(DIGEST, new Uint8Array([1]));

    const store = fake.caches.get("traycer-chat-parts-v1");
    expect(store).toBeDefined();
    // `.invalid` never resolves (RFC 2606), so a stray fetch of a cache key
    // cannot become a request.
    expect([...(store?.entries.keys() ?? [])]).toEqual([
      `https://chat-parts.traycer.invalid/${DIGEST}`,
    ]);
  });

  it("stores a VIEW's bytes, not the buffer it happens to sit in", async () => {
    const fake = new FakeCacheStorage();
    const cache = createCacheApiChatPartCache(fake);
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);

    await cache.put(DIGEST, backing.subarray(2, 5));

    // A part staged out of a larger buffer is the ordinary case, and storing
    // the whole buffer would hand back bytes that fail their own digest.
    expect(await cache.get(DIGEST)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("answers null for a digest it does not hold", async () => {
    const fake = new FakeCacheStorage();
    expect(await createCacheApiChatPartCache(fake).get(DIGEST)).toBeNull();
  });

  it("opens the store once across a burst of reads", async () => {
    const fake = new FakeCacheStorage();
    const cache = createCacheApiChatPartCache(fake);

    // A p99 chat is ~165 parts fetched concurrently; each paying an `open`
    // would be 165 round trips through storage for one handle.
    await Promise.all(Array.from({ length: 20 }, () => cache.get(DIGEST)));

    expect(fake.opens).toBe(1);
  });
});

describe("failing softly", () => {
  it("swallows a quota failure - a read must not fail because a store did", async () => {
    const fake = new FakeCacheStorage();
    const cache = createCacheApiChatPartCache(fake);
    const store = await fake.open("traycer-chat-parts-v1");
    store.failNextPut = true;

    await expect(
      cache.put(DIGEST, new Uint8Array([1])),
    ).resolves.toBeUndefined();
    expect(await cache.get(DIGEST)).toBeNull();
  });

  it("treats a storage error on read as a miss, and recovers after it", async () => {
    const fake = new FakeCacheStorage();
    const cache = createCacheApiChatPartCache(fake);
    await cache.put(DIGEST, new Uint8Array([5]));
    const store = await fake.open("traycer-chat-parts-v1");
    store.failNextMatch = true;

    expect(await cache.get(DIGEST)).toBeNull();
    // The handle is dropped on failure and re-opened, so one bad moment does
    // not turn the cache off for the rest of the session.
    expect(await cache.get(DIGEST)).toEqual(new Uint8Array([5]));
  });
});

describe("choosing a store", () => {
  it("falls back to a session-scoped cache when there is no Cache API", () => {
    expect(resolveChatPartCache(undefined)).toBeInstanceOf(
      InMemoryChatPartCache,
    );
  });

  it("uses the Cache API when there is one", async () => {
    const fake = new FakeCacheStorage();
    const cache = resolveChatPartCache(fake);

    await cache.put(DIGEST, new Uint8Array([1]));

    expect(fake.caches.get("traycer-chat-parts-v1")?.entries.size).toBe(1);
  });
});

describe("clearing", () => {
  it("drops the whole store, and is a no-op without one", async () => {
    const fake = new FakeCacheStorage();
    await createCacheApiChatPartCache(fake).put(DIGEST, new Uint8Array([1]));

    await clearChatPartCache(fake);

    expect(fake.deleted).toEqual(["traycer-chat-parts-v1"]);
    expect(fake.caches.has("traycer-chat-parts-v1")).toBe(false);
    await expect(clearChatPartCache(undefined)).resolves.toBeUndefined();
  });

  it("drops the ADAPTER too, not just the storage entry", async () => {
    // jsdom has no Cache API, so `activeChatPartCache()` resolves the in-memory
    // fallback - the environment the storage-only clear could never reach, since
    // `CacheStorage` never knew about that store. The Cache-API case fails the
    // same way for a different reason: `delete` unlinks a NAME, and an adapter
    // that already resolved its `Cache` keeps serving the deleted object.
    const before = activeChatPartCache();
    await before.put(DIGEST, new Uint8Array([1]));
    expect(await before.get(DIGEST)).toEqual(new Uint8Array([1]));

    await clearChatPartCache(undefined);

    const after = activeChatPartCache();
    expect(after).not.toBe(before);
    expect(await after.get(DIGEST)).toBeNull();
  });
});
