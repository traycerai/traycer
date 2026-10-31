import { describe, expect, it } from "vitest";
import type { QueueItem } from "@/stores/voice/voice-session-store";
import {
  composeBriefing,
  itemLineOf,
  NOTHING_WAITING_TEXT,
  VOICE_SESSION_INPUT_MAX_CHARS,
} from "../briefing";
import type { ReplyRef } from "../queue-sources";
import { remintInput } from "../session-input";

const BOT_TITLES: Readonly<Record<string, string>> = {
  "bot-2": "Release bot",
  "bot-3": "CI bot",
};

const botTitle = (botId: string): string => BOT_TITLES[botId] ?? "the bot";

const NO_PROMPTS = { approvals: 0, questions: 0 };

function queueItem(overrides: Partial<QueueItem>): QueueItem {
  const item: QueueItem = {
    id: "i-1",
    kind: "reply",
    botId: "bot-2",
    hostId: "host-a",
    threadId: "thread-x",
    chatId: "thread-x",
    messageId: "i-1",
    surfaceId: null,
    title: "A title",
    line: "",
    at: 1_000,
    state: "queued",
    ...overrides,
  };
  return { ...item, line: itemLineOf(item, botTitle(item.botId)) };
}

function answerRef(overrides: Partial<ReplyRef>): ReplyRef {
  return {
    messageId: "a-1",
    botId: "bot-3",
    threadId: "thread-y",
    chatId: "thread-y",
    originHostId: "host-a",
    at: 2_000,
    ...overrides,
  };
}

/** `count` waiting items, item `n` at time `n`, so the newest is the last built. */
function manyItems(count: number): ReadonlyArray<QueueItem> {
  return Array.from({ length: count }, (_, n) =>
    queueItem({ id: `i-${n}`, messageId: `i-${n}`, title: `Item ${n}`, at: n }),
  );
}

describe("composeBriefing", () => {
  it("says the most recent first, items and unread answers together", () => {
    const text = composeBriefing({
      answers: [answerRef({ at: 2_000 })],
      prompts: NO_PROMPTS,
      items: [
        queueItem({ id: "old", messageId: "old", title: "older post", at: 1_000 }),
        queueItem({ id: "new", messageId: "new", title: "newest post", at: 3_000 }),
      ],
      botTitle,
      maxChars: VOICE_SESSION_INPUT_MAX_CHARS,
    });

    const newest = text.indexOf("newest post");
    const answer = text.indexOf("CI bot answered in a thread.");
    const oldest = text.indexOf("older post");
    expect(newest).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(newest);
    expect(oldest).toBeGreaterThan(answer);
  });

  it("says an answer once when its reply is already an item", () => {
    const text = composeBriefing({
      answers: [answerRef({ messageId: "i-1", botId: "bot-2", threadId: "thread-x" })],
      prompts: NO_PROMPTS,
      items: [queueItem({ title: "Safari fix landed" })],
      botTitle,
      maxChars: VOICE_SESSION_INPUT_MAX_CHARS,
    });

    expect(text).toContain('Release bot answered in a thread: "Safari fix landed".');
    expect(text.match(/Release bot answered in a thread/g)).toHaveLength(1);
  });

  it("says that nothing waits when only heard and dismissed items remain", () => {
    const text = composeBriefing({
      answers: [],
      prompts: NO_PROMPTS,
      items: [
        queueItem({ id: "h", messageId: "h", title: "heard post", state: "heard" }),
        queueItem({ id: "d", messageId: "d", title: "later post", state: "dismissed" }),
      ],
      botTitle,
      maxChars: VOICE_SESSION_INPUT_MAX_CHARS,
    });

    expect(text).toBe(NOTHING_WAITING_TEXT);
  });

  it.each([
    { count: 500, maxChars: VOICE_SESSION_INPUT_MAX_CHARS },
    { count: 20, maxChars: 300 },
  ])(
    "never passes $maxChars characters or cuts a sentence, and counts exactly what it left out ($count items)",
    ({ count, maxChars }) => {
      const text = composeBriefing({
        answers: [],
        prompts: NO_PROMPTS,
        items: manyItems(count),
        botTitle,
        maxChars,
      });

      expect(text.length).toBeLessThanOrEqual(maxChars);
      const closing = /^(.*) And (\d+) more\.$/su.exec(text);
      expect(closing).not.toBeNull();
      const said = closing?.[1] ?? "";
      const left = Number(closing?.[2]);
      // Every sentence said is whole, newest first, and the rest are counted.
      const titles = Array.from(said.matchAll(/"Item (\d+)"/gu));
      expect(said.endsWith('".')).toBe(true);
      expect(titles.length).toBeGreaterThan(0);
      expect(titles.length + left).toBe(count);
      expect(titles.map((match) => Number(match[1]))).toEqual(
        Array.from({ length: titles.length }, (_, n) => count - 1 - n),
      );
    },
  );
});

describe("remintInput", () => {
  it("carries the one-liners of what still waits, newest first, and not what was heard or set aside", () => {
    const text = remintInput({
      focus: null,
      botTitle,
      queue: [
        queueItem({ id: "q", messageId: "q", title: "queued post", at: 1_000 }),
        queueItem({
          id: "o",
          messageId: "o",
          title: "offered post",
          at: 3_000,
          state: "offered",
        }),
        queueItem({
          id: "n",
          messageId: "n",
          kind: "announcement",
          title: "nightly build",
          at: 2_000,
        }),
        queueItem({ id: "h", messageId: "h", title: "heard post", state: "heard" }),
        queueItem({ id: "d", messageId: "d", title: "later post", state: "dismissed" }),
      ],
    });

    expect(text.indexOf("offered post")).toBeGreaterThan(-1);
    expect(text.indexOf("nightly build")).toBeGreaterThan(text.indexOf("offered post"));
    expect(text.indexOf("queued post")).toBeGreaterThan(text.indexOf("nightly build"));
    expect(text).not.toContain("heard post");
    expect(text).not.toContain("later post");
  });

  it("stays within the mint's input cap for a huge queue, keeping the newest", () => {
    const text = remintInput({
      focus: null,
      botTitle,
      queue: manyItems(500),
    });

    expect(text.length).toBeLessThanOrEqual(VOICE_SESSION_INPUT_MAX_CHARS);
    expect(text).toContain('"Item 499"');
    expect(text).not.toContain('"Item 0"');
    expect(text.endsWith('".')).toBe(true);
  });
});
