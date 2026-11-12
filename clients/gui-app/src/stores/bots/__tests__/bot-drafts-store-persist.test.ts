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
  type Mock,
} from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import type * as ImageBase64 from "@/lib/composer/image-base64";
import type * as ReportableErrorToast from "@/lib/reportable-error-toast";
import type * as LandingImageStore from "@/lib/composer/landing-image-store";
import {
  BOT_ID,
  BOX_DRAFTS_KEY,
  IMAGE_B64,
  INLINE_IMAGE,
  MENTION,
  boxDoc,
  hashedImage,
  hydrated,
  pastTheDebounce,
  restart,
  startApp,
  startFresh,
  startWindowBeside,
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

  it("drops an image this window stored whose bytes are gone, from the box and from storage, and keeps the text; a draft left with nothing is dropped", async () => {
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
    app.drafts.getState().typeThreadBox(BOT_ID, "other", "elsewhere", null);
    await waitForStore(app, (stored) => stored?.[BOT_ID]?.other !== undefined);
    expect(localStorage.getItem(BOX_DRAFTS_KEY)).not.toContain(gone);
  });

  it("leaves an image whose bytes cannot be read back out of the box, still reads the drafts, and keeps the image in the next write", async () => {
    const hash = await storeImageBytes();
    storeDraftsAsLeft({
      [BOT_ID]: {
        channel: {
          text: "still here",
          content: boxDoc("still here", [hashedImage(hash)]),
          seedId: 1,
        },
      },
    });
    const IMAGE_BASE64 = "@/lib/composer/image-base64";
    vi.doMock(IMAGE_BASE64, async (importOriginal) => ({
      ...(await importOriginal<typeof ImageBase64>()),
      bytesToBase64Async: () =>
        Promise.reject(new Error("base64 encode failed")),
    }));
    onTestFinished(() => {
      vi.doUnmock(IMAGE_BASE64);
    });

    app = await startApp();
    await vi.waitFor(() => {
      expect(app.drafts.persist.hasHydrated()).toBe(true);
    });

    const kept = app.drafts.getState().threadBoxes[BOT_ID]?.channel;
    expect(kept?.text).toBe("still here");
    expect(JSON.stringify(kept?.content)).not.toContain("imageAttachment");
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "after", null);
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel?.text === "after",
    );
    expect(JSON.stringify(storedDrafts(app)?.[BOT_ID]?.channel)).toContain(
      hash,
    );
  });
});

