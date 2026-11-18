import { afterEach, describe, expect, it } from "vitest";
import {
  clearChatKeyTombstone,
  clearEpicPrefixTombstone,
  isChatKeyTombstoned,
  tombstoneChatKey,
  tombstoneEpicPrefix,
  tombstoneEpicPrefixes,
} from "@/stores/chats/chat-tab-persistence-tombstone";

describe("chat-tab-persistence-tombstone", () => {
  afterEach(() => {
    clearChatKeyTombstone("epic-t/chat-t");
    clearEpicPrefixTombstone("epic-t");
  });

  it("exact-key tombstone blocks only that key, clearable", () => {
    expect(isChatKeyTombstoned("epic-t:chat-t")).toBe(false);
    tombstoneChatKey("epic-t:chat-t");
    expect(isChatKeyTombstoned("epic-t:chat-t")).toBe(true);
    expect(isChatKeyTombstoned("epic-t:chat-other")).toBe(false);
    clearChatKeyTombstone("epic-t:chat-t");
    expect(isChatKeyTombstoned("epic-t:chat-t")).toBe(false);
  });

  it("epic-prefix tombstone blocks every chat key under it, clearable", () => {
    expect(isChatKeyTombstoned("epic-t:chat-a")).toBe(false);
    tombstoneEpicPrefix("epic-t:");
    expect(isChatKeyTombstoned("epic-t:chat-a")).toBe(true);
    expect(isChatKeyTombstoned("epic-t:chat-b")).toBe(true);
    expect(isChatKeyTombstoned("epic-other:chat-a")).toBe(false);
    clearEpicPrefixTombstone("epic-t");
    expect(isChatKeyTombstoned("epic-t:chat-a")).toBe(false);
  });

  it("clearing the exact key does not clear an epic-prefix tombstone (ticket 15 review round 3/4 gap)", () => {
    tombstoneEpicPrefix("epic-t:");
    clearChatKeyTombstone("epic-t:chat-t");
    expect(isChatKeyTombstoned("epic-t:chat-t")).toBe(true);
    clearEpicPrefixTombstone("epic-t");
    expect(isChatKeyTombstoned("epic-t:chat-t")).toBe(false);
  });

  it("bounds the epic-prefix set with the same FIFO eviction as the exact-key set (round 4 finding 3)", () => {
    for (let i = 0; i < 500; i += 1) {
      tombstoneEpicPrefix(`epic-fifo-${i}:`);
    }
    expect(isChatKeyTombstoned("epic-fifo-0:chat-a")).toBe(true);

    // Pushes the set past its 500-entry cap - the oldest prefix must be
    // evicted, not the newest.
    tombstoneEpicPrefix("epic-fifo-500:");
    expect(isChatKeyTombstoned("epic-fifo-0:chat-a")).toBe(false);
    expect(isChatKeyTombstoned("epic-fifo-500:chat-a")).toBe(true);

    for (let i = 1; i <= 500; i += 1) {
      clearEpicPrefixTombstone(`epic-fifo-${i}`);
    }
  });

  it("a batch larger than the cap keeps EVERY member fenced through the whole tombstone-then-sweep ordering (round 5 item 2 - fence must survive its own transaction)", () => {
    const epicIds = Array.from(
      { length: 501 },
      (_unused, i) => `epic-batch-${i}`,
    );

    // Production order (`handleEpicAccessLoss`): tombstone the WHOLE batch
    // first, in one call - matches `evictChatTabPersistenceForEpics`.
    tombstoneEpicPrefixes(epicIds.map((epicId) => `${epicId}:`));

    // Simulates the canvas close sweep running AFTER the full batch has
    // been tombstoned (the real ordering) - epic 0 (the FIRST tombstoned,
    // and thus the one plain FIFO pruning would have evicted to make room
    // for epic 500) must still be fenced when its own "durable write back"
    // attempt would land.
    expect(isChatKeyTombstoned("epic-batch-0:chat-x")).toBe(true);
    // The other end of the batch is fenced too - not just the survivors of
    // a partial prune.
    expect(isChatKeyTombstoned("epic-batch-500:chat-x")).toBe(true);
    expect(isChatKeyTombstoned("epic-batch-250:chat-x")).toBe(true);

    for (const epicId of epicIds) clearEpicPrefixTombstone(epicId);
  });
});
