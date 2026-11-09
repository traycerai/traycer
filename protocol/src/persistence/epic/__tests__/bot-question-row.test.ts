import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
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

describe("a bot question's cardinality", () => {
  const [first, second] = QUESTION.questions;
  const MULTI_ROW = {
    ...BOT_ROW,
    question: {
      ...QUESTION,
      questions: [{ ...first, multiSelect: true }, second],
    },
  } as const;

  function rangeFrame(row: object): object {
    return {
      kind: "range",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      range: {
        requestId: "range-1",
        epoch: 0,
        fromOrdinal: 0,
        rowIds: [BOT_ROW.messageId],
        messages: [row],
        events: [],
        reachedStart: true,
        reachedEnd: true,
      },
    };
  }

  function questionsOnLine(minor: number): ReadonlyArray<unknown> {
    const version = hostStreamRpcRegistry["chat.subscribe"][1].versions[minor];
    if (version === undefined) throw new Error(`no chat.subscribe@1.${minor}`);
    const frame = version.contract.serverFrameSchema.parse(
      rangeFrame(MULTI_ROW),
    );
    const parsed = z
      .object({
        range: z.object({
          messages: z.array(
            z.object({
              question: z.object({ questions: z.array(z.unknown()) }),
            }),
          ),
        }),
      })
      .parse(frame);
    const [message] = parsed.range.messages;
    if (message === undefined) throw new Error("no message in the range");
    return message.question.questions;
  }

  it("accepts a question with and without multiSelect, keeping what it says", () => {
    const parsed = assistantMessageSchema.parse(MULTI_ROW).question;
    expect(parsed?.questions[0].multiSelect).toBe(true);
    expect(parsed?.questions[1]).not.toHaveProperty("multiSelect");
    expect(
      assistantMessageSchema.parse({
        ...BOT_ROW,
        question: {
          ...QUESTION,
          questions: [{ ...first, multiSelect: false }, second],
        },
      }).question?.questions[0].multiSelect,
    ).toBe(false);
  });

  it("keeps multiSelect through chat.subscribe@1.43", () => {
    expect(questionsOnLine(43)[0]).toMatchObject({ multiSelect: true });
  });

  it.each([42, 41])(
    "strips multiSelect on chat.subscribe@1.%i, leaving the rest of the question",
    (minor) => {
      const [stripped] = questionsOnLine(minor);
      expect(stripped).not.toHaveProperty("multiSelect");
      expect(stripped).toMatchObject({
        text: first.text,
        options: first.options,
        allowFreeText: first.allowFreeText,
      });
    },
  );
});
