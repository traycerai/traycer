import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createStore,
  del as idbDel,
  get as idbGet,
  keys as idbKeys,
  set as idbSet,
} from "idb-keyval";

import {
  deleteImageBytesUnchecked,
  getImageBytes,
  hasLandingImageBytes,
  imageHashKeys,
  imageStore,
  landingImagePartition,
  putImage,
  releaseSession,
  sessionHashKeys,
  sessionImageBytes,
  sessionObjectUrl,
} from "@/lib/composer/landing-image-store";

// In-memory stand-in for idb-keyval, ONE MAP PER DATABASE. The store argument is
// not decoration here: this module keeps image bytes and their measured sizes in
// two different databases under the SAME string hash, so a stand-in that folds
// every store into one map lets a size silently overwrite an image.
const idb = vi.hoisted(() => {
  const byDb = new Map<string, Map<string, unknown>>();
  const dbNameOf = new Map<unknown, string>();
  function dataFor(store: unknown): Map<string, unknown> {
    const dbName = dbNameOf.get(store) ?? "unregistered";
    const existing = byDb.get(dbName);
    if (existing !== undefined) return existing;
    const created = new Map<string, unknown>();
    byDb.set(dbName, created);
    return created;
  }
  function dataForDb(suffix: string): Map<string, unknown> {
    for (const [dbName, data] of byDb) {
      if (dbName.endsWith(suffix)) return data;
    }
    const created = new Map<string, unknown>();
    byDb.set(`pending:${suffix}`, created);
    return created;
  }
  return {
    byDb,
    dbNameOf,
    dataFor,
    dataForDb,
    /** The image BYTES database - what the tests below assert about. */
    images: (): Map<string, unknown> => dataForDb(":landing-images"),
    clear: (): void => {
      byDb.clear();
    },
  };
});

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("landing image store keys are string hashes");
  }
  return key;
}

vi.mock("idb-keyval", () => ({
  createStore: vi.fn((dbName: string, _storeName: string) => {
    const handle = (): Promise<never> =>
      Promise.reject(new Error("unused in tests"));
    idb.dbNameOf.set(handle, dbName);
    return handle;
  }),
  get: vi.fn((key: IDBValidKey, store: unknown) =>
    Promise.resolve(idb.dataFor(store).get(idbStringKey(key))),
  ),
  set: vi.fn((key: IDBValidKey, value: unknown, store: unknown) => {
    idb.dataFor(store).set(idbStringKey(key), value);
    return Promise.resolve();
  }),
  del: vi.fn((key: IDBValidKey, store: unknown) => {
    idb.dataFor(store).delete(idbStringKey(key));
    return Promise.resolve();
  }),
  keys: vi.fn((store: unknown) =>
    Promise.resolve(Array.from(idb.dataFor(store).keys())),
  ),
  entries: vi.fn((store: unknown) =>
    Promise.resolve(Array.from(idb.dataFor(store).entries())),
  ),
}));

let urlCounter = 0;
const createObjectURL = vi.fn(
  (_obj: Blob | MediaSource) => `blob:mock/${++urlCounter}`,
);
const revokeObjectURL = vi.fn((_url: string) => undefined);

/**
 * Re-apply the stand-in implementations. One case installs a one-shot rejecting
 * `get`/`set`, and `vi.clearAllMocks()` between cases drops implementations, so
 * every case starts from this.
 */
function installIdbWorking(): void {
  vi.mocked(idbGet).mockImplementation((key, store) =>
    Promise.resolve(idb.dataFor(store).get(idbStringKey(key))),
  );
  vi.mocked(idbSet).mockImplementation((key, value, store) => {
    idb.dataFor(store).set(idbStringKey(key), value);
    return Promise.resolve();
  });
  vi.mocked(idbDel).mockImplementation((key, store) => {
    idb.dataFor(store).delete(idbStringKey(key));
    return Promise.resolve();
  });
  vi.mocked(idbKeys).mockImplementation((store) =>
    Promise.resolve(Array.from(idb.dataFor(store).keys())),
  );
}

/**
 * Durable writes of IMAGE BYTES. A put also records the measured byte length in
 * the sizes database, so a bare call count on `set` no longer answers "how many
 * times were the bytes written".
 */
function byteWriteCount(): number {
  return vi
    .mocked(idbSet)
    .mock.calls.filter(([, value]) => value instanceof Uint8Array).length;
}