describe("two windows over one device's storage", () => {
  /** The app runs in the desktop window `windowId`, whose image store is its own. */
  function inWindow(windowId: string): void {
    vi.stubGlobal("runnerHost", { windows: { windowId } });
  }

  /**
   * Window A stores the channel's draft of `text` and an image; window B,
   * which cannot read its bytes, starts.
   */
  async function storedByAThenStartB(text: string): Promise<void> {
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    inWindow("window-a");
    app = await restart();
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", text, boxDoc(text, [INLINE_IMAGE]));
    await waitForStore(app, (stored) =>
      JSON.stringify(stored?.[BOT_ID]?.channel).includes('"hash"'),
    );
    inWindow("window-b");
    app = await restart();
    expect(
      JSON.stringify(
        app.drafts.getState().threadBoxes[BOT_ID]?.channel ?? null,
      ),
    ).not.toContain("imageAttachment");
  }

  it("keeps the image one window stored through another's edits, for the first window to read back", async () => {
    await storedByAThenStartB("pic");

    app.drafts
      .getState()
      .typeThreadBox(
        BOT_ID,
        "channel",
        "pic, edited",
        boxDoc("pic, edited", []),
      );
    app.drafts.getState().typeThreadBox(BOT_ID, "other", "elsewhere", null);
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel?.text === "pic, edited",
    );

    inWindow("window-a");
    app = await restart();
    const channel = app.drafts.getState().threadBoxes[BOT_ID]?.channel;
    expect(channel?.text).toBe("pic, edited");
    expect(JSON.stringify(channel?.content)).toContain(IMAGE_B64);
  });

  it("drops that image once the other window's person clears the box", async () => {
    await storedByAThenStartB("pic");

    app.drafts
      .getState()
      .typeThreadBox(
        BOT_ID,
        "channel",
        "pic, edited",
        boxDoc("pic, edited", []),
      );
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "", null);
    app.drafts.getState().typeThreadBox(BOT_ID, "other", "elsewhere", null);
    await waitForStore(app, (stored) => stored?.[BOT_ID]?.other !== undefined);

    expect(storedDrafts(app)?.[BOT_ID]?.channel).toBeUndefined();
  });

  it("drops a box that held only the other window's image once this window's person types in it and clears it", async () => {
    await storedByAThenStartB("");

    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "hi", boxDoc("hi", []));
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "", null);
    await waitForStore(
      app,
      (stored) => stored !== null && stored[BOT_ID] === undefined,
    );
  });

  it("drops a box holding only the other window's image once this window forgets its bot", async () => {
    await storedByAThenStartB("");
    expect(app.drafts.getState().threadBoxes[BOT_ID]).toBeUndefined();

    app.drafts.getState().forgetBot(BOT_ID);

    await waitForStore(
      app,
      (stored) => stored !== null && stored[BOT_ID] === undefined,
    );
  });

  it("carries that image in one paragraph however often the other window reads and edits the draft", async () => {
    await storedByAThenStartB("pic");

    for (const edit of ["one", "two", "three"]) {
      const kept = app.drafts.getState().threadBoxes[BOT_ID]?.channel;
      const text = `${kept?.text ?? ""} ${edit}`;
      app.drafts
        .getState()
        .typeThreadBox(BOT_ID, "channel", text, kept?.content ?? null);
      await waitForStore(
        app,
        (stored) => stored?.[BOT_ID]?.channel?.text === text,
      );
      app = await restart();
    }

    const content = storedDrafts(app)?.[BOT_ID]?.channel?.content;
    expect(content?.content?.map((block) => block.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect(JSON.stringify(content)).toContain('"hash"');
  });

  it("charges an image pasted here that another window's draft holds against this window's image budget", async () => {
    const toast = watchRefusalToast();
    await storedByAThenStartB("pic");
    await fillImageBudget();

    app.drafts
      .getState()
      .typeThreadBox(
        BOT_ID,
        "other",
        "same pic",
        boxDoc("same pic", [INLINE_IMAGE]),
      );
    await waitForStore(app, (stored) => stored?.[BOT_ID]?.other !== undefined);

    expect(JSON.stringify(storedDrafts(app)?.[BOT_ID]?.other)).not.toContain(
      "imageAttachment",
    );
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe("two windows open at once over one device's storage", () => {
  /** A second window beside the running one, read and ready; closed when the test ends. */
  async function windowBeside(): Promise<App> {
    const beside = await hydrated(await startWindowBeside());
    onTestFinished(beside.close);
    return beside;
  }

  it("keeps a box another window saved when this one saves and clears its own", async () => {
    const a = app;
    const b = await windowBeside();

    a.drafts.getState().typeThreadBox(BOT_ID, "x", "from A", null);
    await waitForStore(a, (stored) => stored?.[BOT_ID]?.x !== undefined);
    b.drafts.getState().typeThreadBox(BOT_ID, "y", "from B", null);
    await waitForStore(b, (stored) => stored?.[BOT_ID]?.y !== undefined);
    expect(storedDrafts(b)?.[BOT_ID]?.x?.text).toBe("from A");

    b.drafts.getState().typeThreadBox(BOT_ID, "y", "", null);
    await waitForStore(
      b,
      (stored) => stored !== null && stored[BOT_ID]?.y === undefined,
    );

    expect(storedDrafts(b)?.[BOT_ID]?.x?.text).toBe("from A");
  });

  it("does not bring back a box another window cleared when this one saves another", async () => {
    app.drafts.getState().typeThreadBox(BOT_ID, "x", "from A", null);
    await waitForStore(app, (stored) => stored?.[BOT_ID]?.x !== undefined);
    const a = app;
    const b = await windowBeside();
    expect(b.drafts.getState().threadBoxes[BOT_ID]?.x?.text).toBe("from A");

    b.drafts.getState().typeThreadBox(BOT_ID, "x", "", null);
    await waitForStore(
      b,
      (stored) => stored !== null && stored[BOT_ID] === undefined,
    );
    a.drafts.getState().typeThreadBox(BOT_ID, "z", "from A again", null);
    await waitForStore(a, (stored) => stored?.[BOT_ID]?.z !== undefined);

    expect(storedDrafts(a)?.[BOT_ID]?.x).toBeUndefined();
  });

  it.each(["pic", ""])(
    "does not bring back a box another window cleared that this one wrote without its image (text %j)",
    async (text) => {
      app.drafts
        .getState()
        .typeThreadBox(BOT_ID, "x", text, boxDoc(text, [INLINE_IMAGE]));
      window.dispatchEvent(new Event("pagehide"));
      expect(
        JSON.stringify(storedDrafts(app)?.[BOT_ID]?.x ?? null),
      ).not.toContain("imageAttachment");
      const a = app;
      const b = await windowBeside();

      // An image-only draft reads back as nothing there: typing is what a clear needs first.
      b.drafts.getState().typeThreadBox(BOT_ID, "x", "hi", boxDoc("hi", []));
      b.drafts.getState().typeThreadBox(BOT_ID, "x", "", null);
      await waitForStore(
        b,
        (stored) => stored !== null && stored[BOT_ID] === undefined,
      );
      a.drafts.getState().typeThreadBox(BOT_ID, "z", "from A", null);
      await waitForStore(a, (stored) => stored?.[BOT_ID]?.z !== undefined);

      expect(storedDrafts(a)?.[BOT_ID]?.x).toBeUndefined();
    },
  );

  it("drops a bot's boxes another window saved, and their images' roots, when this window forgets the bot holding none of them", async () => {
    const a = app;
    const b = await windowBeside();
    b.drafts
      .getState()
      .typeThreadBox(
        BOT_ID,
        "channel",
        "from B",
        boxDoc("from B", [INLINE_IMAGE]),
      );
    await waitForStore(b, (stored) =>
      JSON.stringify(stored?.[BOT_ID]?.channel ?? null).includes('"hash"'),
    );
    const hash =
      /"hash":"([0-9a-f]{64})"/.exec(JSON.stringify(storedDrafts(a)))?.[1] ??
      "";
    expect(a.imageRoots().has(hash)).toBe(true);
    expect(a.drafts.getState().threadBoxes[BOT_ID]).toBeUndefined();

    a.drafts.getState().forgetBot(BOT_ID);
    await waitForStore(
      a,
      (stored) => stored !== null && stored[BOT_ID] === undefined,
    );

    expect(a.imageRoots().has(hash)).toBe(false);
  });

  it("leaves a box another window wrote ahead of its only image for that window to finish, when this one takes its own gone image out of storage", async () => {
    storeDraftsAsLeft({
      [BOT_ID]: {
        x: {
          text: "",
          content: boxDoc("", [hashedImage("f".repeat(64))]),
          seedId: 1,
        },
      },
    });
    app = await restart();
    const a = app;
    const b = await windowBeside();

    b.drafts
      .getState()
      .typeThreadBox(BOT_ID, "x", "", boxDoc("", [INLINE_IMAGE]));
    window.dispatchEvent(new Event("pagehide"));
    expect(storedDrafts(b)?.[BOT_ID]?.x?.text).toBe("");
    a.drafts.getState().typeThreadBox(BOT_ID, "z", "from A", null);
    await waitForStore(a, (stored) => stored?.[BOT_ID]?.z !== undefined);
    b.drafts.getState().typeThreadBox(BOT_ID, "y", "from B", null);
    await waitForStore(b, (stored) => stored?.[BOT_ID]?.y !== undefined);

    expect(JSON.stringify(storedDrafts(b)?.[BOT_ID]?.x ?? null)).toContain(
      '"hash"',
    );
  });
});

/**
 * The refusal the person sees, watched: in force for every start after this
 * call, until the test ends.
 */
function watchRefusalToast(): Mock {
  const REPORTABLE_TOAST = "@/lib/reportable-error-toast";
  const toast = vi.fn();
  vi.doMock(REPORTABLE_TOAST, async (importOriginal) => ({
    ...(await importOriginal<typeof ReportableErrorToast>()),
    reportableErrorToast: toast,
  }));
  onTestFinished(() => {
    vi.doUnmock(REPORTABLE_TOAST);
  });
  return toast;
}

/**
 * Another paste or import holds the whole image budget of the running app's
 * window, once its image store has measured what it holds.
 */
async function fillImageBudget(): Promise<{ readonly release: () => void }> {
  const { awaitLandingImageSizes } =
    await import("@/lib/composer/landing-image-store");
  await awaitLandingImageSizes();
  const budget = await import("@/lib/composer/landing-image-budget");
  const elsewhere = budget.tryReserveLandingImageBudget([
    { hash: null, bytes: budget.LANDING_IMAGE_BUDGET_BYTES },
  ]);
  if (elsewhere === null) throw new Error("the budget is not empty");
  return elsewhere;
}

describe("the image budget a draft's images are stored under", () => {
  it("writes a draft without an image the budget refuses, tells the person once, and stores the image once there is room", async () => {
    const toast = watchRefusalToast();
    app = await restart();
    const elsewhere = await fillImageBudget();

    const content = boxDoc("pic", [INLINE_IMAGE]);
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "pic", content);
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel !== undefined,
    );
    expect(localStorage.getItem(BOX_DRAFTS_KEY)).not.toContain(
      "imageAttachment",
    );
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "pic more", content);
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel?.text === "pic more",
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "Couldn't add the image.",
      expect.anything(),
      expect.anything(),
    );

    elsewhere.release();
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "pic again", content);
    await waitForStore(app, (stored) =>
      JSON.stringify(stored?.[BOT_ID]?.channel).includes('"hash"'),
    );
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("tells the person again about an image pasted again after the refused one was removed", async () => {
    const toast = watchRefusalToast();
    app = await restart();
    await fillImageBudget();

    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "pic", boxDoc("pic", [INLINE_IMAGE]));
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel !== undefined,
    );
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "no pic", boxDoc("no pic", []));
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel?.text === "no pic",
    );
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "pic", boxDoc("pic", [INLINE_IMAGE]));
    await waitForStore(
      app,
      (stored) => stored?.[BOT_ID]?.channel?.text === "pic",
    );

    expect(toast).toHaveBeenCalledTimes(2);
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
      unsureSince: null,
      heldForSettlement: null,
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

  it("leave out the image of a box cleared and written at once by a page hide", async () => {
    const hash = await storeImageBytes();
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "pic", boxDoc("pic", [INLINE_IMAGE]));
    await waitForStore(app, (stored) =>
      JSON.stringify(stored?.[BOT_ID]?.channel).includes(hash),
    );
    expect(app.imageRoots().has(hash)).toBe(true);

    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "", null);
    window.dispatchEvent(new Event("pagehide"));

    expect(storedDrafts(app)?.[BOT_ID]).toBeUndefined();
    expect(app.imageRoots().has(hash)).toBe(false);
  });
});

