/**
 * The message a box replies to (Tracy Bots T166), kept with its draft on this
 * device: through the REAL drafts store over the real `localStorage`, every
 * start of the app loading its modules afresh over what the last run left, as
 * `bot-drafts-store-persist.test.ts` does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOT_REPLY_LINE_MAX,
  type BotReplyTarget,
} from "@/lib/bots/bot-reply-target";
import {
  BOT_ID,
  boxDoc,
  restart,
  startFresh,
  storeDraftsAsLeft,
  waitForStore,
  type App,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";

let app: App;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  app = await startFresh();
});

afterEach(() => {
  app.close();
  vi.useRealTimers();
});

const REPLY: BotReplyTarget = {
  messageId: "message-1",
  author: "Sam",
  line: "Ship it on Friday",
};

describe("the message a box replies to, through the persisted store", () => {
  it("keeps a reply set on an empty box through a restart", async () => {
    app.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel !== undefined,
    );

    app = await restart();

    expect(app.drafts.getState().threadBoxes[BOT_ID]?.channel).toEqual({
      text: "",
      content: null,
      seedId: 0,
      replyTo: REPLY,
    });
  });

  it("reads a draft stored before replies back replying to none", async () => {
    storeDraftsAsLeft({
      [BOT_ID]: { channel: { text: "old draft", content: null, seedId: 2 } },
    });

    app = await restart();

    expect(app.drafts.getState().threadBoxes[BOT_ID]?.channel).toEqual({
      text: "old draft",
      content: null,
      seedId: 2,
      replyTo: null,
    });
  });

  it("reads a stored line longer than a box keeps back cut to it", async () => {
    storeDraftsAsLeft({
      [BOT_ID]: {
        channel: {
          text: "",
          content: null,
          seedId: 0,
          replyTo: { ...REPLY, line: "a".repeat(BOT_REPLY_LINE_MAX + 100) },
        },
      },
    });

    app = await restart();

    expect(
      app.drafts.getState().threadBoxes[BOT_ID]?.channel?.replyTo?.line,
    ).toBe(`${"a".repeat(BOT_REPLY_LINE_MAX - 1)}…`);
  });

  it("keeps the reply when the text typed in the box is cleared", async () => {
    app.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "hi", boxDoc("hi", []));
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "", null);
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel !== undefined,
    );

    app = await restart();

    expect(app.drafts.getState().threadBoxes[BOT_ID]?.channel).toEqual({
      text: "",
      content: null,
      seedId: 0,
      replyTo: REPLY,
    });
  });

  it("leaves the text of a box alone when its reply is set and when it is cancelled", () => {
    const content = boxDoc("hi", []);
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "hi", content);

    app.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    expect(app.drafts.getState().threadBoxes[BOT_ID]?.channel).toEqual({
      text: "hi",
      content,
      seedId: 0,
      replyTo: REPLY,
    });

    app.drafts.getState().setReplyTarget(BOT_ID, "channel", null);
    expect(app.drafts.getState().threadBoxes[BOT_ID]?.channel).toEqual({
      text: "hi",
      content,
      seedId: 0,
      replyTo: null,
    });
  });

  it("drops the draft from the box and from storage when its reply is cancelled in an otherwise empty box", async () => {
    app.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel !== undefined,
    );

    app.drafts.getState().setReplyTarget(BOT_ID, "channel", null);
    expect(app.drafts.getState().threadBoxes[BOT_ID]).toBeUndefined();
    await waitForStore(
      app,
      (stored) => stored !== null && stored[BOT_ID] === undefined,
    );

    app = await restart();

    expect(app.drafts.getState().threadBoxes[BOT_ID]).toBeUndefined();
  });

  it("keeps the reply when Discuss seeds the box", () => {
    app.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);

    app.drafts.getState().seedThreadBox(BOT_ID, "channel", "Discuss this");

    expect(app.drafts.getState().threadBoxes[BOT_ID]?.channel).toEqual({
      text: "Discuss this",
      content: null,
      seedId: 1,
      replyTo: REPLY,
    });
  });

  it("writes a change of only the reply, set and then replaced", async () => {
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "hi", null);
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel?.text === "hi",
    );

    app.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel?.replyTo?.messageId === "message-1",
    );

    app.drafts
      .getState()
      .setReplyTarget(BOT_ID, "channel", { ...REPLY, messageId: "message-2" });
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel?.replyTo?.messageId === "message-2",
    );
  });
});
