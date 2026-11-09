import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";

/**
 * A member's answers to every open question of a bot's card ride
 * `bot.conversation.send@1.5`, read off the registry so the pair a peer
 * negotiates is what is held to the shape.
 */

const send = hostRpcRegistry["bot.conversation.send"][1];
const sendV14 = send.versions[4].contract;
const sendV15 = send.versions[5].contract;

const REQUEST = {
  botId: "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
  conversationId: "conv-1",
  text: "Now",
};

const PICK = {
  questionIndex: 0,
  skipped: false,
  selected: ["Now"],
  text: null,
};

const ENTRIES = [
  PICK,
  {
    questionIndex: 1,
    skipped: false,
    selected: ["Staging", "Production"],
    text: null,
  },
  {
    questionIndex: 2,
    skipped: false,
    selected: [],
    text: "After the train",
  },
  { questionIndex: 3, skipped: true, selected: [], text: null },
];

const ANSWERS = { questionMessageId: "bot-question:req-q", entries: ENTRIES };

describe("bot.conversation.send@1.5", () => {
  it("is the latest line, and upgrades a 1.4 request carrying no answers", () => {
    expect(send.latestMinor).toBe(5);
    const parsed = sendV14.requestSchema.parse(REQUEST);
    const upgraded =
      send.versions[5].upgradeFromPreviousVersion.upgradeRequest(parsed);
    expect(upgraded).toEqual(parsed);
    expect(sendV15.requestSchema.parse(upgraded).answers).toBeUndefined();
  });

  it("keeps a pick, several picks, words and a skip, each as the member sent it", () => {
    expect(
      sendV15.requestSchema.parse({ ...REQUEST, answers: ANSWERS }).answers,
    ).toEqual(ANSWERS);
  });

  it.each([
    ["no entries", { ...ANSWERS, entries: [] }],
    [
      "a negative question index",
      { ...ANSWERS, entries: [{ ...PICK, questionIndex: -1 }] },
    ],
  ])("refuses a set with %s", (_name, answers) => {
    expect(
      sendV15.requestSchema.safeParse({ ...REQUEST, answers }).success,
    ).toBe(false);
  });

  it("is frozen on 1.4 without them: a 1.4 peer never sees the key", () => {
    const parsed = sendV14.requestSchema.parse({
      ...REQUEST,
      answers: ANSWERS,
    });
    expect(parsed).not.toHaveProperty("answers");
    expect(parsed).toEqual(sendV14.requestSchema.parse(REQUEST));
  });
});
