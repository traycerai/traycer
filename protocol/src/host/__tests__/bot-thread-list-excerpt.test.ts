import { describe, expect, it } from "vitest";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  botThreadListV10,
  botThreadListV11,
  botThreadListV12,
} from "@traycer/protocol/host/bot/contracts";
import {
  BOT_THREAD_ANCHOR_EXCERPT_MAX_CHARS,
  botThreadAnchorExcerptOf,
  botThreadAnchorSchema,
} from "@traycer/protocol/host/bot/conversation-schemas";

const BOT_ID = "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1";

const ANCHOR = {
  messageId: "conversation-request:req-1",
  requestId: "req-1",
  senderUserId: "user-1",
  sentAt: 1_000,
  resolvedAt: null,
} as const;

const THREAD_FIELDS = {
  conversationId: "channel-1",
  replyCount: 1,
  lastReplyAt: 2_000,
  openRequestCount: 0,
  costUsd: null,
} as const;

/** A 1.1 host's answer: one thread with its post, one whose post is gone. */
const LISTED_V11 = {
  threads: [
    {
      ...THREAD_FIELDS,
      threadId: "thread-a",
      sessionChatId: "session-a",
      anchor: ANCHOR,
    },
    {
      ...THREAD_FIELDS,
      threadId: "thread-b",
      sessionChatId: "session-b",
      anchor: null,
    },
  ],
  trunkCostUsd: null,
  threadAnchors: null,
} as const;

