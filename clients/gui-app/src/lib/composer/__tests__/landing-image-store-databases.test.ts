/**
 * The landing image store's two databases over a REAL IndexedDB (fake-indexeddb),
 * two windows as two module graphs over one factory, in the partition
 * `default`. Another window deletes a database, as the wipe does; what is
 * asserted is that the deletion goes through at once, and what this window then
 * knows and can still do. The in-memory stand-in of `landing-image-store.test.ts`
 * has no connections, so it cannot show any of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseStore } from "idb-keyval";
import {
  deleteDatabaseOutcome,
  installFreshIndexedDb,
  rawGet,
  rawPut,
} from "@/lib/composer/__tests__/fake-idb";

const IMAGES_DB = "traycer-gui-app:default:landing-images";
const SIZES_DB = "traycer-gui-app:default:landing-image-sizes";

const holds = vi.hoisted(() => ({
  /** While set, a read of the image database answers only once this settles. */
  afterRead: null as Promise<void> | null,
  readDone: (): void => undefined,
}));

// A read is held after the database answered it, which is the point between a
// put's read and its write.
vi.mock("idb-keyval", async (importOriginal) => {
  const real = await importOriginal<typeof import("idb-keyval")>();
  return {
    ...real,
    get: async <T>(
      key: IDBValidKey,
      store: UseStore | undefined,
    ): Promise<T | undefined> => {
      const value = await real.get<T>(key, store);
      const gate = holds.afterRead;
      if (gate !== null) {
        holds.readDone();
        await gate;
      }
      return value;
    },
  };
});

/** The bytes as plain numbers: fake-indexeddb clones them in another realm, where `toEqual` on a typed array fails. */
function numbers(bytes: ArrayLike<number> | undefined): number[] | undefined {
  return bytes === undefined ? undefined : Array.from(bytes);
}

/** A window: the store module loaded afresh, with its own connections and memory. */
async function loadWindow(): Promise<
  typeof import("@/lib/composer/landing-image-store")
> {
  vi.resetModules();
  return import("@/lib/composer/landing-image-store");
}

beforeEach(() => {
  installFreshIndexedDb();
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  holds.afterRead = null;
  holds.readDone = (): void => undefined;
});

describe("the landing image databases when another window deletes them", () => {
  it("lets the deletion through, answers a hash the window never put as absent, stores a new image, and has a reloaded window read it back", async () => {
    const seeded = new Uint8Array([1, 2, 3]);
    const seedWindow = await loadWindow();
    const seededHash = await seedWindow.sha256Hex(seeded);
    await rawPut(IMAGES_DB, "bytes", seededHash, seeded);
    const windowB = await loadWindow();
    const putHash = await windowB.putImage(new Uint8Array([4, 5, 6]));
    expect(numbers(await windowB.getImageBytes(seededHash))).toEqual([1, 2, 3]);

    // Before anything that could wait on the deletion.
    expect(await deleteDatabaseOutcome(IMAGES_DB)).toBe("deleted");

    expect(await windowB.getImageBytes(seededHash)).toBeUndefined();
    expect(windowB.hasLandingImageBytes(putHash)).toBe(true);
    const fresh = new Uint8Array([7, 8, 9]);
    const freshHash = await windowB.putImage(fresh);
    const reloaded = await loadWindow();
    expect(numbers(await reloaded.getImageBytes(freshHash))).toEqual([7, 8, 9]);
    expect(await reloaded.getImageBytes(seededHash)).toBeUndefined();
  });

  it("forgets a hash it only knew from the deleted database, with its size, and keeps the hash it put this session, with its size", async () => {
    const seeded = new Uint8Array([1, 2, 3]);
    const seedWindow = await loadWindow();
    const seededHash = await seedWindow.sha256Hex(seeded);
    await rawPut(IMAGES_DB, "bytes", seededHash, seeded);
    const windowB = await loadWindow();
    const putHash = await windowB.putImage(new Uint8Array([4, 5, 6, 7]));
    expect(numbers(await windowB.getImageBytes(seededHash))).toEqual([1, 2, 3]);
    expect(windowB.hasLandingImageBytes(seededHash)).toBe(true);
    expect(windowB.measuredLandingImageSize(seededHash)).toBe(3);

    expect(await deleteDatabaseOutcome(IMAGES_DB)).toBe("deleted");

    expect(windowB.hasLandingImageBytes(seededHash)).toBe(false);
    expect(windowB.measuredLandingImageSize(seededHash)).toBeNull();
    expect(windowB.hasLandingImageBytes(putHash)).toBe(true);
    expect(windowB.measuredLandingImageSize(putHash)).toBe(4);
  });

  it("rejects a put the deletion catches between its read and its write, and rolls the put's seed back", async () => {
    const windowB = await loadWindow();
    const bytes = new Uint8Array([4, 5, 6]);
    const hash = await windowB.sha256Hex(bytes);
    let release = (): void => undefined;
    holds.afterRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readDone = new Promise<void>((resolve) => {
      holds.readDone = resolve;
    });
    const settled = windowB.putImage(bytes).then(
      (stored) => stored,
      (error: unknown) => error,
    );
    await readDone;

    expect(await deleteDatabaseOutcome(IMAGES_DB)).toBe("deleted");
    release();

    expect(await settled).not.toBe(hash);
    expect(windowB.hasLandingImageBytes(hash)).toBe(false);
    expect(windowB.sessionObjectUrl(hash)).toBeNull();
  });

  it("records a new image's size in the new sizes database once the sizes database was deleted", async () => {
    const windowB = await loadWindow();
    const firstHash = await windowB.putImage(new Uint8Array([1, 2, 3]));
    await vi.waitFor(async () =>
      expect(await rawGet(SIZES_DB, "sizes", firstHash)).toBe(3),
    );

    expect(await deleteDatabaseOutcome(SIZES_DB)).toBe("deleted");

    const hash = await windowB.putImage(new Uint8Array([7, 8, 9, 10]));
    await vi.waitFor(async () =>
      expect(await rawGet(SIZES_DB, "sizes", hash)).toBe(4),
    );
  });
});
