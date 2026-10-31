import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { VoiceFocus } from "@/stores/voice/voice-session-store";
import {
  anchorExcerptOf,
  bindTarget,
  composeVoiceDirectory,
  threadKey,
  tupleHolds,
  type DirectorySources,
} from "../directory";
import { renderDirectory } from "../router";

/** The directory suite: the composer, the binder and the tuple check, against fixture reads. */

const NOW = 1_800_000_000_000;
const VIEWER = "user-me";
const COLLEAGUE = "user-colleague";

const PERSONAL = "env-personal";
const ACME = "env-acme";
const HOME = "env-home";

function environment(
  environmentId: string,
  label: string,
  kind: "personal" | "team",
): EnvironmentDescriptorV11 {
  return {
    environmentId,
    ownerKind: kind === "personal" ? "user" : "organization",
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label,
    effectiveRole: kind === "personal" ? "owner" : "editor",
    kind,
    hostCount: 1,
    providerHandle: null,
  };
}

function botRecord(
  botId: string,
  environmentId: string,
  archivedAt: number | null,
): BotRecord {
  return {
    botId,
    environmentId,
    createdByUserId: VIEWER,
    title: `Title of ${botId}`,
    harness: "claude",
    model: "model-1",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: null,
    hostEpoch: 0,
    createdAt: NOW - 1_000_000_000,
    archivedAt,
    directive: null,
    replyMode: "thread",
    appConversationChatId: null,
  };
}

/** A thread whose anchor post `messageId` was sent by `senderUserId` at `sentAt`. */
function threadSummary(
  threadId: string,
  messageId: string,
  senderUserId: string | null,
  sentAt: number,
): BotThreadSummary {
  return {
    threadId,
    conversationId: `conv-${threadId}`,
    sessionChatId: `chat-${threadId}`,
    anchor: {
      messageId,
      requestId: `req-${threadId}`,
      senderUserId,
      sentAt,
      resolvedAt: null,
      excerpt: null,
    },
    replyCount: 1,
    lastReplyAt: null,
    openRequestCount: 0,
    costUsd: null,
  };
}

/** The summary with its anchor carrying `excerpt`, as a 1.2 host lists it. */
function withExcerpt(
  summary: BotThreadSummary,
  excerpt: string | null,
): BotThreadSummary {
  if (summary.anchor === null) return summary;
  return { ...summary, anchor: { ...summary.anchor, excerpt } };
}

function threadWithoutAnchor(threadId: string): BotThreadSummary {
  return { ...threadSummary(threadId, "unused", null, 0), anchor: null };
}

function focusOn(botId: string, threadId: string | null): VoiceFocus {
  return {
    botId,
    hostId: "host-1",
    threadId,
    anchorMessageId: threadId === null ? null : `msg-${threadId}`,
    anchorThread: null,
  };
}

/** Three environments, no bots yet, a viewer who follows nothing. */
const SOURCES: DirectorySources = {
  environments: [
    environment(PERSONAL, "Personal", "personal"),
    environment(ACME, "Acme", "team"),
    environment(HOME, "Home", "team"),
  ],
  bots: [],
  threadsByBot: new Map(),
  followedThreads: new Set(),
  viewerUserId: VIEWER,
  focus: null,
  queue: [],
  hostOf: () => "host-1",
  heldPostText: () => null,
};

describe("which threads of a bot the snapshot holds", () => {
  it("keeps every thread of the focused bot, and of another bot only the ones the person posted or follows", () => {
    const directory = composeVoiceDirectory({
      ...SOURCES,
      bots: [
        botRecord("bot_focus", PERSONAL, null),
        botRecord("bot_other", PERSONAL, null),
      ],
      threadsByBot: new Map([
        [
          "bot_focus",
          [threadSummary("focus-colleague", "m-1", COLLEAGUE, NOW - 1)],
        ],
        [
          "bot_other",
          [
            threadSummary("other-posted", "m-2", VIEWER, NOW - 2),
            threadSummary("other-stranger", "m-3", COLLEAGUE, NOW - 3),
            threadSummary("other-followed", "m-4", COLLEAGUE, NOW - 4),
          ],
        ],
      ]),
      followedThreads: new Set([threadKey("bot_other", "other-followed")]),
      focus: focusOn("bot_focus", null),
    });

    expect(directory.threads.map((thread) => thread.threadId)).toEqual([
      "focus-colleague",
      "other-posted",
      "other-followed",
    ]);
  });
});

