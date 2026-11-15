/**
 * The images the bot boxes' stored drafts name are roots of the image store's
 * sweeps (Tracy Bots T186), whichever account's drafts they are: through the
 * REAL sweep (`reconcile`), the real image store over a fake IndexedDB, and
 * the drafts storage's own root registration. Whatever storage does when it
 * cannot be read, a sweep must never delete an image a stored draft names; a
 * sweep may fail or withhold its deletes, and these cases assert neither.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFreshIndexedDb,
  rawGet,
  rawPut,
} from "@/lib/composer/__tests__/fake-idb";
import { botBoxDraftsKey } from "@/lib/persist";
import {
  BOT_ID,
  boxDoc,
  failEveryReadOf,
  failStorageKeys,
  hashedImage,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";

const IMAGES_DB = "traycer-gui-app:default:landing-images";
const FIRST_ACCOUNT = "user-first-account";
const SECOND_ACCOUNT = "user-second-account";
const THIRD_ACCOUNT = "user-third-account";
/** The images the stored drafts name, and the ones nothing roots. */
const FIRST_IMAGE = "ee".repeat(32);
const SECOND_IMAGE = "ab".repeat(32);
const LATER_IMAGE = "ba".repeat(32);
const THIRD_IMAGE = "fa".repeat(32);
const UNROOTED = "dd".repeat(32);
const UNROOTED_LATER = "cc".repeat(32);
const BYTES = new Uint8Array([1, 2, 3]);

async function hasBytes(hash: string): Promise<boolean> {
  return (await rawGet(IMAGES_DB, "bytes", hash)) !== undefined;
}

/** A stored value of an account's drafts: one box per entry, each naming its image by hash. */
function storedDrafts(
  boxes: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const threadBoxes: Record<string, Record<string, unknown>> = {
    [BOT_ID]: {},
  };
  for (const [key, hash] of Object.entries(boxes)) {
    threadBoxes[BOT_ID][key] = {
      text: "kept",
      content: boxDoc("kept", [hashedImage(hash)]),
      seedId: 1,
    };
  }
  return { state: { threadBoxes }, version: 1 };
}

function storeAccount(account: string, boxes: Record<string, string>): void {
  localStorage.setItem(
    botBoxDraftsKey(account),
    JSON.stringify(storedDrafts(boxes)),
  );
}

type Gc = typeof import("@/lib/composer/landing-image-gc");

/**
 * The image database holds the bytes of `hashes` and of an unrooted image;
 * `drafts` are stored (before anything sweeps). A sweep has run with storage
 * working: the unrooted image went, every named image stayed.
 */
async function sweptOnceWithStorageWorking(
  drafts: ReadonlyArray<{
    readonly account: string;
    readonly boxes: Record<string, string>;
  }>,
): Promise<Gc> {
  installFreshIndexedDb();
  vi.resetModules();
  const gc = await import("@/lib/composer/landing-image-gc");
  // The drafts storage registers its roots as it is imported.
  await import("@/lib/bots/bot-box-draft-storage");
  // The drafts are stored first: any sweep, the startup one a first call
  // starts included, finds their images rooted.
  for (const { account, boxes } of drafts) storeAccount(account, boxes);
  gc.markLandingDraftsReady();
  for (const { boxes } of drafts) {
    for (const hash of Object.values(boxes)) {
      await rawPut(IMAGES_DB, "bytes", hash, BYTES);
    }
  }
  await rawPut(IMAGES_DB, "bytes", UNROOTED, BYTES);
  // The sweep reads the roots: the unrooted image goes, the named ones stay.
  await gc.reconcile();
  expect(await hasBytes(UNROOTED)).toBe(false);
  for (const { boxes } of drafts) {
    for (const hash of Object.values(boxes)) {
      expect(await hasBytes(hash)).toBe(true);
    }
  }
  return gc;
}

/** A sweep with storage failing: it may fail or withhold its deletes, but must keep every image in `kept`. */
async function sweepKeeps(gc: Gc, kept: ReadonlyArray<string>): Promise<void> {
  await gc.reconcile().catch(() => undefined);
  for (const hash of kept) expect(await hasBytes(hash)).toBe(true);
}

/** Storage works again: an unrooted image is deleted, the named ones kept. */
async function sweepsAgainWithStorageWorking(
  gc: Gc,
  kept: ReadonlyArray<string>,
): Promise<void> {
  await rawPut(IMAGES_DB, "bytes", UNROOTED_LATER, BYTES);
  await gc.reconcile();
  expect(await hasBytes(UNROOTED_LATER)).toBe(false);
  for (const hash of kept) expect(await hasBytes(hash)).toBe(true);
}

