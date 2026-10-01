import {
  IDBFactory as FakeIDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
} from "fake-indexeddb";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  buildSkeletonResumeOffer,
  SKELETON_RESUME_BLOCK_SIZE,
} from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";
import {
  clearAllSkeletonsForResume,
  dropMemorySkeletonsForTests,
  hydrateSkeletonForResume,
  primeDurableSkeletonsForResume,
  readSkeletonForResume,
  rememberSkeletonForResume,
  shouldLoadDurableSkeletonForResume,
} from "@/stores/chats/skeleton-resume-cache";
import {
  drainDurableSkeletonWritesForTests,
  hasDurableSkeletonHint,
  hintedDurableSkeletonKeysForUser,
  saveDurableSkeleton,
  SKELETON_RESUME_DB_NAME,
  skeletonResumeStorageKey,
} from "@/stores/chats/skeleton-resume-durable-cache";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";

const KEY = {
  userId: "user-1",
  hostId: "host-1",
  epicId: "epic-1",
  chatId: "chat-1",
};

function entries(): RowSkeletonEntry[] {
  return Array.from({ length: SKELETON_RESUME_BLOCK_SIZE }, (_, ordinal) => ({
    rowId: `row-${ordinal}`,
    createdAt: ordinal,
    role: "user",
    byteLength: 10,
    bodyDigest: `digest-${ordinal}`,
    preview: `first line ${ordinal}`,
  }));
}

function isObjectStoreGetAll(
  value: unknown,
): value is (this: IDBObjectStore) => IDBRequest<unknown[]> {
  return typeof value === "function";
}

function isObjectStoreGet(
  value: unknown,
): value is (
  this: IDBObjectStore,
  query: IDBValidKey | IDBKeyRange,
) => IDBRequest<unknown> {
  return typeof value === "function";
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("IndexedDB request failed"));
  });
}

function requestHasResult(request: IDBRequest): Promise<boolean> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result !== undefined);
    request.onerror = () => reject(new Error("IndexedDB request failed"));
  });
}

async function waitForTeardown(
  teardown: Promise<void> | null,
  errorMessage: string,
): Promise<void> {
  if (teardown === null) throw new Error(errorMessage);
  await teardown;
}

async function physicalSkeletonFor(key: string): Promise<{
  readonly entryExists: boolean;
  readonly metaExists: boolean;
  readonly entryKeys: readonly IDBValidKey[];
  readonly metaKeys: readonly IDBValidKey[];
}> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(SKELETON_RESUME_DB_NAME, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("IndexedDB open failed"));
  });
  const tx = db.transaction(["entries", "meta"], "readonly");
  const entriesStore = tx.objectStore("entries");
  const metaStore = tx.objectStore("meta");
  const requests = {
    entryExists: requestHasResult(entriesStore.get(key)),
    metaExists: requestHasResult(metaStore.get(key)),
    entryKeys: requestResult(entriesStore.getAllKeys()),
    metaKeys: requestResult(metaStore.getAllKeys()),
  };
  const entryExists = await requests.entryExists;
  const metaExists = await requests.metaExists;
  const entryKeys = await requests.entryKeys;
  const metaKeys = await requests.metaKeys;
  return { entryExists, metaExists, entryKeys, metaKeys };
}

beforeAll(() => {
  globalThis.indexedDB = new FakeIDBFactory();
});

beforeEach(async () => {
  await clearAllSkeletonsForResume();
});