describe("a write a newer one overtakes while it stores an image", () => {
  const IMAGE_STORE = "@/lib/composer/landing-image-store";

  /** A second image, told apart from the PNG by its first byte. */
  const GIF_IMAGE: JsonContent = {
    type: "imageAttachment",
    attrs: {
      id: "image-2",
      fileName: "dot.gif",
      mimeType: "image/gif",
      b64content: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    },
  };
  const isGif = (bytes: ImageBytes): boolean => bytes[0] === 0x47;
  const everyImage = (): boolean => true;

  interface HeldPuts {
    readonly app: App;
    /** Resolves once a write has asked for a held image's bytes to be stored. */
    readonly entered: Promise<void>;
    /** Lets the held puts store their bytes; resolves once the writes that wait on them are done. */
    readonly release: () => Promise<void>;
  }

  /** The app restarted with the puts of the images `holds` picks held until `release`. */
  async function restartWithImagePutsHeld(
    holds: (bytes: ImageBytes) => boolean,
  ): Promise<HeldPuts> {
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
          if (!holds(bytes)) return real.putImage(bytes);
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
        // A write does nothing but microtasks after its puts: an async advance of the fake clock flushes them.
        await vi.advanceTimersByTimeAsync(0);
      },
    };
  }

  /** The channel's draft of `text` and an image is being written, its image put held. */
  async function storingTypedImage(
    held: HeldPuts,
    text: string,
  ): Promise<void> {
    held.app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", text, boxDoc(text, [INLINE_IMAGE]));
    await vi.advanceTimersByTimeAsync(
      held.app.storage.BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS,
    );
    await held.entered;
  }

  it("keeps none of its images alive once a cleared box overtook it", async () => {
    const hash = await storeImageBytes();
    const held = await restartWithImagePutsHeld(everyImage);
    app = held.app;
    await storingTypedImage(held, "pic");

    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "", null);
    await waitForStore(
      app,
      (stored) => stored !== null && stored[BOT_ID] === undefined,
    );
    await held.release();

    expect(app.imageRoots().has(hash)).toBe(false);
  });

  it.each(["pic", ""])(
    "writes the image a page hide left out once its write stores it, though nothing else changed (text %j)",
    async (text) => {
      const held = await restartWithImagePutsHeld(everyImage);
      app = held.app;
      await storingTypedImage(held, text);

      window.dispatchEvent(new Event("pagehide"));
      expect(
        JSON.stringify(storedDrafts(app)?.[BOT_ID]?.channel ?? null),
      ).not.toContain("imageAttachment");
      await held.release();

      expect(JSON.stringify(storedDrafts(app)?.[BOT_ID]?.channel)).toContain(
        '"hash"',
      );
    },
  );

  it("is not written by a second page hide over the newer draft the first one wrote", async () => {
    const held = await restartWithImagePutsHeld(everyImage);
    app = held.app;
    await storingTypedImage(held, "pic");

    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "newer", null);
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));

    expect(storedDrafts(app)?.[BOT_ID]?.channel?.text).toBe("newer");
    await held.release();
    expect(storedDrafts(app)?.[BOT_ID]?.channel?.text).toBe("newer");
  });

  it("hands an image it had stored to the page hide that overtook it, and on to the next one", async () => {
    const pngHash = await storeImageBytes();
    const held = await restartWithImagePutsHeld(isGif);
    app = held.app;
    const content = boxDoc("two", [INLINE_IMAGE, GIF_IMAGE]);
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "two", content);
    await vi.advanceTimersByTimeAsync(
      app.storage.BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS,
    );
    await held.entered;
    await vi.waitFor(() => {
      expect(app.imageRoots().has(pngHash)).toBe(true);
    });

    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "two more", content);
    window.dispatchEvent(new Event("pagehide"));
    app.drafts
      .getState()
      .typeThreadBox(BOT_ID, "channel", "two again", content);
    window.dispatchEvent(new Event("pagehide"));

    const stored = storedDrafts(app)?.[BOT_ID]?.channel;
    expect(stored?.text).toBe("two again");
    expect(JSON.stringify(stored?.content)).toContain(pngHash);
    await held.release();
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
      unsureSince: null,
      heldForSettlement: null,
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

  it("writes a draft storage refused once the page is hidden", async () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new DOMException(
          "The quota has been exceeded.",
          "QuotaExceededError",
        );
      });
    onTestFinished(() => {
      setItem.mockRestore();
    });
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "unsent", null);
    await vi.advanceTimersByTimeAsync(
      app.storage.BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS,
    );
    await vi.waitFor(() => {
      expect(setItem).toHaveBeenCalled();
    });
    expect(storedDrafts(app)).toBeNull();

    window.dispatchEvent(new Event("pagehide"));

    expect(storedDrafts(app)?.[BOT_ID]?.channel?.text).toBe("unsent");
  });

  it("keeps a write that has not landed from landing once the stored drafts are being wiped", async () => {
    app.drafts.getState().typeThreadBox(BOT_ID, "channel", "unsent", null);

    app.storage.stopBotBoxDraftWrites();
    await pastTheDebounce(app);
    window.dispatchEvent(new Event("pagehide"));

    expect(storedDrafts(app)).toBeNull();
  });
});
