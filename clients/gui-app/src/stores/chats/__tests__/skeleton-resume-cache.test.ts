import { beforeEach, describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  SKELETON_RESUME_BLOCK_SIZE,
  buildSkeletonResumeOffer,
} from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";
import {
  SKELETON_RESUME_CACHE_MAX_CHARS,
  SKELETON_RESUME_CACHE_MAX_CHATS,
  forgetAllSkeletonsForResume,
  readSkeletonForResume,
  rememberSkeletonForResume,
  skeletonResumeCacheStatsForTests,
  type SkeletonResumeCacheKey,
} from "@/stores/chats/skeleton-resume-cache";
import {
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

const BLOCK = SKELETON_RESUME_BLOCK_SIZE;

function entries(count: number, tag: string): RowSkeletonEntry[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    rowId: `${tag}-${ordinal}`,
    createdAt: ordinal,
    role: "user" as const,
    byteLength: 10,
    bodyDigest: `${tag}-d${ordinal}`,
    preview: `first line of ${tag} ${ordinal}`,
  }));
}

function completeWindow(
  skeleton: readonly RowSkeletonEntry[],
): TranscriptWindow {
  return {
    ...emptyTranscriptWindow(),
    rowCount: skeleton.length,
    skeleton,
    skeletonComplete: true,
    skeletonStreamCoveredThrough: skeleton.length,
  };
}

function key(chatId: string): SkeletonResumeCacheKey {
  return { userId: "user-1", hostId: "host-1", epicId: "epic-1", chatId };
}

beforeEach(() => {
  forgetAllSkeletonsForResume();
});

describe("the closed-chat skeleton cache", () => {
  it("keeps exactly what the window could have offered, and hands it back", () => {
    const skeleton = entries(2 * BLOCK + 30, "a");
    rememberSkeletonForResume(key("a"), completeWindow(skeleton));
    const cached = readSkeletonForResume(key("a"));
    const offer = buildSkeletonResumeOffer(skeleton, skeleton.length);
    expect(cached?.claim).toEqual(offer?.claim);
    expect(cached?.readEntries()).toEqual(skeleton.slice(0, 2 * BLOCK));
  });

  it("offers one chat's rows to that chat, user and host only", () => {
    rememberSkeletonForResume(key("a"), completeWindow(entries(BLOCK, "a")));
    expect(readSkeletonForResume(key("b"))).toBe(null);
    expect(readSkeletonForResume({ ...key("a"), userId: "user-2" })).toBe(null);
    expect(readSkeletonForResume({ ...key("a"), hostId: "host-2" })).toBe(null);
  });

  it("forgets a chat whose closing window it cannot trust", () => {
    rememberSkeletonForResume(key("a"), completeWindow(entries(BLOCK, "a")));
    rememberSkeletonForResume(key("a"), {
      ...completeWindow(entries(BLOCK, "a")),
      invalidated: true,
    });
    expect(readSkeletonForResume(key("a"))).toBe(null);
    expect(skeletonResumeCacheStatsForTests()).toEqual({ chats: 0, chars: 0 });
  });

  it("holds at most SKELETON_RESUME_CACHE_MAX_CHATS, dropping the least recently used", () => {
    for (let index = 0; index <= SKELETON_RESUME_CACHE_MAX_CHATS; index += 1) {
      rememberSkeletonForResume(
        key(`c${index}`),
        completeWindow(entries(BLOCK, `c${index}`)),
      );
      // Reading the first one keeps it warm through every later insert.
      if (index > 0) readSkeletonForResume(key("c0"));
    }
    expect(skeletonResumeCacheStatsForTests().chats).toBe(
      SKELETON_RESUME_CACHE_MAX_CHATS,
    );
    expect(readSkeletonForResume(key("c0"))).not.toBe(null);
    expect(readSkeletonForResume(key("c1"))).toBe(null);
  });

  it("stays inside its character budget", () => {
    // Rows sized so fewer than SKELETON_RESUME_CACHE_MAX_CHATS of them
    // overflow the budget: about 600k characters a chat.
    const wide = (tag: string): RowSkeletonEntry[] =>
      entries(8 * BLOCK, tag).map((value) => ({
        ...value,
        preview: `${tag}-${"x".repeat(190)}`,
      }));
    for (let index = 0; index < SKELETON_RESUME_CACHE_MAX_CHATS; index += 1) {
      rememberSkeletonForResume(
        key(`w${index}`),
        completeWindow(wide(`w${index}`)),
      );
      expect(skeletonResumeCacheStatsForTests().chars).toBeLessThanOrEqual(
        SKELETON_RESUME_CACHE_MAX_CHARS,
      );
    }
    // The budget, not the chat cap, is what evicted.
    expect(skeletonResumeCacheStatsForTests().chats).toBeLessThan(
      SKELETON_RESUME_CACHE_MAX_CHATS,
    );
    expect(readSkeletonForResume(key("w0"))).toBe(null);
    expect(
      readSkeletonForResume(key(`w${SKELETON_RESUME_CACHE_MAX_CHATS - 1}`)),
    ).not.toBe(null);
  });

  it("is dropped whole when the identity goes away", () => {
    rememberSkeletonForResume(key("a"), completeWindow(entries(BLOCK, "a")));
    forgetAllSkeletonsForResume();
    expect(readSkeletonForResume(key("a"))).toBe(null);
  });
});