beforeEach(() => {
  localStorage.clear();
});

describe("a sweep of the image store while the bot boxes' stored drafts cannot be read", () => {
  it("keeps the image a stored draft names when storage cannot list its keys, and sweeps again once it can", async () => {
    const gc = await sweptOnceWithStorageWorking([
      { account: FIRST_ACCOUNT, boxes: { channel: FIRST_IMAGE } },
    ]);
    const restore = failStorageKeys();

    await sweepKeeps(gc, [FIRST_IMAGE]);

    restore();
    await sweepsAgainWithStorageWorking(gc, [FIRST_IMAGE]);
  });

  it("keeps the image a stored draft names when the read of that draft's key fails, and sweeps again once it can", async () => {
    const gc = await sweptOnceWithStorageWorking([
      { account: FIRST_ACCOUNT, boxes: { channel: FIRST_IMAGE } },
    ]);
    const restore = failEveryReadOf(botBoxDraftsKey(FIRST_ACCOUNT));

    await sweepKeeps(gc, [FIRST_IMAGE]);

    restore();
    await sweepsAgainWithStorageWorking(gc, [FIRST_IMAGE]);
  });

  it("keeps the images both accounts' drafts name, not a partial union, when only the second account's key cannot be read", async () => {
    const gc = await sweptOnceWithStorageWorking([
      { account: FIRST_ACCOUNT, boxes: { channel: FIRST_IMAGE } },
      { account: SECOND_ACCOUNT, boxes: { channel: SECOND_IMAGE } },
    ]);
    const restore = failEveryReadOf(botBoxDraftsKey(SECOND_ACCOUNT));

    await sweepKeeps(gc, [FIRST_IMAGE, SECOND_IMAGE]);

    restore();
    await sweepsAgainWithStorageWorking(gc, [FIRST_IMAGE, SECOND_IMAGE]);
  });

  it("keeps an image another window's draft began to name after the last sweep that could read the drafts, under a key it added and under one it already had, when the keys cannot be listed", async () => {
    const gc = await sweptOnceWithStorageWorking([
      { account: FIRST_ACCOUNT, boxes: { channel: FIRST_IMAGE } },
    ]);
    // Another window: a new account's draft, and a new box of an account that was read.
    await rawPut(IMAGES_DB, "bytes", THIRD_IMAGE, BYTES);
    await rawPut(IMAGES_DB, "bytes", LATER_IMAGE, BYTES);
    storeAccount(THIRD_ACCOUNT, { channel: THIRD_IMAGE });
    storeAccount(FIRST_ACCOUNT, { channel: FIRST_IMAGE, extra: LATER_IMAGE });
    const restore = failStorageKeys();

    await sweepKeeps(gc, [FIRST_IMAGE, THIRD_IMAGE, LATER_IMAGE]);

    restore();
    await sweepsAgainWithStorageWorking(gc, [
      FIRST_IMAGE,
      THIRD_IMAGE,
      LATER_IMAGE,
    ]);
  });

  it("keeps an image another window's draft began to name under a key the sweep had read, when the read of that key fails", async () => {
    const gc = await sweptOnceWithStorageWorking([
      { account: FIRST_ACCOUNT, boxes: { channel: FIRST_IMAGE } },
    ]);
    await rawPut(IMAGES_DB, "bytes", LATER_IMAGE, BYTES);
    storeAccount(FIRST_ACCOUNT, { channel: FIRST_IMAGE, extra: LATER_IMAGE });
    const restore = failEveryReadOf(botBoxDraftsKey(FIRST_ACCOUNT));

    await sweepKeeps(gc, [FIRST_IMAGE, LATER_IMAGE]);

    restore();
    await sweepsAgainWithStorageWorking(gc, [FIRST_IMAGE, LATER_IMAGE]);
  });

  it("still sweeps, and deletes an unrooted image, when an account's stored value is not JSON: a value nothing can parse names no image", async () => {
    const gc = await sweptOnceWithStorageWorking([
      { account: FIRST_ACCOUNT, boxes: { channel: FIRST_IMAGE } },
    ]);
    localStorage.setItem(botBoxDraftsKey(SECOND_ACCOUNT), "{not json");

    await sweepsAgainWithStorageWorking(gc, [FIRST_IMAGE]);
  });
});