function bytesOf(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

describe("landing-image-store", () => {
  beforeEach(async () => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    installIdbWorking();
    // Drain the in-memory IndexedDB stand-in through the public API so each case
    // starts empty, then zero the spy call counts.
    for (const hash of await imageHashKeys()) {
      await deleteImageBytesUnchecked(hash);
      releaseSession(hash);
    }
    vi.clearAllMocks();
    installIdbWorking();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "runnerHost");
  });

  it("hashes by content: identical bytes write to IndexedDB exactly once", async () => {
    const bytes = bytesOf([1, 2, 3, 4]);

    const first = await putImage(bytesOf([1, 2, 3, 4]));
    const second = await putImage(bytesOf([1, 2, 3, 4]));

    expect(first).toBe(second);
    // SHA-256 hex is 64 chars.
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(byteWriteCount()).toBe(1);
    // Different content → different hash → a second write.
    await putImage(bytesOf([9, 9, 9]));
    expect(byteWriteCount()).toBe(2);
    expect(bytes).toEqual(bytesOf([1, 2, 3, 4]));
  });

  it("round-trips put → get → keys → delete", async () => {
    const hash = await putImage(bytesOf([10, 20, 30]));

    expect(await getImageBytes(hash)).toEqual(bytesOf([10, 20, 30]));
    expect(await imageHashKeys()).toContain(hash);

    await deleteImageBytesUnchecked(hash);
    releaseSession(hash);

    expect(await imageHashKeys()).not.toContain(hash);
    expect(await getImageBytes(hash)).toBeUndefined();
  });

  it("creates a session object-URL on put and revokes it on release", async () => {
    const hash = await putImage(bytesOf([7, 7, 7]));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    const url = sessionObjectUrl(hash);
    expect(url).toBe(createObjectURL.mock.results[0]?.value);

    releaseSession(hash);

    expect(revokeObjectURL).toHaveBeenCalledWith(url);
    expect(sessionObjectUrl(hash)).toBeNull();
  });

  it("does not create a second object-URL for a repeat put of the same bytes", async () => {
    await putImage(bytesOf([5, 5]));
    await putImage(bytesOf([5, 5]));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("reads session bytes synchronously and drops them on release", async () => {
    expect(sessionImageBytes("absent")).toBeNull();

    const hash = await putImage(bytesOf([3, 1, 4, 1, 5]));

    expect(sessionImageBytes(hash)).toEqual(bytesOf([3, 1, 4, 1, 5]));

    releaseSession(hash);

    expect(sessionImageBytes(hash)).toBeNull();
  });

  it("exposes session hashes as GC roots, reflecting puts and releases", async () => {
    expect(sessionHashKeys()).toEqual([]);

    const a = await putImage(bytesOf([1, 1]));
    const b = await putImage(bytesOf([2, 2]));

    expect(sessionHashKeys().sort()).toEqual([a, b].sort());

    releaseSession(a);

    expect(sessionHashKeys()).toEqual([b]);
  });

  it("resolves the partition and DB name: windowId on desktop, default in browser", () => {
    // Browser / no desktop global → "default".
    expect(landingImagePartition()).toBe("default");

    // Desktop: imperative read of runnerHost.windows.windowId. Switching the
    // partition re-opens the store, so createStore sees the desktop DB name.
    Reflect.set(globalThis, "runnerHost", {
      windows: { windowId: "win-123" },
    });
    expect(landingImagePartition()).toBe("win-123");
    imageStore();
    expect(createStore).toHaveBeenLastCalledWith(
      "traycer-gui-app:win-123:landing-images",
      "bytes",
    );

    // Empty / malformed windowId falls back to "default"; switching back re-opens
    // the store under the browser DB name.
    Reflect.set(globalThis, "runnerHost", { windows: { windowId: "" } });
    expect(landingImagePartition()).toBe("default");
    imageStore();
    expect(createStore).toHaveBeenLastCalledWith(
      "traycer-gui-app:default:landing-images",
      "bytes",
    );
  });

  it("hasLandingImageBytes: IDB-only restored hash is absent until getImageBytes, then present, then pruned on delete", async () => {
    // Simulate a restored draft image: bytes already in IndexedDB from a prior
    // session, but no session put and no knownHashes seed yet.
    const restoredHash = "a".repeat(64);
    const bytes = bytesOf([42, 43, 44]);
    await idbSet(restoredHash, bytes, imageStore());

    expect(hasLandingImageBytes(restoredHash)).toBe(false);

    // Render path: fetcher reads through getImageBytes, which seeds knownHashes.
    expect(await getImageBytes(restoredHash)).toEqual(bytes);
    expect(hasLandingImageBytes(restoredHash)).toBe(true);

    await deleteImageBytesUnchecked(restoredHash);
    expect(hasLandingImageBytes(restoredHash)).toBe(false);
    expect(await getImageBytes(restoredHash)).toBeUndefined();
  });

  it("hasLandingImageBytes: IDB keys enumeration seeds presence without getImageBytes", async () => {
    // Blob-cache hit path: a restored hash has durable bytes, but render reused
    // an app-wide object URL so the per-surface fetcher / getImageBytes never ran.
    const restoredHash = "b".repeat(64);
    const bytes = bytesOf([55, 56, 57]);
    await idbSet(restoredHash, bytes, imageStore());

    expect(hasLandingImageBytes(restoredHash)).toBe(false);

    // Enumerating durable keys (also done once at module init) folds them in.
    expect(await imageHashKeys()).toContain(restoredHash);
    expect(hasLandingImageBytes(restoredHash)).toBe(true);
    // Still no session entry - only knownHashes was seeded from keys.
    expect(sessionObjectUrl(restoredHash)).toBeNull();
    expect(sessionImageBytes(restoredHash)).toBeNull();
  });

  it("putImage rolls back session/knownHashes/object-URL when idb set fails for a new hash", async () => {
    vi.mocked(idbSet).mockRejectedValueOnce(new Error("idb write failed"));

    const bytes = bytesOf([8, 8, 8]);
    await expect(putImage(bytes)).rejects.toThrow("idb write failed");

    const failedHash = await sha256Hex(bytes);
    expect(hasLandingImageBytes(failedHash)).toBe(false);
    expect(sessionHashKeys()).toEqual([]);
    expect(sessionObjectUrl(failedHash)).toBeNull();
    expect(sessionImageBytes(failedHash)).toBeNull();
    expect(await imageHashKeys()).not.toContain(failedHash);
    // Optimistic object-URL was revoked as part of the rollback.
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it("putImage leaves a dedupe hit intact when the hash is already cached", async () => {
    const bytes = bytesOf([9, 9, 9]);
    const hash = await putImage(bytes);
    const urlBefore = sessionObjectUrl(hash);
    expect(urlBefore).not.toBeNull();
    expect(hasLandingImageBytes(hash)).toBe(true);

    const setCallsBefore = vi.mocked(idbSet).mock.calls.length;
    // Any unexpected durable write would fail; the dedupe path must skip set
    // entirely so the already-cached session/knownHashes entry stays intact.
    vi.mocked(idbSet).mockImplementation(() =>
      Promise.reject(new Error("idb write failed")),
    );
    const again = await putImage(bytes);

    expect(again).toBe(hash);
    // set was not invoked for the dedupe hit.
    expect(vi.mocked(idbSet).mock.calls.length).toBe(setCallsBefore);
    expect(hasLandingImageBytes(hash)).toBe(true);
    expect(sessionObjectUrl(hash)).toBe(urlBefore);
    expect(sessionImageBytes(hash)).toEqual(bytes);
    expect(await getImageBytes(hash)).toEqual(bytes);

    // beforeEach reinstalls a working set for the next case.
    installIdbWorking();
  });

  // Finding 4: concurrent same-hash callers join one write; a failed durable
  // write rolls back cleanly without leaving torn session/knownHashes state.
  it("putImage single-flights concurrent same-hash callers and rolls back cleanly on set failure", async () => {
    const bytes = bytesOf([4, 4, 4, 4]);
    const failedHash = await sha256Hex(bytes);

    // Gate the durable write on a shared promise so the second same-hash caller
    // joins while the first flight is still in-flight (not after it settles).
    let rejectSet: (error: Error) => void = () => undefined;
    const gatedSet = new Promise<void>((_resolve, reject) => {
      rejectSet = reject;
    });
    // Prevent unhandled-rejection noise if handlers attach after reject.
    void gatedSet.catch(() => undefined);
    vi.mocked(idbGet).mockImplementation((key) =>
      Promise.resolve(idb.images().get(idbStringKey(key))),
    );
    vi.mocked(idbSet).mockImplementation(() => gatedSet);

    const first = putImage(bytesOf([4, 4, 4, 4]));
    await vi.waitFor(() => {
      expect(idbSet).toHaveBeenCalled();
    });
    expect(vi.mocked(idbSet).mock.calls[0]?.[0]).toBe(failedHash);

    const second = putImage(bytesOf([4, 4, 4, 4]));
    // Joiner shares the in-flight write — still a single set call.
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(idbSet).mock.calls.length).toBe(1);

    // Attach handlers before rejecting so the rejection is never unhandled.
    const settled = Promise.allSettled([first, second]);
    rejectSet(new Error("idb write failed"));
    const results = await settled;
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") continue;
      expect(result.reason).toBeInstanceOf(Error);
      if (!(result.reason instanceof Error)) continue;
      expect(result.reason.message).toBe("idb write failed");
    }

    // No torn state: presence false, no session, no durable bytes.
    expect(hasLandingImageBytes(failedHash)).toBe(false);
    expect(sessionHashKeys()).toEqual([]);
    expect(sessionObjectUrl(failedHash)).toBeNull();
    expect(sessionImageBytes(failedHash)).toBeNull();
    expect(await imageHashKeys()).not.toContain(failedHash);
    expect(idb.images().has(failedHash)).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalled();

    installIdbWorking();
  });

  // Finding 6: prune knownHashes only AFTER del resolves.
  it("deleteImageBytesUnchecked keeps hasLandingImageBytes true when del rejects (bytes still present)", async () => {
    const hash = await putImage(bytesOf([6, 6, 6]));
    expect(hasLandingImageBytes(hash)).toBe(true);
    expect(idb.images().has(hash)).toBe(true);

    vi.mocked(idbDel).mockRejectedValueOnce(new Error("idb del failed"));

    await expect(deleteImageBytesUnchecked(hash)).rejects.toThrow(
      "idb del failed",
    );

    // Presence must remain true: durable bytes are still there.
    expect(hasLandingImageBytes(hash)).toBe(true);
    expect(idb.images().has(hash)).toBe(true);
    expect(await getImageBytes(hash)).toEqual(bytesOf([6, 6, 6]));

    installIdbWorking();
  });
});

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
