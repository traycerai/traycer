/**
 * The bot boxes' drafts while the images they name are still being read
 * (Tracy Bots T186), through the REAL drafts store and storage over
 * `localStorage`: the account's stored text is read at once, so the tab opens,
 * and only a box whose stored draft names images still being read waits, by its
 * stored text, until its own images settle or the person discards it. Every
 * image read, every image put and an image store's deletion is held, released
 * or signalled by the case, one hash at a time. What is asserted is the store
 * and the whole stored document, at the points a case names: once the writes
 * have settled, and once the page hides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { botBoxDraftsKey } from "@/lib/persist";
import {
  BOT_ID,
  BOX_DRAFTS_KEY,
  boxDoc,
  hashedImage,
  startFresh,
  startSignedOutApp,
  TEST_USER_ID,
  storeDraftsAsLeft,
  storedDrafts,
  waitForStore,
  type App,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";
import type { StoredBoxDraft } from "@/lib/bots/bot-box-draft-storage";

/** What the image store's mock holds, for a case to release. */
const images = vi.hoisted(() => ({
  /** Every read the drafts asked the image store for, in order, each held until the case settles it. */
  calls: [] as Array<{
    readonly hash: string;
    readonly read: PromiseWithResolvers<Uint8Array<ArrayBuffer> | undefined>;
  }>,
  /** How the reads of a hash were settled: a read asked for afterwards answers the same. */
  outcomes: new Map<
    string,
    | { readonly bytes: Uint8Array<ArrayBuffer> | undefined }
    | { readonly error: Error }
  >(),
  /** The put of each hash a case holds, until it releases it. */
  puts: new Map<string, PromiseWithResolvers<void>>(),
  /** The hashes the drafts asked the image store to put, one entry per call. */
  putCalls: [] as string[],
  deletions: { count: 0, listeners: [] as Array<() => void> },
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return {
    ...real,
    getImageBytes: (hash: string) => {
      const read = Promise.withResolvers<Uint8Array<ArrayBuffer> | undefined>();
      images.calls.push({ hash, read });
      const outcome = images.outcomes.get(hash);
      if (outcome !== undefined) {
        if ("error" in outcome) read.reject(outcome.error);
        else read.resolve(outcome.bytes);
      }
      return read.promise;
    },
    putImage: async (bytes: Uint8Array<ArrayBuffer>) => {
      const hash = await real.sha256Hex(bytes);
      images.putCalls.push(hash);
      await images.puts.get(hash)?.promise;
      return hash;
    },
    landingImageDeletions: () => images.deletions.count,
    onLandingImagesDeleted: (listener: () => void) => {
      images.deletions.listeners.push(listener);
    },
  };
});

/** How many images read back from the image store have been encoded for their box. */
const encodes = vi.hoisted(() => ({ done: 0 }));

vi.mock("@/lib/composer/image-base64", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/composer/image-base64")>();
  return {
    ...real,
    bytesToBase64Async: async (bytes: Uint8Array) => {
      const b64 = await real.bytesToBase64Async(bytes);
      encodes.done += 1;
      return b64;
    },
  };
});

/** Every read of `hash`, asked for now or later, answers with `bytes`, or with nothing. */
function settleRead(
  hash: string,
  bytes: Uint8Array<ArrayBuffer> | undefined,
): void {
  images.outcomes.set(hash, { bytes });
  for (const call of images.calls) {
    if (call.hash === hash) call.read.resolve(bytes);
  }
}

/** Every read of `hash`, asked for now or later, fails. */
function failRead(hash: string, error: Error): void {
  images.outcomes.set(hash, { error });
  for (const call of images.calls) {
    if (call.hash === hash) call.read.reject(error);
  }
}

/** The read that was asked for `index`th answers with `bytes`; no other read does. */
function settleReadCall(
  index: number,
  bytes: Uint8Array<ArrayBuffer> | undefined,
): void {
  images.calls[index]?.read.resolve(bytes);
}

/** The hashes the drafts asked the image store to read, one entry per call. */
function readCalls(): string[] {
  return images.calls.map((call) => call.hash);
}

function holdPut(hash: string): void {
  images.puts.set(hash, Promise.withResolvers<void>());
}

