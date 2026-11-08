/**
 * The bot boxes' drafts kept on this device (Tracy Bots T158), through the
 * REAL drafts store over the real `localStorage` and a fake IndexedDB for the
 * image bytes. Every start of the app loads its modules afresh over what the
 * last run left, as a restart does: what is written after typing pauses, what
 * a start reads back, what a box does while the stored drafts are read, what
 * a window leaves for the others, and what closing Tracy, forgetting a bot
 * and a wipe do to it.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import type * as LandingImageStore from "@/lib/composer/landing-image-store";
import {
  BOT_ID,
  BOX_DRAFTS_KEY,
  INLINE_IMAGE,
  MENTION,
  boxDoc,
  hashedImage,
  hydrated,
  pastTheDebounce,
  restart,
  startApp,
  startFresh,
  storeDraftsAsLeft,
  storeImageBytes,
  storedDrafts,
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

/** The app starts over a stored draft whose image the read has to fetch, and has not answered yet. */
async function startReadingStoredDraft(text: string): Promise<App> {
  const hash = await storeImageBytes();
  storeDraftsAsLeft({
    [BOT_ID]: {
      channel: { text, content: boxDoc(text, [hashedImage(hash)]), seedId: 1 },
    },
  });
  const reading = await startApp();
  expect(reading.drafts.persist.hasHydrated()).toBe(false);
  return reading;
}

describe("the boxes' drafts through the persisted store", () => {
  it("stores a typed draft with its image by hash once typing pauses, and reads it back whole after a restart", async () => {
    const content = boxDoc("Ship it ", [MENTION, INLINE_IMAGE]);
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "Ship it @Ada", content);
    expect(storedDrafts(app)).toBeNull();

    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel !== undefined,
    );

    const raw = localStorage.getItem(BOX_DRAFTS_KEY) ?? "";
    expect(raw).not.toContain("b64content");
    expect(raw).toMatch(/"hash":"[0-9a-f]{64}"/);

    app = await restart();

    expect(app.drafts.getState().threadBoxes[BOT_ID]?.channel).toEqual({
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

    app = await restart();

    const kept = app.drafts.getState().threadBoxes[BOT_ID];
    expect(kept?.withText?.text).toBe("still here");
    expect(JSON.stringify(kept?.withText?.content)).not.toContain(
      "imageAttachment",
    );
    expect(kept?.imageOnly).toBeUndefined();
  });
});

describe("a box changed while the stored drafts are read", () => {
  it("writes what was typed over what was stored, once the read answers and typing pauses", async () => {
    const reading = await startReadingStoredDraft("old");

    reading.drafts.getState().typeThreadBox(BOT_ID, "channel", "new", null);
    await pastTheDebounce(reading);
    expect(storedDrafts(reading)?.[BOT_ID]?.channel?.text).toBe("old");

    await hydrated(reading);

    expect(reading.drafts.getState().threadBoxes[BOT_ID]?.channel?.text).toBe(
      "new",
    );
    await waitForStore(
      reading,
      (stored) => stored?.[BOT_ID]?.channel?.text === "new",
    );
    app = reading;
  });

  it("keeps a box cleared during the read cleared, in memory and in storage", async () => {
    const reading = await startReadingStoredDraft("old");
    reading.drafts.getState().typeThreadBox(BOT_ID, "channel", "mid", null);
    reading.drafts.getState().typeThreadBox(BOT_ID, "channel", "", null);

    await hydrated(reading);

    expect(reading.drafts.getState().threadBoxes[BOT_ID]).toBeUndefined();
    await waitForStore(
      reading,
      (stored) => stored !== null && stored[BOT_ID] === undefined,
    );
    app = reading;
  });

  it("keeps a bot forgotten during the read gone, in memory and in storage", async () => {
    const reading = await startReadingStoredDraft("old");
    reading.drafts.getState().forgetBot(BOT_ID);

    await hydrated(reading);

    expect(reading.drafts.getState().threadBoxes[BOT_ID]).toBeUndefined();
    await waitForStore(
      reading,
      (stored) => stored !== null && stored[BOT_ID] === undefined,
    );
    app = reading;
  });

  it("writes nothing from a read that a wipe overtook", async () => {
    const reading = await startReadingStoredDraft("old");
    reading.storage.stopBotBoxDraftWrites();
    localStorage.removeItem(BOX_DRAFTS_KEY);

    await hydrated(reading);
    reading.drafts.getState().typeThreadBox(BOT_ID, "channel", "after", null);
    window.dispatchEvent(new Event("pagehide"));
    await pastTheDebounce(reading);

    expect(reading.drafts.getState().threadBoxes[BOT_ID]?.channel?.text).toBe(
      "after",
    );
    expect(localStorage.getItem(BOX_DRAFTS_KEY)).toBeNull();
    app = reading;
  });
});

