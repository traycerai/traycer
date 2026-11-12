import { beforeEach, describe, expect, it } from "vitest";
import {
  useBotDraftsStore,
  type BotAnswerDraft,
} from "@/stores/bots/bot-drafts-store";

const BOT = "bot-1";
const BOX = "conversation-channel";

const DRAFT: BotAnswerDraft = {
  chosen: [],
  typed: "Hold the migration",
  sent: null,
  unsureSince: null,
  heldForSettlement: null,
};

function compose(taken: ReadonlyArray<readonly [string, BotAnswerDraft]>): {
  readonly block: string;
  readonly notice: string;
} {
  return {
    block: taken.map(([, draft]) => draft.typed).join("\n"),
    notice: "Tess answered first.",
  };
}

function carriedBlocks(): ReadonlyArray<string> {
  return (useBotDraftsStore.getState().boxCarries[BOT]?.[BOX] ?? []).map(
    (item) => item.block,
  );
}

beforeEach(() => {
  useBotDraftsStore.setState({
    answers: {},
    threadBoxes: {},
    unsentBoxes: {},
    boxCarries: {},
    boxNotices: {},
  });
});

describe("the bot drafts store's moves of card answers into a box", () => {
  it("moves the same keys once: a second move finds the drafts gone and changes nothing", () => {
    const store = useBotDraftsStore.getState();
    store.setAnswer(BOT, "k1", DRAFT);

    store.moveAnswers(BOT, BOX, ["k1"], compose);
    const after = useBotDraftsStore.getState();
    after.moveAnswers(BOT, BOX, ["k1"], compose);

    const state = useBotDraftsStore.getState();
    expect(carriedBlocks()).toEqual(["Hold the migration"]);
    expect(state.boxCarries).toBe(after.boxCarries);
    expect(state.answers).toEqual({});
  });

  it("lets go of exactly the moves a box says it holds, and leaves a move that came after", () => {
    const store = useBotDraftsStore.getState();
    store.setAnswer(BOT, "k1", DRAFT);
    store.moveAnswers(BOT, BOX, ["k1"], compose);
    const first = useBotDraftsStore.getState().boxCarries[BOT]?.[BOX]?.[0];
    store.setAnswer(BOT, "k2", { ...DRAFT, typed: "Nothing" });
    store.moveAnswers(BOT, BOX, ["k2"], compose);

    if (first === undefined) throw new Error("no first move");
    store.sendCarry(BOT, BOX, [first.id], "went");

    expect(carriedBlocks()).toEqual(["Nothing"]);
  });

  it("keeps a box's draft and lets go of the moves it holds in one change, even when the draft did not change", () => {
    const store = useBotDraftsStore.getState();
    store.typeThreadBox(BOT, BOX, {
      text: "Kept text",
      content: null,
      held: [],
    });
    store.setAnswer(BOT, "k1", DRAFT);
    store.moveAnswers(BOT, BOX, ["k1"], compose);
    const move = useBotDraftsStore.getState().boxCarries[BOT]?.[BOX]?.[0];
    if (move === undefined) throw new Error("no move");

    store.typeThreadBox(BOT, BOX, {
      text: "Kept text",
      content: null,
      held: [move.id],
    });

    expect(carriedBlocks()).toEqual([]);
    expect(useBotDraftsStore.getState().threadBoxes[BOT]?.[BOX]?.text).toBe(
      "Kept text",
    );
  });

  it("drops the carries and notices of a forgotten bot, and keeps them when its surface closes", () => {
    const store = useBotDraftsStore.getState();
    store.setAnswer(BOT, "k1", DRAFT);
    store.moveAnswers(BOT, BOX, ["k1"], compose);

    store.closeBot(BOT);
    expect(carriedBlocks()).toEqual(["Hold the migration"]);
    expect(useBotDraftsStore.getState().boxNotices[BOT]?.[BOX]).toEqual({
      kind: "moved",
      text: "Tess answered first.",
    });

    store.forgetBot(BOT);
    expect(useBotDraftsStore.getState().boxCarries[BOT]).toBeUndefined();
    expect(useBotDraftsStore.getState().boxNotices[BOT]).toBeUndefined();
  });
});