function releasePut(hash: string): void {
  images.puts.get(hash)?.resolve();
}

/** Another window's wipe deleted the image database under this one, as the image store signals it. */
function deleteImageStore(): void {
  images.deletions.count += 1;
  for (const listener of images.deletions.listeners) listener();
}

function pageHides(): void {
  window.dispatchEvent(new Event("pagehide"));
}

function bytesOf(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

function base64Of(bytes: Uint8Array<ArrayBuffer>): string {
  return btoa(String.fromCharCode(...bytes));
}

async function sha256Of(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const { sha256Hex } = await vi.importActual<
    typeof import("@/lib/composer/landing-image-store")
  >("@/lib/composer/landing-image-store");
  return sha256Hex(bytes);
}

/** An image the person pasted into a box: its bytes inline, as the box holds it. */
function pasted(id: string, bytes: Uint8Array<ArrayBuffer>): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id,
      fileName: `${id}.png`,
      mimeType: "image/png",
      b64content: base64Of(bytes),
    },
  };
}

const HASH_A = "a1".repeat(32);
const HASH_B = "b2".repeat(32);
const HASH_X = "c3".repeat(32);
const BYTES_A = bytesOf(1, 2, 3);
const BYTES_B = bytesOf(4, 5, 6);

/** A's stored draft names an image of its own, B's another, and C's none. */
const STORED_A: StoredBoxDraft = {
  text: "A text",
  content: boxDoc("A text", [hashedImage(HASH_A)]),
  seedId: 1,
};
const STORED_B: StoredBoxDraft = {
  text: "B text",
  content: boxDoc("B text", [hashedImage(HASH_B)]),
  seedId: 1,
};
const STORED_C: StoredBoxDraft = {
  text: "C text",
  content: boxDoc("C text", []),
  seedId: 1,
};

let app: App;

beforeEach(async () => {
  images.calls.length = 0;
  images.outcomes.clear();
  encodes.done = 0;
  images.puts.clear();
  images.putCalls.length = 0;
  images.deletions.count = 0;
  images.deletions.listeners.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  app = await startFresh();
});

afterEach(() => {
  // Every read and put a case left held ends with it.
  for (const call of images.calls) call.read.resolve(undefined);
  for (const put of images.puts.values()) put.resolve();
  app.close();
  vi.useRealTimers();
});

/** What signing in does (`BotDraftsPersistLifecycleBridge`): the account takes the store, which holds none of its drafts until they are read. */
function signIn(started: App, userId: string): void {
  started.drafts
    .getState()
    .retire((kept) => kept ?? { text: "", content: null, seedId: 0 }, {
      userId,
    });
  started.drafts.persist.setOptions({ name: botBoxDraftsKey(userId) });
  void started.drafts.persist.rehydrate();
}

/** The account's boxes stored, and the app started over them: admitted once the stored text is read. */
async function startOver(
  boxes: Readonly<Record<string, StoredBoxDraft>>,
): Promise<App> {
  storeDraftsAsLeft({ [BOT_ID]: boxes });
  const started = await startSignedOutApp();
  app = started;
  started.drafts
    .getState()
    .retire((kept) => kept ?? { text: "", content: null, seedId: 0 }, {
      userId: TEST_USER_ID,
    });
  expect(started.drafts.getState().ownDraftsRead).toBe(false);
  started.drafts.persist.setOptions({ name: botBoxDraftsKey(TEST_USER_ID) });
  void started.drafts.persist.rehydrate();
  await vi.waitFor(() =>
    expect(started.drafts.getState().ownDraftsRead).toBe(true),
  );
  return started;
}

function boxesOf(
  started: App,
): Readonly<Partial<Record<string, StoredBoxDraft>>> {
  const boxes = started.drafts.getState().threadBoxes[BOT_ID];
  return boxes ?? {};
}

function waitingBoxes(started: App): ReadonlyArray<string> {
  return Object.keys(
    started.drafts.getState().boxesReading[BOT_ID] ?? {},
  ).sort();
}

