import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
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
