/**
 * The message a box replies to (Tracy Bots T166), kept with its draft on this
 * device: through the REAL drafts store over the real `localStorage`, every
 * start of the app loading its modules afresh over what the last run left, as
 * `bot-drafts-store-persist.test.ts` does. Includes a reply chosen while the
 * stored drafts are still being read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StoredBoxDraft,
  StoredBoxDrafts,
} from "@/lib/bots/bot-box-draft-storage";
import {
  BOT_REPLY_LINE_MAX,
  type BotReplyTarget,
} from "@/lib/bots/bot-reply-target";
import {
  BOT_ID,
  IMAGE_B64,
  THREAD,
  boxDoc,
  hydrated,
  restart,
  startFresh,
  startReadingAnotherWindowsDraft,
  startReadingStoredDraft,
  storeDraftsAsLeft,
  storedDrafts,
  waitForStore,
  type App,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";
import type { BotThreadBoxDraft } from "@/stores/bots/bot-drafts-store";

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
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", {
      text: "hi",
      content: boxDoc("hi", []),
      held: [],
    });
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", { text: "", content: null, held: [] });
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
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", { text: "hi", content, held: [] });

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

  it("writes a change of only the reply, set and then replaced", async () => {
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", {
      text: "hi",
      content: null,
      held: [],
    });
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

describe("a reply chosen while the stored drafts are read", () => {
  /** The channel's draft as the running app's drafts store holds it. */
  function channelOf(running: App): BotThreadBoxDraft | undefined {
    return running.drafts.getState().threadBoxes[BOT_ID]?.channel;
  }

  /** The channel's draft as `localStorage` holds it. */
  function storedChannelOf(running: App): StoredBoxDraft | undefined {
    return storedDrafts(running)?.[BOT_ID]?.channel;
  }

  /** The channel's draft is stored replying to `REPLY`. */
  function repliedInStorage(stored: StoredBoxDrafts | null): boolean {
    return stored?.[BOT_ID]?.channel?.replyTo?.messageId === REPLY.messageId;
  }

  /** Types in a box of its own after the read, so a write lands, and waits for it. */
  async function pastAWrite(reading: App): Promise<void> {
    reading.drafts.getState().typeThreadBox(BOT_ID, "other", {
      text: "elsewhere",
      content: null,
      held: [],
    });
    await waitForStore(
      reading,
      (stored) => stored?.[BOT_ID]?.other !== undefined,
    );
  }

  it("keeps the stored text and seed of the box under the reply, in memory, in storage and after a restart", async () => {
    const reading = await startReadingStoredDraft("old");
    app = reading;

    reading.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    await hydrated(reading);

    const kept = { text: "old", seedId: 1, replyTo: REPLY };
    expect(channelOf(reading)).toMatchObject(kept);
    await waitForStore(reading, repliedInStorage);
    expect(storedChannelOf(reading)).toMatchObject(kept);

    app = await restart();

    expect(channelOf(app)).toMatchObject(kept);
  });

  it("keeps the stored image of the box under the reply, in memory and in storage", async () => {
    const reading = await startReadingStoredDraft("");
    app = reading;

    reading.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    await hydrated(reading);

    expect(channelOf(reading)?.replyTo).toEqual(REPLY);
    expect(JSON.stringify(channelOf(reading)?.content)).toContain(IMAGE_B64);
    await waitForStore(reading, repliedInStorage);
    expect(JSON.stringify(storedChannelOf(reading)?.content)).toContain(
      '"hash"',
    );

    app = await restart();

    expect(JSON.stringify(channelOf(app)?.content)).toContain(IMAGE_B64);
  });

  it("keeps the text typed after the reply under the reply, not the stored draft, in memory and in storage", async () => {
    const reading = await startReadingStoredDraft("old");
    app = reading;

    reading.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    reading.drafts.getState().typeThreadBox(BOT_ID, "channel", {
      text: "new",
      content: null,
      held: [],
    });
    await hydrated(reading);

    const typed = { text: "new", content: null, seedId: 0, replyTo: REPLY };
    expect(channelOf(reading)).toEqual(typed);
    await waitForStore(
      reading,
      (stored) => stored?.[BOT_ID]?.channel?.text === "new",
    );
    expect(storedChannelOf(reading)).toEqual(typed);
  });

  it("keeps the stored text with no reply when the reply is cancelled, in memory and in storage", async () => {
    const reading = await startReadingStoredDraft("old");
    app = reading;

    reading.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    reading.drafts.getState().setReplyTarget(BOT_ID, "channel", null);
    await hydrated(reading);

    const kept = { text: "old", seedId: 1, replyTo: null };
    expect(channelOf(reading)).toMatchObject(kept);
    await pastAWrite(reading);
    expect(storedChannelOf(reading)).toMatchObject(kept);
  });

  it("keeps a reply on a box with nothing stored as a draft of the reply alone, beside the stored draft of another box", async () => {
    const reading = await startReadingStoredDraft("old");
    app = reading;

    reading.drafts.getState().setReplyTarget(BOT_ID, THREAD, REPLY);
    await hydrated(reading);

    const replyAlone = { text: "", content: null, seedId: 0, replyTo: REPLY };
    expect(reading.drafts.getState().threadBoxes[BOT_ID]?.[THREAD]).toEqual(
      replyAlone,
    );
    expect(channelOf(reading)?.text).toBe("old");
    await waitForStore(
      reading,
      (stored) => stored?.[BOT_ID]?.[THREAD] !== undefined,
    );
    expect(storedDrafts(reading)?.[BOT_ID]?.[THREAD]).toEqual(replyAlone);
    expect(storedChannelOf(reading)?.text).toBe("old");
  });

  it("keeps a bot forgotten after the reply gone, in memory and in storage", async () => {
    const reading = await startReadingStoredDraft("old");
    app = reading;

    reading.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    reading.drafts.getState().forgetBot(BOT_ID);
    await hydrated(reading);

    expect(reading.drafts.getState().threadBoxes[BOT_ID]).toBeUndefined();
    await waitForStore(
      reading,
      (stored) => stored !== null && stored[BOT_ID] === undefined,
    );
  });

  it("keeps the retiring account's stored text under the reply when it retires before the read answers", async () => {
    const reading = await startReadingStoredDraft("old");
    app = reading;

    reading.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    reading.drafts.getState().retire(() => {
      throw new Error("no failed send or moved answer is folded into a box");
    }, null);

    const kept = { text: "old", seedId: 1, replyTo: REPLY };
    expect(storedChannelOf(reading)).toMatchObject(kept);
    await hydrated(reading);
    expect(reading.drafts.getState().threadBoxes).toEqual({});

    app = await restart();

    expect(channelOf(app)).toMatchObject(kept);
  });

  it("keeps the image another window stored in storage when a reply is chosen and cancelled in the box", async () => {
    const reading = await startReadingAnotherWindowsDraft("pic");
    app = reading;

    reading.drafts.getState().setReplyTarget(BOT_ID, "channel", REPLY);
    reading.drafts.getState().setReplyTarget(BOT_ID, "channel", null);
    await hydrated(reading);

    expect(channelOf(reading)).toMatchObject({
      text: "pic",
      seedId: 1,
      replyTo: null,
    });
    expect(JSON.stringify(channelOf(reading)?.content)).not.toContain(
      "imageAttachment",
    );
    await pastAWrite(reading);
    const stored = JSON.stringify(storedChannelOf(reading));
    expect(stored).toContain("imageAttachment");
    expect(stored).toContain("a".repeat(64));
  });
});