/** The whole stored document's boxes of the bot, as storage holds them now. */
function stored(
  started: App,
): Readonly<Partial<Record<string, StoredBoxDraft>>> {
  return storedDrafts(started)?.[BOT_ID] ?? {};
}

/** The image hashes a stored box names, sorted. */
function hashesIn(value: unknown): string[] {
  return [...JSON.stringify(value ?? null).matchAll(/"hash":"([0-9a-f]+)"/g)]
    .map((match) => match[1])
    .sort();
}

/**
 * The whole stored document: exactly these boxes, naming exactly these image
 * hashes each, with no image's bytes inline anywhere.
 */
function expectStored(
  started: App,
  boxes: Readonly<Record<string, ReadonlyArray<string>>>,
): void {
  const document = stored(started);
  expect(Object.keys(document).sort()).toEqual(Object.keys(boxes).sort());
  for (const [key, hashes] of Object.entries(boxes)) {
    expect(hashesIn(document[key])).toEqual([...hashes].sort());
  }
  expect(JSON.stringify(storedDrafts(started))).not.toContain("b64content");
}

/** Lets queued tasks and promises run, the clock untouched, until `condition` holds. */
async function untilClockless(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !condition(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

/**
 * Waits until `count` images read back from the image store have been
 * encoded: each one's hand-over, or its refusal, is over in the same turn, so
 * what a case then finds is the effect of the image having settled.
 */
async function untilEncoded(count: number): Promise<void> {
  await untilClockless(() => encodes.done === count);
}

/** Types `text` into box `key`, as the person does. */
function type(
  started: App,
  key: string,
  text: string,
  extras: ReadonlyArray<JsonContent>,
): void {
  started.drafts.getState().typeThreadBox(BOT_ID, key, {
    text,
    content: boxDoc(text, extras),
    held: [],
  });
}

describe("the boxes' drafts while images they name are being read", () => {
  it("brings each image box in on its own as soon as its own images settle, the others still waiting by their stored text", async () => {
    const started = await startOver({ a: STORED_A, b: STORED_B, c: STORED_C });
    expect(waitingBoxes(started)).toEqual(["a", "b"]);
    expect(boxesOf(started).c?.text).toBe("C text");

    settleRead(HASH_B, BYTES_B);

    await vi.waitFor(() => expect(waitingBoxes(started)).toEqual(["a"]));
    expect(JSON.stringify(boxesOf(started).b?.content)).toContain(
      base64Of(BYTES_B),
    );
    expect(boxesOf(started).a).toBeUndefined();
  });

  it("reads a hash two boxes name once, and brings both boxes in when it settles", async () => {
    const started = await startOver({
      a: STORED_A,
      b: {
        text: "B names A's image",
        content: boxDoc("B names A's image", [hashedImage(HASH_A)]),
        seedId: 1,
      },
    });

    settleRead(HASH_A, BYTES_A);

    await vi.waitFor(() => expect(waitingBoxes(started)).toEqual([]));
    expect(readCalls().filter((hash) => hash === HASH_A)).toHaveLength(1);
    expect(JSON.stringify(boxesOf(started).a?.content)).toContain(
      base64Of(BYTES_A),
    );
    expect(JSON.stringify(boxesOf(started).b?.content)).toContain(
      base64Of(BYTES_A),
    );
  });

  describe("an edit in an admitted box while an image read is still pending", () => {
    it("writes the edit when the page hides, and leaves the waiting box's stored draft exactly as stored, its image still named by hash", async () => {
      const started = await startOver({ a: STORED_A, c: STORED_C });

      type(started, "c", "C edited", []);
      pageHides();

      expect(stored(started).c?.text).toBe("C edited");
      expect(stored(started).a).toEqual(STORED_A);
      expect(JSON.stringify(stored(started))).not.toContain("b64content");
    });

    it("writes a replacement typed into a box whose draft was discarded, with the old image gone from storage", async () => {
      const started = await startOver({ a: STORED_A, c: STORED_C });

      started.drafts.getState().discardReadingBox(BOT_ID, "a");
      type(started, "a", "A replacement", []);
      pageHides();

      expect(stored(started).a?.text).toBe("A replacement");
      expect(JSON.stringify(stored(started).a)).not.toContain(HASH_A);
      expect(stored(started).c).toEqual(STORED_C);
    });

    it("comes back whole from a fresh read of the same account, with the old image still held, and what is typed in it", async () => {
      const started = await startOver({ a: STORED_A, c: STORED_C });
      started.drafts.getState().discardReadingBox(BOT_ID, "a");
      type(started, "a", "A replacement", []);
      type(started, "c", "C edited", []);
      pageHides();

      started.drafts
        .getState()
        .retire((kept) => kept ?? { text: "", content: null, seedId: 0 }, {
          userId: "user-next",
        });
      signIn(started, TEST_USER_ID);
      await vi.waitFor(() =>
        expect(started.drafts.getState().ownDraftsRead).toBe(true),
      );

      expect(boxesOf(started).a?.text).toBe("A replacement");
      expect(boxesOf(started).c?.text).toBe("C edited");
      expect(waitingBoxes(started)).toEqual([]);
      // The first read's image settling late brings nothing to the newer read.
      settleRead(HASH_A, BYTES_A);
      await untilEncoded(1);
      expect(boxesOf(started).a?.text).toBe("A replacement");
      expect(JSON.stringify(boxesOf(started).a)).not.toContain(
        base64Of(BYTES_A),
      );
      expect(waitingBoxes(started)).toEqual([]);
    });

    it("writes the edit once typing pauses, with the waiting box exactly as stored", async () => {
      const started = await startOver({ a: STORED_A, c: STORED_C });

      type(started, "c", "C edited", []);

      await waitForStore(
        started,
        (document) => document?.[BOT_ID]?.c?.text === "C edited",
      );
      expect(stored(started).a).toEqual(STORED_A);
      expectStored(started, { a: [HASH_A], c: [] });
    });
  });

  describe("a waiting box the person discarded", () => {
    it("is out of the whole stored document with the next write, the other waiting box as stored, and does not come back when its image settles late", async () => {
      const started = await startOver({
        a: STORED_A,
        b: STORED_B,
        c: STORED_C,
      });

      started.drafts.getState().discardReadingBox(BOT_ID, "a");
      type(started, "c", "C edited", []);
      await waitForStore(
        started,
        (document) =>
          document?.[BOT_ID]?.c?.text === "C edited" &&
          document[BOT_ID].a === undefined,
      );
      expect(stored(started).b).toEqual(STORED_B);

      settleRead(HASH_A, BYTES_A);
      settleRead(HASH_B, BYTES_B);
      await untilEncoded(2);
      expect(waitingBoxes(started)).toEqual([]);
      type(started, "c", "C edited again", []);
      await waitForStore(
        started,
        (document) => document?.[BOT_ID]?.c?.text === "C edited again",
      );

      expect(boxesOf(started).a).toBeUndefined();
      expect(stored(started).a).toBeUndefined();
      expect(boxesOf(started).b?.text).toBe("B text");
      expectStored(started, { b: [HASH_B], c: [] });
    });

    it("does not come back when its image settles after the removal is already in storage and another box is written", async () => {
      const started = await startOver({ a: STORED_A, c: STORED_C });
      started.drafts.getState().discardReadingBox(BOT_ID, "a");
      type(started, "c", "C edited", []);
      await waitForStore(
        started,
        (document) =>
          document?.[BOT_ID]?.c?.text === "C edited" &&
          document[BOT_ID].a === undefined,
      );

      settleRead(HASH_A, BYTES_A);
      await untilEncoded(1);
      type(started, "c", "C edited more", []);
      await waitForStore(
        started,
        (document) => document?.[BOT_ID]?.c?.text === "C edited more",
      );

      expect(boxesOf(started).a).toBeUndefined();
      expect(stored(started).a).toBeUndefined();
      expectStored(started, { c: [] });
      expect(stored(started).c?.text).toBe("C edited more");
    });
  });

  it("leaves a retiring account's waiting box stored under its own key, and brings nothing of it to the next account, when its image settles later", async () => {
    const started = await startOver({ a: STORED_A, c: STORED_C });

    started.drafts
      .getState()
      .retire((kept) => kept ?? { text: "", content: null, seedId: 0 }, {
        userId: "user-next",
      });
    settleRead(HASH_A, BYTES_A);
    await untilEncoded(1);

    expect(started.drafts.getState().threadBoxes).toEqual({});
    expect(started.drafts.getState().boxesReading).toEqual({});
    const raw = localStorage.getItem(BOX_DRAFTS_KEY) ?? "";
    expect(raw).toContain(`"hash":"${HASH_A}"`);
    expect(raw).not.toContain("b64content");
    expect(localStorage.getItem(botBoxDraftsKey("user-next"))).toBeNull();
  });

  describe("a write that is storing an image when a waiting box's images settle", () => {
    it("ends with the box as stored, and the written box with its image by hash", async () => {
      const started = await startOver({ a: STORED_A, c: STORED_C });
      const bytes = bytesOf(7, 8, 9);
      const hash = await sha256Of(bytes);
      holdPut(hash);
      type(started, "c", "C with an image", [pasted("c-1", bytes)]);
      await vi.advanceTimersByTimeAsync(300);
      await vi.waitFor(() => expect(images.putCalls).toContain(hash));

      settleRead(HASH_A, BYTES_A);
      await vi.waitFor(() => expect(waitingBoxes(started)).toEqual([]));
      releasePut(hash);
      await vi.advanceTimersByTimeAsync(300);

      await waitForStore(started, (document) =>
        JSON.stringify(document?.[BOT_ID]?.c ?? null).includes(hash),
      );
      expect(stored(started).a).toEqual(STORED_A);
      expect(stored(started).c?.text).toBe("C with an image");
      expect(boxesOf(started).a?.text).toBe("A text");
      expectStored(started, { a: [HASH_A], c: [hash] });
    });

    it("keeps the first image's hash, and the box as stored, when the page hides after the box was brought in and before the second image is stored", async () => {
      const started = await startOver({ a: STORED_A, c: STORED_C });
      const first = bytesOf(7, 8, 9);
      const second = bytesOf(10, 11, 12);
      const firstHash = await sha256Of(first);
      const secondHash = await sha256Of(second);
      holdPut(secondHash);
      type(started, "c", "C with two images", [
        pasted("c-1", first),
        pasted("c-2", second),
      ]);
      await vi.advanceTimersByTimeAsync(300);
      await vi.waitFor(() =>
        expect(images.putCalls).toEqual(
          expect.arrayContaining([firstHash, secondHash]),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      settleRead(HASH_A, BYTES_A);
      await untilClockless(() => waitingBoxes(started).length === 0);
      pageHides();

      // The image whose put has not finished is left out of what is stored.
      expectStored(started, { a: [HASH_A], c: [firstHash] });
      expect(stored(started).a).toEqual(STORED_A);
    });
  });

  describe("an older write that lands after a waiting box was brought in", () => {
    /** C's image typed in and its write started, its put held; the case's hash of it. */
    async function writeStoringCsImage(started: App): Promise<string> {
      const bytes = bytesOf(7, 8, 9);
      const hash = await sha256Of(bytes);
      holdPut(hash);
      type(started, "c", "C with an image", [pasted("c-1", bytes)]);
      await vi.advanceTimersByTimeAsync(300);
      await vi.waitFor(() => expect(images.putCalls).toContain(hash));
      return hash;
    }

    it("keeps the box's gone image in storage until a newer write drops it, and the written box's image by hash throughout", async () => {
      const started = await startOver({ a: STORED_A, c: STORED_C });
      const hash = await writeStoringCsImage(started);

      settleRead(HASH_A, undefined);
      await untilClockless(() => waitingBoxes(started).length === 0);
      releasePut(hash);
      await untilClockless(() =>
        JSON.stringify(stored(started).c ?? null).includes(hash),
      );

      // The older write landed, and it did not know the box that was brought in.
      expect(stored(started).c?.text).toBe("C with an image");
      expectStored(started, { a: [HASH_A], c: [hash] });
      expect(stored(started).a).toEqual(STORED_A);
      await vi.advanceTimersByTimeAsync(300);
      await waitForStore(
        started,
        (document) =>
          !JSON.stringify(document?.[BOT_ID]?.a ?? null).includes(HASH_A),
      );
      expect(stored(started).a?.text).toBe("A text");
      expectStored(started, { a: [], c: [hash] });
    });

    it("keeps a box the person cleared in storage until the newer write that removes it lands, and the written box's image by hash throughout", async () => {
      const started = await startOver({ a: STORED_A, c: STORED_C });
      const hash = await writeStoringCsImage(started);

      settleRead(HASH_A, BYTES_A);
      await untilClockless(() => waitingBoxes(started).length === 0);
      type(started, "a", "A typed", []);
      started.drafts.getState().typeThreadBox(BOT_ID, "a", {
        text: "",
        content: null,
        held: [],
      });
      releasePut(hash);
      await untilClockless(() =>
        JSON.stringify(stored(started).c ?? null).includes(hash),
      );

      // The older write landed, and it did not know the box the person cleared.
      expect(stored(started).c?.text).toBe("C with an image");
      expectStored(started, { a: [HASH_A], c: [hash] });
      expect(stored(started).a).toEqual(STORED_A);
      await vi.advanceTimersByTimeAsync(300);
      await waitForStore(
        started,
        (document) => document?.[BOT_ID]?.a === undefined,
      );
      expectStored(started, { c: [hash] });
      expect(boxesOf(started).a).toBeUndefined();
    });
  });

  it("brings two boxes in that settle in the same tick before any write lands, with both as stored, and writes the edit made before them with both as stored", async () => {
    const started = await startOver({ a: STORED_A, b: STORED_B, c: STORED_C });
    type(started, "c", "C edited", []);

    settleRead(HASH_A, BYTES_A);
    settleRead(HASH_B, BYTES_B);
    await untilClockless(() => waitingBoxes(started).length === 0);

    // Nothing has landed yet: the debounce has not passed.
    expect(stored(started)).toEqual({
      a: STORED_A,
      b: STORED_B,
      c: STORED_C,
    });
    expect(boxesOf(started).a?.text).toBe("A text");
    expect(boxesOf(started).b?.text).toBe("B text");
    await vi.advanceTimersByTimeAsync(300);
    await waitForStore(
      started,
      (document) => document?.[BOT_ID]?.c?.text === "C edited",
    );

    expectStored(started, { a: [HASH_A], b: [HASH_B], c: [] });
    expect(stored(started).a?.text).toBe("A text");
    expect(stored(started).b?.text).toBe("B text");
  });

  it("takes out a box whose only image reads back gone with the write its hand-over schedules, though an older write that did not know it is pending", async () => {
    const goneOnly: StoredBoxDraft = {
      text: "",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [hashedImage(HASH_X)] }],
      },
      seedId: 1,
    };
    const started = await startOver({ x: goneOnly, c: STORED_C });
    type(started, "c", "C edited", []);

    settleRead(HASH_X, undefined);
    await vi.waitFor(() => expect(waitingBoxes(started)).toEqual([]));
    await vi.advanceTimersByTimeAsync(300);
    await waitForStore(
      started,
      (document) =>
        document?.[BOT_ID]?.c?.text === "C edited" &&
        document[BOT_ID].x === undefined,
    );

    expectStored(started, { c: [] });
    expect(stored(started).c?.text).toBe("C edited");
    expect(boxesOf(started).x).toBeUndefined();
  });

  it("stores the image of a box again with its next write, after the image store was deleted while its read was held", async () => {
    const started = await startOver({ a: STORED_A, c: STORED_C });

    deleteImageStore();
    settleRead(HASH_A, BYTES_A);
    await vi.waitFor(() => expect(waitingBoxes(started)).toEqual([]));
    expect(JSON.stringify(boxesOf(started).a?.content)).toContain(
      base64Of(BYTES_A),
    );
    started.drafts.getState().typeThreadBox(BOT_ID, "a", {
      text: "A edited",
      content: boxDoc("A edited", [pasted("a-1", BYTES_A)]),
      held: [],
    });
    await waitForStore(
      started,
      (document) => document?.[BOT_ID]?.a?.text === "A edited",
    );

    expect(images.putCalls).toContain(await sha256Of(BYTES_A));
    expectStored(started, { a: [await sha256Of(BYTES_A)], c: [] });
    expect(stored(started).a?.text).toBe("A edited");
    expect(stored(started).c).toEqual(STORED_C);
  });

  it("keeps an earlier box's gone image work when another box is brought in after it", async () => {
    const started = await startOver({ a: STORED_A, b: STORED_B, c: STORED_C });

    settleRead(HASH_A, undefined);
    await vi.waitFor(() => expect(waitingBoxes(started)).toEqual(["b"]));
    settleRead(HASH_B, BYTES_B);
    await vi.waitFor(() => expect(waitingBoxes(started)).toEqual([]));
    await vi.advanceTimersByTimeAsync(300);
    await waitForStore(
      started,
      (document) =>
        !JSON.stringify(document?.[BOT_ID]?.a ?? null).includes(HASH_A),
    );

    expectStored(started, { a: [], b: [HASH_B], c: [] });
    expect(stored(started).a?.text).toBe("A text");
    expect(stored(started).b?.text).toBe("B text");
    expect(stored(started).c).toEqual(STORED_C);
  });

  it("brings nothing back of a bot that was forgotten while its box waited, and leaves nothing of it in the stored document", async () => {
    const started = await startOver({ a: STORED_A, c: STORED_C });

    started.drafts.getState().forgetBot(BOT_ID);
    settleRead(HASH_A, BYTES_A);
    await untilEncoded(1);
    await vi.advanceTimersByTimeAsync(300);
    await waitForStore(started, (document) => document?.[BOT_ID] === undefined);

    expect(started.drafts.getState().threadBoxes[BOT_ID]).toBeUndefined();
    expect(waitingBoxes(started)).toEqual([]);
    expect(storedDrafts(started)?.[BOT_ID]).toBeUndefined();
  });

  it("leaves the newer read's waiting mark in place when an older read's image settles", async () => {
    const started = await startOver({ a: STORED_A, c: STORED_C });
    expect(readCalls()).toEqual([HASH_A]);

    started.drafts
      .getState()
      .retire((kept) => kept ?? { text: "", content: null, seedId: 0 }, {
        userId: "user-next",
      });
    signIn(started, TEST_USER_ID);
    await untilClockless(() => readCalls().length === 2);
    expect(waitingBoxes(started)).toEqual(["a"]);

    settleReadCall(0, BYTES_A);
    await untilEncoded(1);

    expect(waitingBoxes(started)).toEqual(["a"]);
    expect(boxesOf(started).a).toBeUndefined();
    settleReadCall(1, BYTES_A);
    await untilClockless(() => waitingBoxes(started).length === 0);
    expect(JSON.stringify(boxesOf(started).a?.content)).toContain(
      base64Of(BYTES_A),
    );
    expect(stored(started).a).toEqual(STORED_A);
  });

  it("is admitted before any image settles, with the text-only box in place and the image box waiting by its stored text", async () => {
    const started = await startOver({ a: STORED_A, c: STORED_C });

    expect(boxesOf(started).c?.text).toBe("C text");
    expect(boxesOf(started).a).toBeUndefined();
    expect(started.drafts.getState().boxesReading).toEqual({
      [BOT_ID]: { a: { text: "A text" } },
    });
  });

  it("brings the waiting box in with its text and without the image when the image read fails", async () => {
    const started = await startOver({ a: STORED_A, c: STORED_C });

    failRead(HASH_A, new Error("the image database failed"));

    await vi.waitFor(() => expect(waitingBoxes(started)).toEqual([]));
    expect(boxesOf(started).a?.text).toBe("A text");
    expect(JSON.stringify(boxesOf(started).a?.content)).not.toContain(
      "b64content",
    );
  });

  it("drops the waiting mark through the actions a component gets", async () => {
    const started = await startOver({ a: STORED_A, c: STORED_C });
    const { useBotDraftActions } =
      await import("@/stores/bots/bot-drafts-store");
    const { renderHook } = await import("@testing-library/react");
    const { result } = renderHook(() => useBotDraftActions());

    result.current.discardReadingBox(BOT_ID, "a");

    expect(started.drafts.getState().boxesReading).toEqual({});
  });
});