describe("what a window leaves stored", () => {
  it("keeps the images a start restored in a page-hide write made before any image is stored again", async () => {
    const hash = await storeImageBytes();
    storeDraftsAsLeft({
      [BOT_ID]: {
        channel: {
          text: "",
          content: boxDoc("", [hashedImage(hash)]),
          seedId: 1,
        },
      },
    });
    app = await restart();

    app.drafts.getState().typeThreadBox(BOT_ID, "other", "elsewhere", null);
    window.dispatchEvent(new Event("pagehide"));

    expect(JSON.stringify(storedDrafts(app)?.[BOT_ID]?.channel)).toContain(
      hash,
    );
    expect(storedDrafts(app)?.[BOT_ID]?.other?.text).toBe("elsewhere");
  });

  it("leaves another window's drafts alone when this one changed nothing in the boxes", async () => {
    storeDraftsAsLeft({
      [BOT_ID]: {
        channel: { text: "from the sibling", content: null, seedId: 1 },
      },
    });

    app.drafts.getState().typeThreadBox(BOT_ID, "empty", "", null);
    app.drafts.getState().setAnswer(BOT_ID, "question-1", {
      chosen: ["a"],
      typed: "",
      sent: null,
    });
    app.drafts.getState().closeBot(BOT_ID);
    app.drafts.getState().forgetBot("a-bot-holding-nothing");
    window.dispatchEvent(new Event("pagehide"));
    await pastTheDebounce(app);

    expect(storedDrafts(app)?.[BOT_ID]?.channel?.text).toBe("from the sibling");
  });
});

describe("the image hashes the stored drafts keep alive", () => {
  const HASH = "a".repeat(64);

  it("are read from storage as it stands, whichever window wrote them", () => {
    expect(app.imageRoots().has(HASH)).toBe(false);

    storeDraftsAsLeft({
      [BOT_ID]: {
        channel: {
          text: "",
          content: boxDoc("", [hashedImage(HASH)]),
          seedId: 1,
        },
      },
    });
    expect(app.imageRoots().has(HASH)).toBe(true);

    localStorage.removeItem(BOX_DRAFTS_KEY);
    expect(app.imageRoots().has(HASH)).toBe(false);
  });

  it("include the ones this window's boxes hold, after storage drops them", async () => {
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "pic", boxDoc("pic", [INLINE_IMAGE]));
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel !== undefined,
    );
    const hash = /"hash":"([0-9a-f]{64})"/.exec(
      localStorage.getItem(BOX_DRAFTS_KEY) ?? "",
    )?.[1];
    expect(hash).toBeDefined();

    localStorage.removeItem(BOX_DRAFTS_KEY);

    expect(app.imageRoots().has(hash ?? "")).toBe(true);
  });
});