describe("bot.thread.list@1.2 anchor excerpts", () => {
  const line = hostRpcRegistry["bot.thread.list"][1];

  it("is advertised at 1.2 in a connection manifest", () => {
    const { manifest, optionalManifest } = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect({ ...manifest, ...optionalManifest }["bot.thread.list"]).toEqual({
      major: 1,
      minor: 2,
    });
  });

  it("upgrades a 1.1 host's answer to anchors with a null excerpt, keeping a gone anchor null", () => {
    const upgrade = line.versions[2].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.1 to 1.2 upgrade path");

    const upgraded = upgrade.upgradeResponse(
      botThreadListV11.responseSchema.parse(LISTED_V11),
    );

    expect(upgraded.threads.map((thread) => thread.anchor)).toEqual([
      { ...ANCHOR, excerpt: null },
      null,
    ]);
    expect(botThreadListV12.responseSchema.parse(upgraded)).toEqual(upgraded);
  });

  it("upgrades a 1.1 request to an unpaged one, and a 1.1 host's answer to one page holding every thread", () => {
    const upgrade = line.versions[2].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.1 to 1.2 upgrade path");

    const request = upgrade.upgradeRequest(
      botThreadListV11.requestSchema.parse({ botId: BOT_ID }),
    );
    const response = upgrade.upgradeResponse(
      botThreadListV11.responseSchema.parse(LISTED_V11),
    );

    expect(request).toEqual({ botId: BOT_ID, limit: null, cursor: null });
    expect(botThreadListV12.requestSchema.parse(request)).toEqual(request);
    expect(response.nextCursor).toBeNull();
    expect(response.total).toBe(LISTED_V11.threads.length);
    expect(botThreadListV12.responseSchema.parse(response)).toEqual(response);
  });

  it("strips a limit and a cursor from a 1.0 or 1.1 request, read off the registry's lines", () => {
    for (const minor of [0, 1] as const) {
      const requestSchema = line.versions[minor].contract.requestSchema;

      expect(
        requestSchema.parse({ botId: BOT_ID, limit: 5, cursor: "t1.x" }),
      ).toEqual({ botId: BOT_ID });
    }
  });

  it("requires a 1.2 request to say both its limit and its cursor, and bounds them", () => {
    const requestSchema = line.versions[2].contract.requestSchema;

    expect(requestSchema.safeParse({ botId: BOT_ID }).success).toBe(false);
    expect(
      requestSchema.safeParse({ botId: BOT_ID, limit: 1, cursor: null })
        .success,
    ).toBe(true);
    for (const limit of [0, -1, 1.5]) {
      expect(
        requestSchema.safeParse({ botId: BOT_ID, limit, cursor: null }).success,
      ).toBe(false);
    }
    expect(
      requestSchema.safeParse({ botId: BOT_ID, limit: null, cursor: "" })
        .success,
    ).toBe(false);
  });

  it("freezes 1.0 and 1.1 at anchors without the excerpt, dropping one they never carried", () => {
    const excerpted = {
      ...LISTED_V11,
      threads: [
        { ...LISTED_V11.threads[0], anchor: { ...ANCHOR, excerpt: "Hold" } },
      ],
      nextCursor: null,
      total: 1,
    };

    for (const contract of [botThreadListV10, botThreadListV11]) {
      const [thread] = contract.responseSchema.parse(excerpted).threads;
      expect(thread?.anchor).toEqual(ANCHOR);
    }
    expect(
      botThreadListV12.responseSchema.parse(excerpted).threads[0]?.anchor
        ?.excerpt,
    ).toBe("Hold");
  });

  it("reads an anchor written without the excerpt as null, and rejects an empty one and one past the bound", () => {
    expect(botThreadAnchorSchema.parse(ANCHOR).excerpt).toBeNull();
    expect(
      botThreadAnchorSchema.safeParse({ ...ANCHOR, excerpt: "" }).success,
    ).toBe(false);
    expect(
      botThreadAnchorSchema.safeParse({
        ...ANCHOR,
        excerpt: "a".repeat(BOT_THREAD_ANCHOR_EXCERPT_MAX_CHARS),
      }).success,
    ).toBe(true);
    expect(
      botThreadAnchorSchema.safeParse({
        ...ANCHOR,
        excerpt: "a".repeat(BOT_THREAD_ANCHOR_EXCERPT_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});

describe("botThreadAnchorExcerptOf", () => {
  it("keeps only the first sentence, leaving a dot inside a word", () => {
    expect(
      botThreadAnchorExcerptOf("Hold the 1.5.1 build. Then ship it tonight."),
    ).toBe("Hold the 1.5.1 build");
  });

  it.each([
    [
      "a closing quote",
      '"Hold the build." Then ship tonight.',
      '"Hold the build"',
    ],
    [
      "a closing Markdown marker",
      "**Deploy is blocked.** Ask the release owner.",
      "**Deploy is blocked**",
    ],
    ["a closing bracket", "(See the log.) Then retry.", "(See the log)"],
    ["a CJK full stop", "构建失败了。请重新运行。", "构建失败了"],
    ["a CJK question mark", "真的吗？我不知道！", "真的吗"],
    [
      "a dot after an abbreviation before a lowercase word",
      "Check e.g. the nightly run. Then ship.",
      "Check e.g. the nightly run",
    ],
    [
      "a dot after dotted letters before a lowercase word",
      "The U.S. team is up. Go.",
      "The U.S. team is up",
    ],
    [
      "an ellipsis before a lowercase word",
      "Wait... what happened here? Nothing.",
      "Wait... what happened here",
    ],
    [
      "a dot after an ordinary word before a lowercase word",
      "hold the build. then ship it",
      "hold the build",
    ],
  ])("ends the first sentence at %s", (_rule, text, expected) => {
    expect(botThreadAnchorExcerptOf(text)).toBe(expected);
  });

  it("cuts past ten words with an ellipsis, trims the punctuation the cut leaves, and marks no cut at ten words", () => {
    expect(
      botThreadAnchorExcerptOf(
        "one two three four five six seven eight nine ten, eleven twelve",
      ),
    ).toBe("one two three four five six seven eight nine ten…");
    expect(
      botThreadAnchorExcerptOf(
        "one two three four five six seven eight nine ten!",
      ),
    ).toBe("one two three four five six seven eight nine ten");
  });

  it("collapses whitespace and newlines into single spaces", () => {
    expect(
      botThreadAnchorExcerptOf("  triage\n\nthe   overnight\tfailures "),
    ).toBe("triage the overnight failures");
  });

  it("answers null for a post with no words", () => {
    for (const text of ["", " \n\t ", "?!...", " ; : ", '"..."']) {
      expect(botThreadAnchorExcerptOf(text)).toBeNull();
    }
  });

  it("cuts a long first sentence to the bound with an ellipsis, never splitting a surrogate pair", () => {
    // Pairs start on even offsets, so a cut at an odd length would split one.
    const text = `xy ${Array.from({ length: 5 }, () => "😀".repeat(20)).join(" ")}`;
    const excerpt = botThreadAnchorExcerptOf(text);

    if (excerpt === null) throw new Error("expected an excerpt");
    expect(excerpt.length).toBeLessThanOrEqual(
      BOT_THREAD_ANCHOR_EXCERPT_MAX_CHARS,
    );
    expect(excerpt.endsWith("…")).toBe(true);
    expect(
      [...excerpt.slice(0, -1)].every((char) => /^(x|y| |😀)$/u.test(char)),
    ).toBe(true);
    expect(botThreadAnchorSchema.parse({ ...ANCHOR, excerpt }).excerpt).toBe(
      excerpt,
    );
  });
});
