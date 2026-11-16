/**
 * A reply chosen for a box whose stored draft still waits for its images
 * (Tracy Bots T166 over T186's staged read), through the REAL drafts store and
 * storage over `localStorage`: the stored text is read at once, a box whose
 * draft names an image waits on its own mark (`boxesReading`), and the image
 * read is held until a case releases it. The reply goes onto the waiting mark
 * and onto the box's stored draft, never into an entry of the store's drafts,
 * which a write would put over the stored text and image hashes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { StoredBoxDraft } from "@/lib/bots/bot-box-draft-storage";
import { base64ToBytes } from "@/lib/composer/image-base64";
import type { BotReplyTarget } from "@/lib/bots/bot-reply-target";
import {
  BOT_ID,
  BOX_DRAFTS_KEY,
  IMAGE_B64,
  TEST_USER_ID,
  boxDoc,
  failFirstReadOf,
  hydrated,
  readDraftsStoreAs,
  retireDraftsStoreAs,
  hashedImage,
  restart,
  startFresh,
  startSignedOutApp,
  storeDraftsAsLeft,
  storeImageBytes,
  storedDrafts,
  waitForStore,
  type App,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";
import type { BotThreadBoxDraft } from "@/stores/bots/bot-drafts-store";

/** The image reads the drafts asked the image store for: each is held until a case releases them. */
const held = vi.hoisted(() => ({
  reads: [] as Array<PromiseWithResolvers<Uint8Array<ArrayBuffer> | undefined>>,
  released: null as Uint8Array<ArrayBuffer> | null,
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return {
    ...real,
    getImageBytes: () => {
      const read = Promise.withResolvers<Uint8Array<ArrayBuffer> | undefined>();
      if (held.released === null) held.reads.push(read);
      else read.resolve(held.released);
      return read.promise;
    },
  };
});

/** Every image read, asked for now or later, answers with the fixture's bytes. */
function releaseImages(): void {
  const bytes = base64ToBytes(IMAGE_B64);
  if (bytes === null) throw new Error("the fixture image decodes");
  held.released = bytes;
  for (const read of held.reads) read.resolve(bytes);
}

const REPLY: BotReplyTarget = {
  messageId: "message-1",
  author: "Sam",
  line: "Ship it on Friday",
};

const OTHER_REPLY: BotReplyTarget = { ...REPLY, messageId: "message-0" };

let app: App;
/** Box `a`'s stored draft names the fixture image; box `c`'s names none. */
let storedA: StoredBoxDraft;
const STORED_C: StoredBoxDraft = {
  text: "C text",
  content: boxDoc("C text", []),
  seedId: 1,
  replyTo: null,
};

beforeEach(async () => {
  held.reads.length = 0;
  held.released = null;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  app = await startFresh();
  const hash = await storeImageBytes();
  storedA = {
    text: "A text",
    content: boxDoc("A text", [hashedImage(hash)]),
    seedId: 1,
    replyTo: null,
  };
});

afterEach(() => {
  for (const read of held.reads) read.resolve(undefined);
  app.close();
  vi.useRealTimers();
});

/**
 * The account's boxes stored and the app started over them. `whileRead` runs
 * in the turn the read starts in, before any of it is answered: what the
 * person does before the stored text is read.
 */
async function startReading(
  boxes: Readonly<Record<string, StoredBoxDraft>>,
  whileRead: (started: App) => void,
): Promise<App> {
  storeDraftsAsLeft({ [BOT_ID]: boxes });
  const started = await startSignedOutApp();
  app = started;
  retireDraftsStoreAs(started, TEST_USER_ID);
  expect(started.drafts.getState().ownDraftsRead).toBe(false);
  readDraftsStoreAs(started, TEST_USER_ID);
  whileRead(started);
  return started;
}

/** As {@link startReading}, admitted once the stored text is read: the image box waits. */
async function startOver(
  boxes: Readonly<Record<string, StoredBoxDraft>>,
): Promise<App> {
  const started = await startReading(boxes, () => undefined);
  await vi.waitFor(() =>
    expect(started.drafts.getState().ownDraftsRead).toBe(true),
  );
  return started;
}

/**
 * A reply chosen while the stored drafts are read, before the text of a draft
 * that names images is: another window stores such a draft for box `a` while
 * this window's read of the others is under way, and its write has this window
 * read the account's drafts again (`installCrossWindowRehydrate`). `whileRead`
 * runs in that turn, after the reply and the write.
 */
async function startReadingUntilAnotherWindowStores(
  reply: { readonly key: string },
  whileRead: (started: App) => void,
): Promise<App> {
  return startReading({ c: STORED_C }, (reading) => {
    reading.drafts.getState().setReplyTarget(BOT_ID, reply.key, REPLY);
    storeDraftsAsLeft({ [BOT_ID]: { a: storedA, c: STORED_C } });
    whileRead(reading);
  });
}

function boxOf(started: App, key: string): BotThreadBoxDraft | undefined {
  return started.drafts.getState().threadBoxes[BOT_ID]?.[key];
}

function markOf(started: App, key: string): { replyTo: BotReplyTarget | null } {
  const mark = started.drafts.getState().boxesReading[BOT_ID]?.[key];
  if (mark === undefined) throw new Error(`box ${key} does not wait`);
  return mark;
}

function storedBox(started: App, key: string): StoredBoxDraft | undefined {
  return storedDrafts(started)?.[BOT_ID]?.[key];
}

/** The images have been read back and the boxes are no longer waiting. */
async function readBack(started: App): Promise<void> {
  releaseImages();
  await vi.waitFor(() =>
    expect(started.drafts.getState().boxesReading).toEqual({}),
  );
}

/** Types in box `c`, so the store's drafts are written, and waits for it. */
async function pastAWrite(started: App): Promise<void> {
  started.drafts.getState().typeThreadBox(BOT_ID, "c", {
    text: "C edited",
    content: null,
    held: [],
  });
  await waitForStore(
    started,
    (document) => document?.[BOT_ID]?.c?.text === "C edited",
  );
}

describe("a reply chosen for a box that waits for its draft's images", () => {
  it("leaves the stored text and image hashes as stored, under the reply, when it is chosen after the text read, and reads the draft back under it", async () => {
    const started = await startOver({ a: storedA, c: STORED_C });

    started.drafts.getState().setReplyTarget(BOT_ID, "a", REPLY);

    expect(boxOf(started, "a")).toBeUndefined();
    expect(markOf(started, "a").replyTo).toEqual(REPLY);
    expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: REPLY });
    await pastAWrite(started);
    expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: REPLY });

    await readBack(started);

    expect(boxOf(started, "a")).toMatchObject({
      text: "A text",
      seedId: 1,
      replyTo: REPLY,
    });
    expect(JSON.stringify(boxOf(started, "a")?.content)).toContain(IMAGE_B64);
    started.drafts.getState().typeThreadBox(BOT_ID, "c", {
      text: "C edited again",
      content: null,
      held: [],
    });
    await waitForStore(
      started,
      (document) => document?.[BOT_ID]?.c?.text === "C edited again",
    );
    expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: REPLY });
  });

  it("keeps the stored draft under a reply chosen before the text read, with no entry for the box and the reply on its mark", async () => {
    const started = await startReadingUntilAnotherWindowStores(
      { key: "a" },
      (reading) => void reading.drafts.persist.rehydrate(),
    );
    await vi.waitFor(() =>
      expect(started.drafts.getState().ownDraftsRead).toBe(true),
    );

    expect(boxOf(started, "a")).toBeUndefined();
    expect(markOf(started, "a").replyTo).toEqual(REPLY);
    expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: REPLY });
    await pastAWrite(started);
    expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: REPLY });

    await readBack(started);

    expect(boxOf(started, "a")).toMatchObject({
      text: "A text",
      seedId: 1,
      replyTo: REPLY,
    });
    expect(JSON.stringify(boxOf(started, "a")?.content)).toContain(IMAGE_B64);
  });

  it("keeps the reply on the stored draft while an image read never ends, and reads the draft back under it after a restart", async () => {
    const started = await startOver({ a: storedA, c: STORED_C });

    started.drafts.getState().setReplyTarget(BOT_ID, "a", REPLY);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await pastAWrite(started);

    expect(markOf(started, "a").replyTo).toEqual(REPLY);
    expect(boxOf(started, "a")).toBeUndefined();
    expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: REPLY });

    releaseImages();
    app = await restart();
    await vi.waitFor(() =>
      expect(app.drafts.getState().boxesReading).toEqual({}),
    );

    expect(boxOf(app, "a")).toMatchObject({
      text: "A text",
      seedId: 1,
      replyTo: REPLY,
    });
    expect(JSON.stringify(boxOf(app, "a")?.content)).toContain(IMAGE_B64);
  });

  it("clears the reply on the mark and the stored draft, leaving text and image hashes, when it is cancelled, and reads the draft back replying to none", async () => {
    const started = await startOver({
      a: { ...storedA, replyTo: OTHER_REPLY },
      c: STORED_C,
    });
    expect(markOf(started, "a").replyTo).toEqual(OTHER_REPLY);

    started.drafts.getState().setReplyTarget(BOT_ID, "a", null);

    expect(markOf(started, "a").replyTo).toBeNull();
    expect(boxOf(started, "a")).toBeUndefined();
    expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: null });
    await pastAWrite(started);
    expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: null });

    await readBack(started);

    expect(boxOf(started, "a")).toMatchObject({
      text: "A text",
      seedId: 1,
      replyTo: null,
    });
  });

  it("reads a draft back that holds only the reply as a reply-only draft", async () => {
    const started = await startOver({
      a: {
        text: "",
        content: boxDoc("", [hashedImage("d4".repeat(32))]),
        seedId: 1,
        replyTo: null,
      },
    });
    started.drafts.getState().setReplyTarget(BOT_ID, "a", REPLY);

    for (const read of held.reads) read.resolve(undefined);
    await vi.waitFor(() =>
      expect(started.drafts.getState().boxesReading).toEqual({}),
    );

    expect(boxOf(started, "a")).toMatchObject({ replyTo: REPLY });
  });

  it("merges a reply chosen during the read for a box with no images under the reply, and writes it", async () => {
    const started = await startReadingUntilAnotherWindowStores(
      { key: "c" },
      (reading) => void reading.drafts.persist.rehydrate(),
    );
    await vi.waitFor(() =>
      expect(started.drafts.getState().ownDraftsRead).toBe(true),
    );

    expect(boxOf(started, "c")).toEqual({ ...STORED_C, replyTo: REPLY });
    await waitForStore(
      started,
      (document) =>
        document?.[BOT_ID]?.c?.replyTo?.messageId === REPLY.messageId,
    );
    expect(storedBox(started, "c")).toEqual({ ...STORED_C, replyTo: REPLY });
    expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: null });
  });

  it("keeps the text typed into the waiting box after the reply under the reply, in memory and in storage", async () => {
    const started = await startOver({ a: storedA, c: STORED_C });

    started.drafts.getState().setReplyTarget(BOT_ID, "a", REPLY);
    started.drafts.getState().typeThreadBox(BOT_ID, "a", {
      text: "new",
      content: null,
      held: [],
    });

    const typed = { text: "new", content: null, seedId: 0, replyTo: REPLY };
    expect(boxOf(started, "a")).toEqual(typed);
    await waitForStore(
      started,
      (document) => document?.[BOT_ID]?.a?.text === "new",
    );
    expect(storedBox(started, "a")).toEqual(typed);

    // The read ends once every waiting box's images have reached the store.
    releaseImages();
    await hydrated(started);
    expect(boxOf(started, "a")).toEqual(typed);
  });

  describe("when the account retires before the images are read", () => {
    it("keeps the stored text and image hashes of the waiting box under the reply chosen before the text read", async () => {
      const started = await startReadingUntilAnotherWindowStores(
        { key: "a" },
        (reading) => retireDraftsStoreAs(reading, "user-next"),
      );

      expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: REPLY });
      expect(started.drafts.getState().threadBoxes).toEqual({});

      releaseImages();
      app = await restart();
      await vi.waitFor(() =>
        expect(app.drafts.getState().boxesReading).toEqual({}),
      );

      expect(boxOf(app, "a")).toMatchObject({ text: "A text", replyTo: REPLY });
    });

    it("keeps the stored text and image hashes under the reply chosen after the text read", async () => {
      const started = await startOver({ a: storedA, c: STORED_C });

      started.drafts.getState().setReplyTarget(BOT_ID, "a", REPLY);
      retireDraftsStoreAs(started, "user-next");

      expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: REPLY });
    });

    // The first read's box `c` is in the store and is written in any case, so
    // the key is rewritten (normalised) whatever the retirement does with the
    // reply: what is asserted is the draft of `a`, not the key's bytes.
    it("leaves the account's stored key as it was when storage cannot be read at retirement, for a reply chosen before the text read", async () => {
      const started = await startReadingUntilAnotherWindowStores(
        { key: "a" },
        (reading) => {
          failFirstReadOf(BOX_DRAFTS_KEY);
          retireDraftsStoreAs(reading, "user-next");
        },
      );

      expect(storedBox(started, "a")).toEqual({ ...storedA, replyTo: null });
    });

    it("leaves the account's stored key as it was when storage cannot be read at retirement", async () => {
      const started = await startOver({ a: storedA, c: STORED_C });
      started.drafts.getState().setReplyTarget(BOT_ID, "a", REPLY);
      const before = localStorage.getItem(BOX_DRAFTS_KEY);
      expect(before).toContain(REPLY.messageId);

      failFirstReadOf(BOX_DRAFTS_KEY);
      retireDraftsStoreAs(started, "user-next");

      expect(localStorage.getItem(BOX_DRAFTS_KEY)).toBe(before);
    });
  });

  describe("when the person discards the waiting box", () => {
    it("drops the draft and the reply, and writes nothing back under the reply", async () => {
      const started = await startOver({ a: storedA, c: STORED_C });
      started.drafts.getState().setReplyTarget(BOT_ID, "a", REPLY);
      const { useBotDraftActions } =
        await import("@/stores/bots/bot-drafts-store");
      const { result } = renderHook(() => useBotDraftActions());

      result.current.discardReadingBox(BOT_ID, "a");

      expect(started.drafts.getState().boxesReading).toEqual({});
      expect(boxOf(started, "a")).toBeUndefined();
      await pastAWrite(started);
      await waitForStore(
        started,
        (document) => document?.[BOT_ID]?.a === undefined,
      );

      await readBackWithNothingLeft(started);

      expect(boxOf(started, "a")).toBeUndefined();
      expect(storedBox(started, "a")).toBeUndefined();
      expect(storedBox(started, "c")?.text).toBe("C edited");
    });
  });
});

/** The held image reads end after the box was discarded: nothing comes back for it. */
async function readBackWithNothingLeft(started: App): Promise<void> {
  releaseImages();
  await hydrated(started);
  await pastAWrite(started);
}
