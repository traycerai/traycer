import type { BotActivity } from "@traycer/protocol/host/bot/schemas";
import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import { describe, expect, it } from "vitest";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import {
  announcementsOf,
  attentionPromptsOf,
  hydratedEntryOf,
  replyRefsOf,
  stoppedAnswersOf,
  type AnnouncementRow,
  type HydrationRow,
} from "../queue-sources";

const COPY = "SECRET COPY";

/** An unread bot answer: the attention tier's "answer" class, naming a message. */
function row(overrides: Partial<MergedNotificationRow>): MergedNotificationRow {
  return {
    feedId: "host:n-1",
    source: "host",
    sourceId: "n-1",
    createdAt: 1_000,
    readAt: null,
    title: COPY,
    body: COPY,
    payload: {
      kind: "chat",
      epicId: "bot-2",
      chatId: "thread-x",
      bot: { botId: "bot-2", threadId: "thread-x", messageId: "m-1" },
    },
    botAnswer: true,
    hostKind: "agent.stopped",
    appLocalKind: null,
    globalEntry: null,
    severity: "info",
    outcome: null,
    resolvedAt: null,
    sourceRef: null,
    originHostId: "host-a",
    category: "task",
    ...overrides,
  };
}

describe("replyRefsOf", () => {
  it("names an unread answer by ids alone, and nothing of the row's copy reaches the output", () => {
    const refs = replyRefsOf([row({ createdAt: 4_000 })]);

    expect(refs).toEqual([
      {
        messageId: "m-1",
        botId: "bot-2",
        threadId: "thread-x",
        chatId: "thread-x",
        originHostId: "host-a",
        at: 4_000,
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain(COPY);
  });

  it("names a message of the channel with no thread", () => {
    const refs = replyRefsOf([
      row({
        payload: {
          kind: "chat",
          epicId: "bot-2",
          chatId: "chan-2",
          bot: { botId: "bot-2", threadId: null, messageId: "m-1" },
        },
      }),
    ]);

    expect(refs.map((ref) => [ref.threadId, ref.chatId])).toEqual([
      [null, "chan-2"],
    ]);
  });

  it.each<{ readonly name: string; readonly excluded: MergedNotificationRow }>([
    { name: "a read row", excluded: row({ readAt: 2_000 }) },
    {
      name: "a row that is no bot answer",
      excluded: row({ botAnswer: false }),
    },
    { name: "a blocking prompt", excluded: row({ severity: "needs_action" }) },
    { name: "a failure", excluded: row({ severity: "failure" }) },
    { name: "a global row", excluded: row({ source: "global" }) },
    {
      name: "a bot row with no message id",
      excluded: row({
        payload: {
          kind: "chat",
          epicId: "bot-2",
          chatId: "thread-x",
          bot: { botId: "bot-2", threadId: "thread-x", messageId: null },
        },
      }),
    },
    {
      name: "a chat row naming no bot",
      excluded: row({
        payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      }),
    },
    {
      name: "a bot row naming no chat",
      excluded: row({
        payload: {
          kind: "chat",
          epicId: "bot-2",
          chatId: undefined,
          bot: { botId: "bot-2", threadId: null, messageId: "m-1" },
        },
      }),
    },
  ])("leaves out $name", ({ excluded }) => {
    expect(replyRefsOf([excluded])).toEqual([]);
  });

  it("names a message once, newest first", () => {
    const refs = replyRefsOf([
      row({ feedId: "host:a", createdAt: 1_000 }),
      row({
        feedId: "host:b",
        createdAt: 3_000,
        payload: {
          kind: "chat",
          epicId: "bot-2",
          chatId: "thread-x",
          bot: { botId: "bot-2", threadId: "thread-x", messageId: "m-2" },
        },
      }),
      row({ feedId: "host:c", createdAt: 2_000 }),
    ]);

    expect(refs.map((ref) => ref.messageId)).toEqual(["m-2", "m-1"]);
  });
});

describe("attentionPromptsOf", () => {
  it("counts the unread blocking approvals and questions by the row's kind", () => {
    const prompts = attentionPromptsOf([
      row({ hostKind: "approval.requested", severity: "needs_action" }),
      row({ hostKind: "approval.requested", severity: "needs_action" }),
      row({ hostKind: "interview.requested", severity: "needs_action" }),
      // Read, so no longer blocking.
      row({
        hostKind: "approval.requested",
        severity: "needs_action",
        readAt: 2_000,
      }),
      // Blocking, but neither an approval nor a question.
      row({ hostKind: "browser.human.needed", severity: "needs_action" }),
      // Not a blocking row at all.
      row({ hostKind: "interview.requested", severity: "info" }),
    ]);

    expect(prompts).toEqual({ approvals: 2, questions: 1 });
  });
});

function textBlock(
  text: string,
  providerNotice: OpenTextBlock["providerNotice"],
): OpenTextBlock {
  return {
    blockId: `block-${text}`,
    status: "completed",
    timestamp: 1,
    parentBlockId: null,
    type: "text",
    text,
    providerNotice,
  };
}

function botRow(overrides: Partial<HydrationRow>): HydrationRow {
  return {
    role: "assistant",
    messageId: "m-1",
    blocks: [textBlock("Ready to release. Ship or hold?", null)],
    ...overrides,
  };
}

const OPEN_QUESTION = {
  text: "Ship or hold?",
  options: ["Ship", "Hold"],
  allowFreeText: false,
  settlement: null,
};

const SETTLED_QUESTION = {
  text: "Which branch?",
  options: ["main"],
  allowFreeText: false,
  settlement: {
    answer: "main",
    skipped: false,
    by: { kind: "bot" as const },
    at: 5,
  },
};

const RESOLUTION = {
  state: "allowed" as const,
  by: null,
  at: 5,
};

describe("hydratedEntryOf", () => {
  it("reads a row with an open question as a question, with the open one's choices", () => {
    const entry = hydratedEntryOf(
      botRow({
        question: {
          requestId: "q-1",
          questions: [SETTLED_QUESTION, OPEN_QUESTION],
        },
      }),
    );

    expect(entry).toEqual({
      kind: "question",
      content: "Ready to release. Ship or hold?",
      options: ["Ship", "Hold"],
      surfaceId: null,
    });
  });

  it("reads a row whose approval or question surface is open as a surface, named by what it points at", () => {
    const approval = hydratedEntryOf(
      botRow({
        surface: {
          kind: "approval",
          epicId: "epic-1",
          hostId: "host-a",
          chatId: "task-chat",
          approvalId: "ap-1",
          resolution: null,
        },
      }),
    );
    const question = hydratedEntryOf(
      botRow({
        surface: {
          kind: "question",
          epicId: "epic-1",
          hostId: "host-a",
          chatId: "task-chat",
          blockId: "blk-1",
          resolution: null,
        },
      }),
    );

    expect(approval).toMatchObject({ kind: "surface", surfaceId: "ap-1" });
    expect(question).toMatchObject({ kind: "surface", surfaceId: "blk-1" });
  });

  it.each<{ readonly name: string; readonly row: HydrationRow }>([
    {
      name: "every question settled",
      row: botRow({
        question: { requestId: "q-1", questions: [SETTLED_QUESTION] },
      }),
    },
    {
      name: "a settled approval surface",
      row: botRow({
        surface: {
          kind: "approval",
          epicId: "epic-1",
          hostId: "host-a",
          chatId: "task-chat",
          approvalId: "ap-1",
          resolution: RESOLUTION,
        },
      }),
    },
    {
      name: "a surface that is neither approval nor question",
      row: botRow({
        surface: {
          kind: "artifact",
          epicId: "epic-1",
          hostId: "host-a",
          artifactPath: "plan/index.html",
          resolution: null,
        },
      }),
    },
  ])("reads a row with $name as a plain reply", ({ row: hydrated }) => {
    expect(hydratedEntryOf(hydrated)).toEqual({
      kind: "reply",
      content: "Ready to release. Ship or hold?",
      options: [],
      surfaceId: null,
    });
  });

  it("reads a row with no prose as nothing to say", () => {
    expect(
      hydratedEntryOf(
        botRow({
          blocks: [
            textBlock("Codex switched from gpt-5 to gpt-5-safe.", {
              harnessId: "codex",
              noticeKind: "model_rerouted",
              tone: "warning",
              title: "Model changed",
              message: null,
              details: [],
              metadata: {
                type: "model_rerouted",
                fromModel: "gpt-5",
                toModel: "gpt-5-safe",
                reason: "highRiskCyberActivity",
              },
            }),
          ],
        }),
      ),
    ).toBeNull();
    expect(hydratedEntryOf(botRow({ blocks: [] }))).toBeNull();
  });
});

describe("announcementsOf", () => {
  function post(
    messageId: string,
    timestamp: number,
    overrides: Partial<
      Extract<AnnouncementRow, { readonly role: "assistant" }>
    >,
  ): AnnouncementRow {
    return {
      role: "assistant",
      messageId,
      timestamp,
      blocks: [textBlock(`Post ${messageId}.`, null)],
      ...overrides,
    };
  }

  it("keeps the bot's rows that answer nothing and are newer than since, oldest first", () => {
    const rows: ReadonlyArray<AnnouncementRow> = [
      {
        role: "user",
        messageId: "u-1",
        timestamp: 2_000,
        conversationRequest: {
          requestId: "req-1",
          resolvedAt: 2_500,
          resolvedByMessageId: "a-answer",
        },
      },
      post("a-answer", 3_000, {}),
      post("a-direct", 3_100, { repliesTo: "u-2" }),
      post("a-history", 1_000, {}),
      post("a-new-1", 4_000, {}),
      post("a-new-2", 5_000, {}),
    ];

    expect(announcementsOf(rows, 1_000)).toEqual([
      { messageId: "a-new-1", content: "Post a-new-1.", at: 4_000 },
      { messageId: "a-new-2", content: "Post a-new-2.", at: 5_000 },
    ]);
  });
});

describe("stoppedAnswersOf", () => {
  it("lists the failed and parked sessions that hold a request, the trunk first, undated when the stream gives no start", () => {
    const activity: BotActivity = {
      trunk: {
        state: "failed",
        startedAt: null,
        step: null,
        requestId: "req-trunk",
        reason: null,
      },
      threads: {
        "thread-a": {
          state: "parked",
          startedAt: 4_000,
          step: null,
          requestId: "req-a",
          reason: null,
        },
        "thread-b": {
          state: "idle",
          startedAt: 5_000,
          step: null,
          requestId: "req-b",
          reason: null,
        },
        "thread-c": {
          state: "failed",
          startedAt: 6_000,
          step: null,
          requestId: null,
          reason: null,
        },
      },
    };

    expect(stoppedAnswersOf(activity)).toEqual([
      { requestId: "req-trunk", threadId: null, state: "failed", at: null },
      { requestId: "req-a", threadId: "thread-a", state: "parked", at: 4_000 },
    ]);
  });
});
