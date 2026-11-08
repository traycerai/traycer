/**
 * The bot boxes' drafts kept on this device (Tracy Bots T158), through the
 * REAL drafts store over the real `localStorage` and a fake IndexedDB for the
 * image bytes: what is written after typing pauses, what an app start reads
 * back, and what closing Tracy, forgetting a bot and a wipe do to it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopBotBoxDraftWrites } from "@/lib/bots/bot-box-draft-storage";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  BOT_ID,
  BOX_DRAFTS_KEY,
  INLINE_IMAGE,
  MENTION,
  boxDoc,
  hashedImage,
  pastTheDebounce,
  restartApp,
  startFresh,
  storeDraftsAsLeft,
  storedDrafts,
  waitForStore,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";

const drafts = () => useBotDraftsStore.getState();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await startFresh();
});

afterEach(() => {
  vi.useRealTimers();
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
  });
});

describe("the boxes' drafts through the persisted store", () => {
  it("stores a typed draft with its image by hash once typing pauses, and reads it back whole after a restart", async () => {
    const content = boxDoc("Ship it ", [MENTION, INLINE_IMAGE]);
    drafts().typeThreadBox(BOT_ID, "channel", "Ship it @Ada", content);
    expect(storedDrafts()).toBeNull();

    await waitForStore((stored) => stored?.[BOT_ID]?.channel !== undefined);

    const raw = localStorage.getItem(BOX_DRAFTS_KEY) ?? "";
    expect(raw).not.toContain("b64content");
    const images = JSON.stringify(storedDrafts()?.[BOT_ID]?.channel?.content);
    const hash = /"hash":"([0-9a-f]{64})"/.exec(images)?.[1];
    expect(hash).toBeDefined();
    expect(await getImageBytes(hash ?? "")).toBeDefined();

    await restartApp();

    expect(drafts().threadBoxes[BOT_ID]?.channel).toEqual({
      text: "Ship it @Ada",
      content,
      seedId: 0,
    });
  });

  it("drops an image whose bytes are gone and keeps the text; a draft left with nothing is dropped", async () => {
    const gone = "f".repeat(64);
    storeDraftsAsLeft({
      [BOT_ID]: {
        withText: {
          text: "still here",
          content: boxDoc("still here", [hashedImage(gone)]),
          seedId: 1,
        },
        imageOnly: {
          text: "",
          content: boxDoc("", [hashedImage(gone)]),
          seedId: 1,
        },
      },
    });

    await restartApp();

    const kept = drafts().threadBoxes[BOT_ID];
    expect(kept?.withText?.text).toBe("still here");
    expect(JSON.stringify(kept?.withText?.content)).not.toContain(
      "imageAttachment",
    );
    expect(kept?.imageOnly).toBeUndefined();
  });

  it("keeps what was typed in a box before the stored drafts were read, and writes nothing over them until they are", async () => {
    storeDraftsAsLeft({
      [BOT_ID]: {
        typedOver: { text: "stored", content: null, seedId: 1 },
        other: { text: "other", content: null, seedId: 1 },
      },
    });
    stopBotBoxDraftWrites();
    useBotDraftsStore.setState({ threadBoxes: {} });

    drafts().typeThreadBox(BOT_ID, "typedOver", "typed", null);
    await pastTheDebounce();

    expect(storedDrafts()?.[BOT_ID]?.typedOver?.text).toBe("stored");

    await useBotDraftsStore.persist.rehydrate();

    expect(drafts().threadBoxes[BOT_ID]?.typedOver?.text).toBe("typed");
    expect(drafts().threadBoxes[BOT_ID]?.other?.text).toBe("other");
  });
});

describe("closing Tracy and forgetting a bot", () => {
  function openWithDraft(): void {
    useTracySurfaceStore.setState({
      open: true,
      hostId: "host-1",
      botId: BOT_ID,
      visitedBotIds: [BOT_ID],
    });
    drafts().typeThreadBox(BOT_ID, "channel", "unsent", null);
    drafts().setAnswer(BOT_ID, "question-1", {
      chosen: ["a"],
      typed: "",
      sent: null,
    });
  }

  it("keeps a visited bot's box draft, in memory and on the device, and drops its card answers", async () => {
    openWithDraft();

    useTracySurfaceStore.getState().closeSurface();

    expect(drafts().threadBoxes[BOT_ID]?.channel?.text).toBe("unsent");
    expect(drafts().answers[BOT_ID]).toBeUndefined();
    await waitForStore((stored) => stored?.[BOT_ID]?.channel !== undefined);
  });

  it("drops everything of a bot that is gone, its box drafts from the device too", async () => {
    openWithDraft();
    await waitForStore((stored) => stored?.[BOT_ID]?.channel !== undefined);

    useTracySurfaceStore.getState().forgetBot(BOT_ID);

    expect(drafts().threadBoxes[BOT_ID]).toBeUndefined();
    expect(drafts().answers[BOT_ID]).toBeUndefined();
    await waitForStore((stored) => stored?.[BOT_ID] === undefined);
  });
});

describe("a window that is going away or being wiped", () => {
  it("writes a draft still waiting out the pause at once when the page is hidden, without an image not yet stored", () => {
    drafts().typeThreadBox(
      BOT_ID,
      "channel",
      "unsent",
      boxDoc("unsent", [INLINE_IMAGE]),
    );
    expect(storedDrafts()).toBeNull();

    window.dispatchEvent(new Event("pagehide"));

    const stored = storedDrafts()?.[BOT_ID]?.channel;
    expect(stored?.text).toBe("unsent");
    expect(JSON.stringify(stored?.content)).not.toContain("imageAttachment");
  });

  it("keeps a write that has not landed from landing once the stored drafts are being wiped", async () => {
    drafts().typeThreadBox(BOT_ID, "channel", "unsent", null);

    stopBotBoxDraftWrites();
    await pastTheDebounce();
    window.dispatchEvent(new Event("pagehide"));

    expect(storedDrafts()).toBeNull();
  });
});
