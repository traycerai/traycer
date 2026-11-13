import { describe, expect, it } from "vitest";
import {
  EMPTY_QUESTION_CARD_DRAFT,
  questionCardEntry,
  questionCardMovedBlock,
  questionCardMovedLine,
  questionCardSkippedEntry,
  questionCardTallyLine,
  type QuestionCardMovedHow,
  type QuestionCardSettlement,
} from "@/components/chat/question-card-view";

const TEAMMATE: QuestionCardSettlement["by"] = {
  kind: "person",
  name: "Asha",
  viewer: false,
};
const VIEWER: QuestionCardSettlement["by"] = {
  kind: "person",
  name: "Olive",
  viewer: true,
};
const ASKER: QuestionCardSettlement["by"] = { kind: "asker" };

describe("questionCardMovedBlock", () => {
  it.each([
    {
      name: "a card of one question carries the answer alone",
      answers: [{ question: "Ship?", answer: "After the train" }],
      several: false,
      block: "After the train",
    },
    {
      name: "a question ending in a question mark takes its answer after a space, with no colon",
      answers: [
        { question: "Which database should we use?", answer: "Postgres" },
      ],
      several: true,
      block: "Which database should we use? Postgres",
    },
    {
      name: "any other question takes a colon before its answer",
      answers: [{ question: "Pick a region", answer: "eu-west" }],
      several: true,
      block: "Pick a region: eu-west",
    },
    {
      name: "trailing spaces after the question mark are trimmed, and no colon is added",
      answers: [{ question: "Why?  ", answer: "Cost" }],
      several: true,
      block: "Why? Cost",
    },
    {
      name: "one line per answer, in the order given",
      answers: [
        { question: "Ship?", answer: "Now, the build farm" },
        { question: "Pick a region", answer: "eu-west" },
      ],
      several: true,
      block: "Ship? Now, the build farm\nPick a region: eu-west",
    },
  ])("$name", ({ answers, several, block }) => {
    expect(questionCardMovedBlock(answers, several)).toBe(block);
  });
});

describe("questionCardMovedLine", () => {
  const YOURS_ONE = "Your answer is in your message box, not sent.";
  const YOURS_MANY = "Your answers are in your message box, not sent.";
  const THIS = "This answer is in your message box, not sent.";
  const THESE = "These answers are in your message box, not sent.";
  it.each<{
    name: string;
    by: QuestionCardSettlement["by"];
    how: QuestionCardMovedHow;
    moved: number;
    line: string;
  }>([
    {
      name: "a teammate's answer, one moved",
      by: TEAMMATE,
      how: "answered",
      moved: 1,
      line: `Asha answered first. ${YOURS_ONE}`,
    },
    {
      name: "a teammate's answer, several moved",
      by: TEAMMATE,
      how: "answered",
      moved: 2,
      line: `Asha answered first. ${YOURS_MANY}`,
    },
    {
      name: "a teammate's Skip, one moved",
      by: TEAMMATE,
      how: "skipped",
      moved: 1,
      line: `Asha skipped this question first. ${YOURS_ONE}`,
    },
    {
      name: "a teammate's Skip, several moved",
      by: TEAMMATE,
      how: "skipped",
      moved: 2,
      line: `Asha skipped these questions first. ${YOURS_MANY}`,
    },
    {
      name: "a teammate's answer to the card that left the moved question out",
      by: TEAMMATE,
      how: "card",
      moved: 1,
      line: `Asha answered the card first. ${YOURS_ONE}`,
    },
    {
      name: "a teammate's answer to the card, several moved",
      by: TEAMMATE,
      how: "card",
      moved: 2,
      line: `Asha answered the card first. ${YOURS_MANY}`,
    },
    {
      name: "the asker settling one, whatever the way",
      by: ASKER,
      how: "card",
      moved: 1,
      line: `Tracy settled it first. ${YOURS_ONE}`,
    },
    {
      name: "the asker settling several",
      by: ASKER,
      how: "answered",
      moved: 2,
      line: `Tracy settled them first. ${YOURS_MANY}`,
    },
    {
      name: "the viewer's other window answering, one moved",
      by: VIEWER,
      how: "answered",
      moved: 1,
      line: `You answered in another window first. ${THIS}`,
    },
    {
      name: "the viewer's other window answering, several moved",
      by: VIEWER,
      how: "answered",
      moved: 2,
      line: `You answered in another window first. ${THESE}`,
    },
    {
      name: "the viewer's other window skipping",
      by: VIEWER,
      how: "skipped",
      moved: 1,
      line: `You skipped this question in another window first. ${THIS}`,
    },
    {
      name: "the viewer's other window skipping several",
      by: VIEWER,
      how: "skipped",
      moved: 2,
      line: `You skipped these questions in another window first. ${THESE}`,
    },
    {
      name: "the asker settling several that were skipped, which keeps its wording",
      by: ASKER,
      how: "skipped",
      moved: 2,
      line: `Tracy settled them first. ${YOURS_MANY}`,
    },
    {
      name: "the viewer's other window answering the card",
      by: VIEWER,
      how: "card",
      moved: 1,
      line: `You answered the card in another window first. ${THIS}`,
    },
  ])("says $name", ({ by, how, moved, line }) => {
    expect(questionCardMovedLine(by, how, "Tracy", moved)).toBe(line);
  });
});

describe("questionCardTallyLine", () => {
  it.each([
    [0, 3, "0 of 3 answered. Answer at least one to submit."],
    [1, 3, "1 of 3 answered. The other 2 will be sent as skipped."],
    [2, 3, "2 of 3 answered. The last one will be sent as skipped."],
    [3, 3, "3 of 3 answered."],
  ])("reads %i of %i answered", (answered, open, line) => {
    expect(questionCardTallyLine(answered, open)).toBe(line);
  });
});

describe("a question's entry in the set a card sends", () => {
  it("is none for an untouched draft and for typed text that is only whitespace", () => {
    expect(questionCardEntry(1, EMPTY_QUESTION_CARD_DRAFT)).toBeNull();
    expect(
      questionCardEntry(1, { ...EMPTY_QUESTION_CARD_DRAFT, typed: "  \n " }),
    ).toBeNull();
  });

  it("carries the picks and the trimmed words of a touched draft", () => {
    expect(
      questionCardEntry(2, {
        ...EMPTY_QUESTION_CARD_DRAFT,
        chosen: ["Now"],
        typed: " the build farm ",
      }),
    ).toEqual({
      questionIndex: 2,
      skipped: false,
      selected: ["Now"],
      text: "the build farm",
    });
  });

  it("is a skip with no picks and no words for a question left untouched", () => {
    expect(questionCardSkippedEntry(1)).toEqual({
      questionIndex: 1,
      skipped: true,
      selected: [],
      text: null,
    });
  });
});