describe("the same words in two teams", () => {
  const DIRECTORY = composeVoiceDirectory({
    ...SOURCES,
    bots: [
      botRecord("bot_acme", ACME, null),
      botRecord("bot_home", HOME, null),
    ],
    threadsByBot: new Map([
      [
        "bot_acme",
        [
          withExcerpt(
            threadSummary("thr-acme", "m-acme", VIEWER, NOW - 10),
            "hold the 1.5.1 build",
          ),
        ],
      ],
      [
        "bot_home",
        [
          withExcerpt(
            threadSummary("thr-home", "m-home", VIEWER, NOW - 20),
            "hold the 1.5.1 build",
          ),
        ],
      ],
    ]),
    focus: null,
    // The excerpt comes off the wire: nothing is rendered in the window.
    heldPostText: () => null,
  });

  it("makes two candidate threads, and a bot with its thread binds to its own team's", () => {
    expect(
      DIRECTORY.threads.map((thread) => [
        thread.threadId,
        thread.environmentId,
        thread.anchorExcerpt,
      ]),
    ).toEqual([
      ["thr-acme", ACME, "hold the 1.5.1 build"],
      ["thr-home", HOME, "hold the 1.5.1 build"],
    ]);

    const acme = bindTarget(DIRECTORY, {
      environmentId: null,
      botId: "bot_acme",
      threadId: "thr-acme",
    });
    const home = bindTarget(DIRECTORY, {
      environmentId: null,
      botId: "bot_home",
      threadId: "thr-home",
    });
    expect(acme?.tuple).toMatchObject({
      environmentId: ACME,
      botId: "bot_acme",
      threadId: "thr-acme",
    });
    expect(acme?.environmentLabel).toBe("Acme");
    expect(home?.tuple).toMatchObject({
      environmentId: HOME,
      botId: "bot_home",
      threadId: "thr-home",
    });
    expect(home?.environmentLabel).toBe("Home");
  });

  it("shows the router both lines with the one excerpt, so it can ask which", () => {
    const threadLine = z.object({
      thread: z.string(),
      environment: z.string(),
      excerpt: z.string().nullable(),
    });
    const lines = renderDirectory(DIRECTORY, NOW)
      .split("\n")
      .filter((line) => line.startsWith('{"thread"'))
      .map((line) => threadLine.parse(JSON.parse(line)));

    expect(lines).toEqual([
      {
        thread: "thr-acme",
        environment: ACME,
        excerpt: "hold the 1.5.1 build",
      },
      {
        thread: "thr-home",
        environment: HOME,
        excerpt: "hold the 1.5.1 build",
      },
    ]);
  });
});

describe("what the snapshot leaves out", () => {
  it("drops an archived bot, a bot in an environment the person is not in, a bot no host carries, and a thread whose post is gone", () => {
    const directory = composeVoiceDirectory({
      ...SOURCES,
      bots: [
        botRecord("bot_live", PERSONAL, null),
        botRecord("bot_archived", PERSONAL, NOW - 1),
        botRecord("bot_stranger", "env-elsewhere", null),
        botRecord("bot_hostless", PERSONAL, null),
      ],
      threadsByBot: new Map([
        [
          "bot_live",
          [
            threadSummary("thr-kept", "m-1", VIEWER, NOW - 1),
            threadWithoutAnchor("thr-orphaned"),
          ],
        ],
        ["bot_archived", [threadSummary("thr-a", "m-2", VIEWER, NOW - 2)]],
        ["bot_stranger", [threadSummary("thr-s", "m-3", VIEWER, NOW - 3)]],
      ]),
      focus: focusOn("bot_live", null),
      hostOf: (botId) => (botId === "bot_hostless" ? null : "host-1"),
    });

    expect(directory.bots.map((bot) => bot.botId)).toEqual(["bot_live"]);
    expect(directory.threads.map((thread) => thread.threadId)).toEqual([
      "thr-kept",
    ]);
  });
});

describe("anchorExcerptOf", () => {
  const SUMMARY = threadSummary("thr-1", "m-1", VIEWER, NOW);

  it("is the wire's excerpt when the host lists one, over any text the app holds", () => {
    expect(
      anchorExcerptOf(
        "bot_a",
        withExcerpt(SUMMARY, "hold the 1.5.1 build"),
        () => "other words the window renders",
      ),
    ).toBe("hold the 1.5.1 build");
  });

  it("composes it from the text the app holds when the host lists none, collapsing runs of whitespace and line breaks to single spaces", () => {
    expect(
      anchorExcerptOf(
        "bot_a",
        SUMMARY,
        () => "  hold \n\n the\t1.5.1   build ",
      ),
    ).toBe("hold the 1.5.1 build");
  });

  it("shortens long text and marks the cut with an ellipsis", () => {
    const long = "word ".repeat(100);

    const excerpt = anchorExcerptOf("bot_a", SUMMARY, () => long) ?? "";

    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.length).toBeLessThan(long.trim().length);
    expect(long.startsWith(excerpt.slice(0, -1))).toBe(true);
  });

  it("is null when the app holds no text for the post, only blanks, or the post is gone", () => {
    expect(anchorExcerptOf("bot_a", SUMMARY, () => null)).toBeNull();
    expect(anchorExcerptOf("bot_a", SUMMARY, () => " \n\t ")).toBeNull();
    expect(
      anchorExcerptOf("bot_a", threadWithoutAnchor("thr-2"), () => "text"),
    ).toBeNull();
  });
});

describe("tupleHolds", () => {
  const directory = composeVoiceDirectory({
    ...SOURCES,
    bots: [botRecord("bot_a", ACME, null)],
    threadsByBot: new Map([
      ["bot_a", [threadSummary("thr-listed", "m-1", VIEWER, NOW - 1)]],
    ]),
    focus: focusOn("bot_a", "thr-fresh"),
  });
  const listed = {
    environmentId: ACME,
    botId: "bot_a",
    threadId: "thr-listed",
    hostId: "host-1",
  };

  it("holds for a listed thread, and not once the bot has moved environment or host", () => {
    expect(tupleHolds(directory, listed)).toBe(true);
    expect(tupleHolds(directory, { ...listed, environmentId: HOME })).toBe(
      false,
    );
    expect(tupleHolds(directory, { ...listed, hostId: "host-2" })).toBe(false);
  });

  it("holds for the focus's own thread a send just opened, which the list does not show yet, and for no other unlisted one", () => {
    expect(tupleHolds(directory, { ...listed, threadId: "thr-fresh" })).toBe(
      true,
    );
    expect(tupleHolds(directory, { ...listed, threadId: "thr-unknown" })).toBe(
      false,
    );
  });
});
