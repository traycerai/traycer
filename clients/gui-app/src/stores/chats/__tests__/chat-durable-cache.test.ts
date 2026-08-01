/**
 * Ticket 15 review round F6: `createChatDurableCache` must be a true LRU -
 * a `get()` has to refresh recency, not just `set()`, or a frequently
 * *reopened* but rarely *re-saved* chat still ages out on schedule.
 */
import { describe, expect, it } from "vitest";
import { createChatDurableCache } from "@/stores/chats/chat-durable-cache";

function id(chatId: string): { epicId: string; chatId: string } {
  return { epicId: "epic-f6", chatId };
}

describe("createChatDurableCache LRU (ticket 15 review F6)", () => {
  it("refreshes recency on get(), not just set() - a read-but-not-rewritten entry survives eviction", () => {
    const cache = createChatDurableCache<string>(2);
    cache.set(id("a"), "value-a");
    cache.set(id("b"), "value-b");
    // Touch A via get() - this must count as recent use.
    expect(cache.get(id("a"))).toBe("value-a");
    // Adding a third entry over the cap must evict the LEAST recently used -
    // B (never read after being set), not A (just read).
    cache.set(id("c"), "value-c");
    expect(cache.get(id("a"))).toBe("value-a");
    expect(cache.get(id("b"))).toBeUndefined();
    expect(cache.get(id("c"))).toBe("value-c");
  });
});
