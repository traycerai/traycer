import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MENTION_PICK_MEMORY_CAP,
  recentMentionPicks,
  selectMentionPickBucket,
  useMentionPickMemoryStore,
} from "@/stores/composer/mention-pick-memory-store";

const HOST_A = "host-a";
const HOST_B = "host-b";

function resetStore(): void {
  useMentionPickMemoryStore.getState().resetForTests();
}

describe("mention pick memory store", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("drops the write when hostId is null", () => {
    useMentionPickMemoryStore.getState().recordPick(null, "file:a", 100);

    expect(useMentionPickMemoryStore.getState().byHost).toEqual({});
  });

  it("buckets picks per host - a pick on one host is invisible on another", () => {
    useMentionPickMemoryStore.getState().recordPick(HOST_A, "file:a", 100);

    const state = useMentionPickMemoryStore.getState();
    expect(selectMentionPickBucket(state, HOST_A)).toEqual({
      "file:a": { updatedAt: 100 },
    });
    expect(selectMentionPickBucket(state, HOST_B)).toEqual({});
  });

  it("recentMentionPicks returns every entry in the bucket as id -> pick time", () => {
    useMentionPickMemoryStore.getState().recordPick(HOST_A, "file:a", 100);
    useMentionPickMemoryStore.getState().recordPick(HOST_A, "file:b", 200);

    const bucket = selectMentionPickBucket(
      useMentionPickMemoryStore.getState(),
      HOST_A,
    );
    const picks = recentMentionPicks(bucket);

    expect(picks).toEqual(
      new Map([
        ["file:a", 100],
        ["file:b", 200],
      ]),
    );
  });

  it("caps the bucket at the 200 most recent ids by updatedAt, evicting the oldest", () => {
    for (let index = 0; index < MENTION_PICK_MEMORY_CAP; index += 1) {
      useMentionPickMemoryStore
        .getState()
        .recordPick(HOST_A, `file:${index}`, index);
    }

    // A 201st pick, newer than every existing one, must evict the oldest
    // (`file:0`) rather than growing the bucket past the cap.
    useMentionPickMemoryStore
      .getState()
      .recordPick(
        HOST_A,
        `file:${MENTION_PICK_MEMORY_CAP}`,
        MENTION_PICK_MEMORY_CAP,
      );

    const bucket = selectMentionPickBucket(
      useMentionPickMemoryStore.getState(),
      HOST_A,
    );
    expect(Object.keys(bucket)).toHaveLength(MENTION_PICK_MEMORY_CAP);
    expect(Object.hasOwn(bucket, "file:0")).toBe(false);
    expect(Object.hasOwn(bucket, `file:${MENTION_PICK_MEMORY_CAP}`)).toBe(true);
  });
});
