import { describe, expect, it } from "vitest";
import {
  assistantMessageSchema,
  assistantMessageSchemaPreMcpApp,
  userMessageSchema,
  userMessageSchemaPreConversation,
} from "@traycer/protocol/persistence/epic/messages";

const QUESTION = {
  requestId: "req-q",
  questions: [
    {
      text: "Deploy to staging now or after the train?",
      options: ["Now", "After the train"],
      allowFreeText: false,
      settlement: {
        answer: "Now",
        skipped: false,
        by: { kind: "person", userId: "user-1" },
        at: 2,
      },
    },
    {
      text: "Anything to hold back?",
      options: [],
      allowFreeText: true,
      settlement: null,
    },
  ],
} as const;

const BOT_ROW = {
  role: "assistant",
  messageId: "bot-question:req-q",
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
      blockId: "block-1",
      status: "completed",
      timestamp: 1,
      text: "Deploy to staging now or after the train?",
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
  options: ["Now", "After the train"],
  question: QUESTION,
} as const;

const ANSWER_ROW = {
  role: "user",
  messageId: "conversation-request:req-a",
  sender: { type: "user", userId: "user-1" },
  message: {
    kind: "user",
    content: { type: "doc", content: [] },
    browserAnnotations: [],
  },
  timestamp: 2,
  sessionAnchor: null,
  conversationRequest: {
    requestId: "req-a",
    resolvedAt: null,
    resolvedByMessageId: null,
    direct: true,
  },
  questionAnswer: {
    questionMessageId: "bot-question:req-q",
    questionIndex: 0,
    skipped: false,
  },
} as const;

describe("a bot's question row (decision 121)", () => {
  it("keeps the questions and their settlements on the live row", () => {
    expect(assistantMessageSchema.parse(BOT_ROW).question).toEqual(QUESTION);
  });

  it("parses on a released line's frozen row, without the question, leaving its text and options", () => {
    const frozen = assistantMessageSchemaPreMcpApp.parse(BOT_ROW);
    expect(frozen).not.toHaveProperty("question");
    expect(frozen.blocks).toEqual(BOT_ROW.blocks);
  });

  it("refuses a settlement by a person with no user id", () => {
    const [first, second] = QUESTION.questions;
    expect(
      assistantMessageSchema.safeParse({
        ...BOT_ROW,
        question: {
          ...QUESTION,
          questions: [
            {
              ...first,
              settlement: { ...first.settlement, by: { kind: "person" } },
            },
            second,
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps which question a member's message answers on the live user row, and the frozen row drops it", () => {
    expect(userMessageSchema.parse(ANSWER_ROW).questionAnswer).toEqual(
      ANSWER_ROW.questionAnswer,
    );
    expect(
      userMessageSchemaPreConversation.parse(ANSWER_ROW),
    ).not.toHaveProperty("questionAnswer");
  });
});