describe("a write a newer one overtakes while it stores an image", () => {
  const IMAGE_STORE = "@/lib/composer/landing-image-store";

  interface HeldPuts {
    readonly app: App;
    /** Resolves once a write has asked for an image's bytes to be stored. */
    readonly entered: Promise<void>;
    /** Lets the held puts store their bytes; resolves once the writes that wait on them are done. */
    readonly release: () => Promise<void>;
  }

  /** The app restarted with every image put held until `release`. */
  async function restartWithImagePutsHeld(): Promise<HeldPuts> {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let enter = (): void => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const puts: Array<Promise<string>> = [];
    vi.doMock(IMAGE_STORE, async (importOriginal) => {
      const real = await importOriginal<typeof LandingImageStore>();
      return {
        ...real,
        putImage: (bytes: ImageBytes): Promise<string> => {
          const put = gate.then(() => real.putImage(bytes));
          puts.push(put);
          enter();
          return put;
        },
      };
    });
    onTestFinished(() => {
      vi.doUnmock(IMAGE_STORE);
    });
    return {
      app: await restart(),
      entered,
      release: async () => {
        open();
        await Promise.all(puts);
        // A write does nothing but microtasks after its puts: one turn of the event loop sees it done.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      },
    };
  }

  async function storingTypedImage(held: HeldPuts): Promise<void> {
    held.app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "pic", boxDoc("pic", [INLINE_IMAGE]));
    await vi.advanceTimersByTimeAsync(
      held.app.storage.BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS,
    );
    await held.entered;
  }

  it("keeps none of its images alive once a cleared box overtook it", async () => {
    const hash = await storeImageBytes();
    const held = await restartWithImagePutsHeld();
    app = held.app;
    await storingTypedImage(held);

    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "", null);
    await waitForStore(
      app,
      (stored) => stored !== null && stored[BOT_ID] === undefined,
    );
    await held.release();

    expect(app.imageRoots().has(hash)).toBe(false);
  });

  it("is not written by a second page hide over the newer draft the first one wrote", async () => {
    const held = await restartWithImagePutsHeld();
    app = held.app;
    await storingTypedImage(held);

    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "newer", null);
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));

    expect(storedDrafts(app)?.[BOT_ID]?.channel?.text).toBe("newer");
    await held.release();
    expect(storedDrafts(app)?.[BOT_ID]?.channel?.text).toBe("newer");
  });
});

describe("closing Tracy and forgetting a bot", () => {
  async function openWithDraft(): Promise<
    typeof import("@/stores/bots/tracy-surface-store").useTracySurfaceStore
  > {
    const { useTracySurfaceStore } =
      await import("@/stores/bots/tracy-surface-store");
    useTracySurfaceStore.setState({
      open: true,
      hostId: "host-1",
      botId: BOT_ID,
      visitedBotIds: [BOT_ID],
    });
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "unsent", null);
    app.drafts.getState().setAnswer(BOT_ID, "question-1", {
      chosen: ["a"],
      typed: "",
      sent: null,
    });
    return useTracySurfaceStore;
  }

  it("keeps a visited bot's box draft, in memory and on the device, and drops its card answers", async () => {
    const surface = await openWithDraft();

    surface.getState().closeSurface();

    expect(app.drafts.getState().threadBoxes[BOT_ID]?.channel?.text).toBe(
      "unsent",
    );
    expect(app.drafts.getState().answers[BOT_ID]).toBeUndefined();
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel !== undefined,
    );
  });

  it("drops everything of a bot that is gone, its box drafts from the device too", async () => {
    const surface = await openWithDraft();
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel !== undefined,
    );

    surface.getState().forgetBot(BOT_ID);

    expect(app.drafts.getState().threadBoxes[BOT_ID]).toBeUndefined();
    expect(app.drafts.getState().answers[BOT_ID]).toBeUndefined();
    await waitForStore(app, (stored) => stored?.[BOT_ID] === undefined);
  });
});

describe("a window that is going away or being wiped", () => {
  it("writes a draft still waiting out the pause at once when the page is hidden, without an image not yet stored", () => {
    app.drafts
      .getState()
      .typeThreadBox(
        BOT_ID,
        "channel",
        "unsent",
        boxDoc("unsent", [INLINE_IMAGE]),
      );
    expect(storedDrafts(app)).toBeNull();

    window.dispatchEvent(new Event("pagehide"));

    const stored = storedDrafts(app)?.[BOT_ID]?.channel;
    expect(stored?.text).toBe("unsent");
    expect(JSON.stringify(stored?.content)).not.toContain("imageAttachment");
  });

  it("keeps a write that has not landed from landing once the stored drafts are being wiped", async () => {
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "unsent", null);

    app.storage.stopBotBoxDraftWrites();
    await pastTheDebounce(app);
    window.dispatchEvent(new Event("pagehide"));

    expect(storedDrafts(app)).toBeNull();
  });
});