describe("durable skeleton resume", () => {
  it("does no IndexedDB read for a cold miss, then survives a WebView eviction", async () => {
    expect(shouldLoadDurableSkeletonForResume(KEY)).toBe(false);
    const skeleton = entries();
    rememberSkeletonForResume(KEY, {
      ...emptyTranscriptWindow(),
      skeleton,
      rowCount: skeleton.length,
      skeletonComplete: true,
      skeletonStreamCoveredThrough: skeleton.length,
    });
    await drainDurableSkeletonWritesForTests();
    dropMemorySkeletonsForTests();

    expect(shouldLoadDurableSkeletonForResume(KEY)).toBe(true);
    // Loading an offer does not publish it into any transcript window.
    await hydrateSkeletonForResume(KEY);
    expect(readSkeletonForResume(KEY)?.readEntries()).toEqual(skeleton);
  });

  it("partitions by account and erases the durable presence on identity reset", async () => {
    const storageKey = skeletonResumeStorageKey(KEY);
    await saveDurableSkeleton(storageKey, {
      claim: { derivation: 1, blockSize: 256, blockDigests: ["digest"] },
      entriesJson: "[]",
    });
    expect(hasDurableSkeletonHint(storageKey)).toBe(true);
    expect(
      hasDurableSkeletonHint(
        skeletonResumeStorageKey({ ...KEY, userId: "user-2" }),
      ),
    ).toBe(false);
    await clearAllSkeletonsForResume();
    expect(hasDurableSkeletonHint(storageKey)).toBe(false);
    expect(shouldLoadDurableSkeletonForResume(KEY)).toBe(false);
  });

  it("fences an in-flight account write during identity teardown and preserves the next account", async () => {
    const accountAKey = skeletonResumeStorageKey(KEY);
    const accountB = { ...KEY, userId: "user-2" };
    const accountBKey = skeletonResumeStorageKey(accountB);
    const accountAEntries = entries();
    let teardown: Promise<void> | null = null;
    const originalGetAllCandidate: unknown = Object.getOwnPropertyDescriptor(
      FakeIDBObjectStore.prototype,
      "getAll",
    )?.value;
    if (!isObjectStoreGetAll(originalGetAllCandidate)) {
      throw new Error("Expected fake IndexedDB getAll implementation");
    }
    const originalGetAll = originalGetAllCandidate;
    const getAllSpy = vi
      .spyOn(FakeIDBObjectStore.prototype, "getAll")
      .mockImplementation(function (this: IDBObjectStore) {
        const request = originalGetAll.call(this);
        if (this.name === "meta" && teardown === null) {
          // The A save has opened its readwrite transaction and queued the
          // metadata read, but its onsuccess handler has not run. Bump the
          // identity fence at precisely that in-flight point.
          teardown = clearAllSkeletonsForResume();
        }
        return request;
      });
    try {
      rememberSkeletonForResume(KEY, {
        ...emptyTranscriptWindow(),
        skeleton: accountAEntries,
        rowCount: accountAEntries.length,
        skeletonComplete: true,
        skeletonStreamCoveredThrough: accountAEntries.length,
      });
      expect(readSkeletonForResume(KEY)?.readEntries()).toEqual(
        accountAEntries,
      );

      await drainDurableSkeletonWritesForTests();
      await waitForTeardown(
        teardown,
        "Expected teardown during account A's metadata read",
      );
    } finally {
      getAllSpy.mockRestore();
    }
    await drainDurableSkeletonWritesForTests();

    expect(readSkeletonForResume(KEY)).toBeNull();
    expect(hasDurableSkeletonHint(accountAKey)).toBe(false);
    expect(hintedDurableSkeletonKeysForUser(KEY.userId)).toEqual([]);

    const accountBEntries = entries().map((entry) => ({
      ...entry,
      rowId: `account-b-${entry.rowId}`,
      bodyDigest: `account-b-${entry.bodyDigest}`,
    }));
    const offer = buildSkeletonResumeOffer(
      accountBEntries,
      accountBEntries.length,
    );
    if (offer === null) throw new Error("Expected one complete block");
    await saveDurableSkeleton(accountBKey, {
      claim: offer.claim,
      entriesJson: JSON.stringify(offer.entries),
    });

    const [accountA, accountBPhysical] = await Promise.all([
      physicalSkeletonFor(accountAKey),
      physicalSkeletonFor(accountBKey),
    ]);
    expect(accountA.entryExists).toBe(false);
    expect(accountA.metaExists).toBe(false);
    expect(accountA.entryKeys).not.toContain(accountAKey);
    expect(accountA.metaKeys).not.toContain(accountAKey);
    expect(accountBPhysical.entryExists).toBe(true);
    expect(accountBPhysical.metaExists).toBe(true);
    expect(accountBPhysical.entryKeys).toContain(accountBKey);
    expect(accountBPhysical.metaKeys).toContain(accountBKey);
    expect(hasDurableSkeletonHint(accountAKey)).toBe(false);
    expect(hasDurableSkeletonHint(accountBKey)).toBe(true);
    expect(hintedDurableSkeletonKeysForUser(KEY.userId)).toEqual([]);
    expect(hintedDurableSkeletonKeysForUser(accountB.userId)).toEqual([
      accountB,
    ]);
  });

  it("fences an in-flight stale hydration at identity teardown", async () => {
    const accountAKey = skeletonResumeStorageKey(KEY);
    const accountB = { ...KEY, userId: "user-2" };
    const accountBKey = skeletonResumeStorageKey(accountB);
    const accountAEntries = entries();
    const accountAOffer = buildSkeletonResumeOffer(
      accountAEntries,
      accountAEntries.length,
    );
    if (accountAOffer === null) throw new Error("Expected one complete block");
    await saveDurableSkeleton(accountAKey, {
      claim: accountAOffer.claim,
      entriesJson: JSON.stringify(accountAOffer.entries),
    });
    dropMemorySkeletonsForTests();

    let teardown: Promise<void> | null = null;
    const originalGetCandidate: unknown = Object.getOwnPropertyDescriptor(
      FakeIDBObjectStore.prototype,
      "get",
    )?.value;
    if (!isObjectStoreGet(originalGetCandidate)) {
      throw new Error("Expected fake IndexedDB get implementation");
    }
    const originalGet = originalGetCandidate;
    const getSpy = vi
      .spyOn(FakeIDBObjectStore.prototype, "get")
      .mockImplementation(function (
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ) {
        const request = originalGet.call(this, query);
        if (
          this.name === "entries" &&
          query === accountAKey &&
          teardown === null
        ) {
          // The durable read is queued, but loadDurableSkeleton's onsuccess
          // has not yet observed its value. Reset the identity fence now.
          teardown = clearAllSkeletonsForResume();
        }
        return request;
      });
    try {
      await hydrateSkeletonForResume(KEY);
      await waitForTeardown(
        teardown,
        "Expected teardown during account A's entry read",
      );
    } finally {
      getSpy.mockRestore();
    }
    await drainDurableSkeletonWritesForTests();

    expect(readSkeletonForResume(KEY)).toBeNull();
    expect(hasDurableSkeletonHint(accountAKey)).toBe(false);
    expect(hintedDurableSkeletonKeysForUser(KEY.userId)).toEqual([]);
    const accountAPhysical = await physicalSkeletonFor(accountAKey);
    expect(accountAPhysical.entryExists).toBe(false);
    expect(accountAPhysical.metaExists).toBe(false);
    expect(accountAPhysical.entryKeys).not.toContain(accountAKey);
    expect(accountAPhysical.metaKeys).not.toContain(accountAKey);

    const accountBEntries = entries().map((entry) => ({
      ...entry,
      rowId: `account-b-${entry.rowId}`,
      bodyDigest: `account-b-${entry.bodyDigest}`,
    }));
    const accountBOffer = buildSkeletonResumeOffer(
      accountBEntries,
      accountBEntries.length,
    );
    if (accountBOffer === null) throw new Error("Expected one complete block");
    await saveDurableSkeleton(accountBKey, {
      claim: accountBOffer.claim,
      entriesJson: JSON.stringify(accountBOffer.entries),
    });
    const accountBPhysical = await physicalSkeletonFor(accountBKey);
    expect(accountBPhysical.entryExists).toBe(true);
    expect(accountBPhysical.metaExists).toBe(true);
    expect(accountBPhysical.entryKeys).toContain(accountBKey);
    expect(accountBPhysical.metaKeys).toContain(accountBKey);
    expect(hasDurableSkeletonHint(accountBKey)).toBe(true);
    expect(hintedDurableSkeletonKeysForUser(accountB.userId)).toEqual([
      accountB,
    ]);
  });

  it("prewarms only durable skeleton hints for the signed-in account", async () => {
    const otherAccountKey = skeletonResumeStorageKey({
      ...KEY,
      userId: "user-2",
    });
    const skeleton = entries();
    const offer = buildSkeletonResumeOffer(skeleton, skeleton.length);
    if (offer === null) throw new Error("Expected one complete block");
    const durable = {
      claim: offer.claim,
      entriesJson: JSON.stringify(offer.entries),
    };
    await saveDurableSkeleton(skeletonResumeStorageKey(KEY), durable);
    await saveDurableSkeleton(otherAccountKey, durable);
    dropMemorySkeletonsForTests();

    expect(hintedDurableSkeletonKeysForUser(KEY.userId)).toEqual([KEY]);
    primeDurableSkeletonsForResume(KEY.userId);

    await vi.waitFor(() => {
      expect(readSkeletonForResume(KEY)?.readEntries()).toEqual(entries());
    });
    expect(readSkeletonForResume({ ...KEY, userId: "user-2" })).toBeNull();
  });

  it("rejects schema-valid cached rows that disagree with the claimed digests", async () => {
    const skeleton = entries();
    const offer = buildSkeletonResumeOffer(skeleton, skeleton.length);
    if (offer === null) throw new Error("Expected one complete block");
    const first = skeleton[0];
    skeleton[0] = { ...first, preview: "tampered" };
    const storageKey = skeletonResumeStorageKey(KEY);
    await saveDurableSkeleton(storageKey, {
      claim: offer.claim,
      entriesJson: JSON.stringify(skeleton),
    });
    await hydrateSkeletonForResume(KEY);

    expect(() => readSkeletonForResume(KEY)?.readEntries()).toThrow(
      "Skeleton resume cache entry is invalid.",
    );
    expect(readSkeletonForResume(KEY)).toBeNull();
    await drainDurableSkeletonWritesForTests();
    expect(hasDurableSkeletonHint(storageKey)).toBe(false);
  });

  it("bounds the durable store to eight chats, evicting the oldest", async () => {
    for (let index = 0; index < 9; index += 1) {
      await saveDurableSkeleton(
        skeletonResumeStorageKey({ ...KEY, chatId: `chat-${index}` }),
        {
          claim: { derivation: 1, blockSize: 256, blockDigests: ["digest"] },
          entriesJson: "[]",
        },
      );
    }
    expect(
      hasDurableSkeletonHint(
        skeletonResumeStorageKey({ ...KEY, chatId: "chat-0" }),
      ),
    ).toBe(false);
    expect(
      hasDurableSkeletonHint(
        skeletonResumeStorageKey({ ...KEY, chatId: "chat-8" }),
      ),
    ).toBe(true);
  });
});
