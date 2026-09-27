import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { SKELETON_RESUME_BLOCK_SIZE } from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";
import {
  clearAllSkeletonsForResume,
  dropMemorySkeletonsForTests,
  hydrateSkeletonForResume,
  readSkeletonForResume,
  rememberSkeletonForResume,
  shouldLoadDurableSkeletonForResume,
} from "@/stores/chats/skeleton-resume-cache";
import {
  drainDurableSkeletonWritesForTests,
  hasDurableSkeletonHint,
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
