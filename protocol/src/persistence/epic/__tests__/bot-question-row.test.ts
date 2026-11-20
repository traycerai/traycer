import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  assistantMessageSchema,
  assistantMessageSchemaPreMcpApp,
  botQuestionAnswersText,
  botQuestionAnswerSetSchema,
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

function rangeFrame(row: { readonly messageId: string }): object {
  return {
    kind: "range",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    range: {
      requestId: "range-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: [row.messageId],
      messages: [row],
      events: [],
      reachedStart: true,
      reachedEnd: true,
    },
  };
}

/** The row a `chat.subscribe@1.<minor>` peer decodes from a range frame that carries it. */
function rowOnLine(
  minor: number,
  row: { readonly messageId: string },
): Record<string, unknown> {
  const version = hostStreamRpcRegistry["chat.subscribe"][1].versions[minor];
  if (version === undefined) throw new Error(`no chat.subscribe@1.${minor}`);
  const frame = version.contract.serverFrameSchema.parse(rangeFrame(row));
  const parsed = z
    .object({
      range: z.object({ messages: z.array(z.record(z.string(), z.unknown())) }),
    })
    .parse(frame);
  const [message] = parsed.range.messages;
  if (message === undefined) throw new Error("no message in the range");
  return message;
}

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

  function questionsOnLine(minor: number): ReadonlyArray<unknown> {
    const parsed = z
      .object({ question: z.object({ questions: z.array(z.unknown()) }) })
      .parse(rowOnLine(minor, MULTI_ROW));
    return parsed.question.questions;
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

describe("a member's answers to a bot's card, sent as one set", () => {
  const [first, second] = QUESTION.questions;
  const SET_ROW = {
    role: "user",
    messageId: "conversation-request:req-set",
    sender: { type: "user", userId: "user-1" },
    message: {
      kind: "user",
      content: { type: "doc", content: [] },
      browserAnnotations: [],
    },
    timestamp: 2,
    sessionAnchor: null,
    conversationRequest: {
      requestId: "req-set",
      resolvedAt: null,
      resolvedByMessageId: null,
      direct: true,
    },
    questionAnswers: {
      questionMessageId: BOT_ROW.messageId,
      answers: [
        {
          questionIndex: 0,
          question: first.text,
          answer: "Now",
          skipped: false,
        },
        {
          questionIndex: 1,
          question: second.text,
          answer: null,
          skipped: true,
        },
      ],
    },
  } as const;
  const { questionAnswers: _questionAnswers, ...PLAIN_ROW } = SET_ROW;
  const SETTLED_ROW = {
    ...BOT_ROW,
    question: {
      ...QUESTION,
      questions: [
        {
          ...first,
          settlement: { ...first.settlement, requestId: "req-set" },
        },
        second,
      ],
    },
  } as const;

  function firstSettlementOnLine(minor: number): unknown {
    const parsed = z
      .object({
        question: z.object({
          questions: z.array(z.object({ settlement: z.unknown() })),
        }),
      })
      .parse(rowOnLine(minor, SETTLED_ROW));
    return parsed.question.questions[0]?.settlement;
  }

  it("keeps the answers on the live user row and the request on the settlement it wrote, through chat.subscribe@1.43", () => {
    expect(rowOnLine(43, SET_ROW)).toEqual(SET_ROW);
    expect(firstSettlementOnLine(43)).toEqual(
      SETTLED_ROW.question.questions[0].settlement,
    );
  });

  it.each([42, 41])(
    "chat.subscribe@1.%i drops both, reading the user row as sent and the settlement as it was",
    (minor) => {
      expect(rowOnLine(minor, SET_ROW)).toEqual(rowOnLine(minor, PLAIN_ROW));
      expect(firstSettlementOnLine(minor)).toEqual(first.settlement);
    },
  );

  it("writes each question with its answer under it, joined by a blank line, and Skipped for a skip", () => {
    expect(
      botQuestionAnswersText(
        botQuestionAnswerSetSchema.parse(SET_ROW.questionAnswers).answers,
      ),
    ).toBe(`${first.text}\nNow\n\n${second.text}\nSkipped`);
  });
});

describe("a member's reply to a message of the conversation", () => {
  const { questionAnswer: _questionAnswer, ...MEMBER_ROW } = ANSWER_ROW;
  const REPLY_ROW = { ...MEMBER_ROW, repliesTo: "message-1" } as const;

  it.each([43, 44])(
    "keeps the message replied to on the live user row, through chat.subscribe@1.%i",
    (minor) => {
      expect(rowOnLine(minor, REPLY_ROW)).toEqual(REPLY_ROW);
    },
  );

  it.each([42, 41])(
    "chat.subscribe@1.%i drops it, reading the user row as it was sent without one",
    (minor) => {
      expect(rowOnLine(minor, REPLY_ROW)).toEqual(rowOnLine(minor, MEMBER_ROW));
    },
  );

  it.each([
    ["an empty message id", ""],
    ["a message id over 255 characters", "m".repeat(256)],
  ])("refuses %s", (_name, repliesTo) => {
    expect(
      userMessageSchema.safeParse({ ...MEMBER_ROW, repliesTo }).success,
    ).toBe(false);
  });
});
