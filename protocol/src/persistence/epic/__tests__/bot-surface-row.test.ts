import { describe, expect, it } from "vitest";
import {
  assistantMessageSchema,
  assistantMessageSchemaPreMcpApp,
  type BotSurfaceReference,
} from "@traycer/protocol/persistence/epic/messages";
import { botSurfaceActRequestSchema } from "@traycer/protocol/host/bot/surface-schemas";

const QUESTION_SURFACE: BotSurfaceReference = {
  kind: "question",
  epicId: "task-1",
  hostId: "host-1",
  chatId: "chat-1",
  blockId: "block-1",
  resolution: {
    state: "answered",
    by: { kind: "person", userId: "user-1" },
    at: 3,
  },
};

const BOT_ROW = {
  role: "assistant",
  messageId: "bot-reply:1",
  sender: {
    type: "agent",
    harnessId: "claude",
    agentId: "trunk-1",
    displayName: "Tracy",
    reply: { expectsReply: false },
    inReplyTo: null,
  },
  blocks: [
    {
      type: "text",
      blockId: "block-text",
      status: "completed",
      timestamp: 1,
      text: "The deploy agent needs your answer on the branch.",
      providerNotice: null,
    },
  ],
  startedAt: 1,
  timestamp: 1,
  turnId: null,
  usage: null,
  reasoningEffort: null,
  serviceTier: null,
  envCredentialVar: null,
  imageResolutions: [],
  surface: QUESTION_SURFACE,
} as const;

describe("a bot post's surface reference (T89)", () => {
  it("keeps the surface and its resolution on the live row", () => {
    expect(assistantMessageSchema.parse(BOT_ROW).surface).toEqual(
      QUESTION_SURFACE,
    );
  });

  it("parses on a released line's frozen row without the surface, leaving the text", () => {
    const frozen = assistantMessageSchemaPreMcpApp.parse(BOT_ROW);
    expect(frozen).not.toHaveProperty("surface");
    expect(frozen.blocks).toEqual(BOT_ROW.blocks);
  });

  it("carries each kind's own ids", () => {
    const surfaces: BotSurfaceReference[] = [
      {
        kind: "approval",
        epicId: "task-1",
        hostId: "host-1",
        chatId: "chat-1",
        approvalId: "approval-1",
        resolution: null,
      },
      {
        kind: "browser",
        epicId: "task-1",
        hostId: "host-1",
        chatId: null,
        sessionId: "session-1",
        parkId: "park-1",
        tabId: null,
        resolution: null,
      },
      {
        kind: "artifact",
        epicId: "task-1",
        hostId: "host-1",
        artifactPath: "plans/rollout/index.md",
        resolution: null,
      },
    ];
    for (const surface of surfaces) {
      expect(
        assistantMessageSchema.parse({ ...BOT_ROW, surface }).surface,
      ).toEqual(surface);
    }
  });

  it("refuses a question surface without its block id", () => {
    const { blockId: _omitted, ...withoutBlock } = QUESTION_SURFACE;
    expect(
      assistantMessageSchema.safeParse({ ...BOT_ROW, surface: withoutBlock })
        .success,
    ).toBe(false);
  });

  it("refuses a browser surface that does not name its park", () => {
    expect(
      assistantMessageSchema.safeParse({
        ...BOT_ROW,
        surface: {
          kind: "browser",
          epicId: "task-1",
          hostId: "host-1",
          chatId: null,
          sessionId: "session-1",
          tabId: null,
          resolution: null,
        },
      }).success,
    ).toBe(false);
  });
});

describe("bot.surface.act request", () => {
  const ANSWER = {
    questionId: "q-1",
    question: "Which branch?",
    values: ["main"],
    notes: null,
    selection: {
      questionIndex: 0,
      optionIndices: [0],
      optionLabels: ["main"],
      customText: null,
    },
  };

  it("takes an answer on a question surface", () => {
    expect(
      botSurfaceActRequestSchema.safeParse({
        botId: "bot_01J0000000000000000000000A",
        messageId: "bot-reply:1",
        actionId: "action-1",
        surface: { ...QUESTION_SURFACE, resolution: null },
        action: { kind: "answer", answers: [ANSWER] },
      }).success,
    ).toBe(true);
  });

  it("refuses a decision on a question surface", () => {
    expect(
      botSurfaceActRequestSchema.safeParse({
        botId: "bot_01J0000000000000000000000A",
        messageId: "bot-reply:1",
        actionId: "action-1",
        surface: { ...QUESTION_SURFACE, resolution: null },
        action: { kind: "decide", decision: { approved: true } },
      }).success,
    ).toBe(false);
  });
});
