/**
 * The landing image store's two databases over a REAL IndexedDB (fake-indexeddb),
 * two windows as two module graphs over one factory, in the partition
 * `default`. Another window deletes a database, as the wipe does; what is
 * asserted is that the deletion goes through at once, and what this window then
 * knows and can still do. The in-memory stand-in of `landing-image-store.test.ts`
 * has no connections, so it cannot show any of it.
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
import type { UseStore } from "idb-keyval";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import {
  deleteAndAwaitInvalidation,
  deleteDatabaseOutcome,
  deleteDatabaseWhenClosed,
  installFreshIndexedDb,
  openHoldingConnection,
  rawDelete,
  rawGet,
  rawPut,
  type HeldTransaction,
} from "@/lib/composer/__tests__/fake-idb";

const IMAGES_DB = "traycer-gui-app:default:landing-images";
const SIZES_DB = "traycer-gui-app:default:landing-image-sizes";

const holds = vi.hoisted(() => ({
  /** While set, a read of the image database answers only once this settles. */
  afterRead: null as Promise<void> | null,
  readDone: (): void => undefined,
  /** While set, a write to a database is refused. */
  refuseWrites: false,
  /** How many reads of the image database were started. */
  reads: 0,
}));

// A read is held after the database answered it, which is the point between a
// put's read and its write; a write can be refused, as a full disk refuses it.
vi.mock("idb-keyval", async (importOriginal) => {
  const real = await importOriginal<typeof import("idb-keyval")>();
  return {
    ...real,
    set: async (
      key: IDBValidKey,
      value: unknown,
      store: UseStore | undefined,
    ): Promise<void> => {
      if (holds.refuseWrites) throw new Error("the write was refused");
      await real.set(key, value, store);
    },
    get: async <T>(
      key: IDBValidKey,
      store: UseStore | undefined,
    ): Promise<T | undefined> => {
      holds.reads += 1;
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
  holds.refuseWrites = false;
  holds.reads = 0;
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

  it("writes a put the deletion catches between its read and its write again into the new database, which the closed connection refused", async () => {
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
    const settled = windowB.putImage(bytes);
    await readDone;

    expect(await deleteDatabaseOutcome(IMAGES_DB)).toBe("deleted");
    release();

    expect(await settled).toBe(hash);
    windowB.releaseSession(hash);
    expect(windowB.hasLandingImageBytes(hash)).toBe(true);
    expect(numbers(await windowB.getImageBytes(hash))).toEqual([4, 5, 6]);
    expect(await storedBytes(hash)).toEqual([4, 5, 6]);
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

type Window = typeof import("@/lib/composer/landing-image-store");

const SEEDED = new Uint8Array([1, 2, 3]);

/** The bytes `hash` has in the image database, as plain numbers; `undefined` when it holds none. */
async function storedBytes(hash: string): Promise<number[] | undefined> {
  const value = await rawGet(IMAGES_DB, "bytes", hash);
  if (!ArrayBuffer.isView(value)) return undefined;
  return Array.from(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  );
}

/**
 * Holds a readwrite transaction on the image database that the test releases
 * when it ends, so a failed assertion cannot leave it spinning. Transactions
 * that other connections start afterwards queue behind it, which is how an
 * operation of the window is caught half-way by a deletion: closing the window's
 * connection lets the transactions already queued finish.
 */
async function holdImageDatabase(key: string): Promise<HeldTransaction> {
  const connection = await openHoldingConnection(IMAGES_DB, "bytes");
  const held = connection.hold(key);
  onTestFinished(() => held.release());
  await held.started;
  return held;
}

/** A window that has read the empty database, then the database holds `bytes`: the hash the window has never seen. */
async function windowOverDiskOnlyImage(
  bytes: ImageBytes,
): Promise<{ readonly window: Window; readonly hash: string }> {
  const window = await loadWindow();
  await window.awaitLandingImageSizes();
  const hash = await window.sha256Hex(bytes);
  await rawPut(IMAGES_DB, "bytes", hash, bytes);
  return { window, hash };
}

describe("an operation of the window that a deletion of the image database overtakes", () => {
  it("returns the bytes a read found, but publishes neither presence nor a size for them", async () => {
    const seedWindow = await loadWindow();
    const hash = await seedWindow.sha256Hex(SEEDED);
    await rawPut(IMAGES_DB, "bytes", hash, SEEDED);
    const windowB = await loadWindow();
    await windowB.awaitLandingImageSizes();
    expect(windowB.hasLandingImageBytes(hash)).toBe(true);
    const held = await holdImageDatabase(hash);
    const read = windowB.getImageBytes(hash);

    const deletion = deleteAndAwaitInvalidation(
      IMAGES_DB,
      windowB.onLandingImagesDeleted,
    );
    await deletion.invalidated;
    expect(windowB.hasLandingImageBytes(hash)).toBe(false);
    held.release();

    expect(numbers(await read)).toEqual([1, 2, 3]);
    await deletion.removed;
    expect(windowB.hasLandingImageBytes(hash)).toBe(false);
    expect(windowB.measuredLandingImageSize(hash)).toBeNull();
    expect(await windowB.getImageBytes(hash)).toBeUndefined();
  });

  it("returns the keys an enumeration found, but publishes no presence for them", async () => {
    const seedWindow = await loadWindow();
    const hash = await seedWindow.sha256Hex(SEEDED);
    await rawPut(IMAGES_DB, "bytes", hash, SEEDED);
    const windowB = await loadWindow();
    await windowB.awaitLandingImageSizes();
    const held = await holdImageDatabase(hash);
    const keys = windowB.imageHashKeys();

    const deletion = deleteAndAwaitInvalidation(
      IMAGES_DB,
      windowB.onLandingImagesDeleted,
    );
    await deletion.invalidated;
    held.release();

    expect(await keys).toEqual([hash]);
    await deletion.removed;
    expect(windowB.hasLandingImageBytes(hash)).toBe(false);
  });

  it("does not hydrate the sizes from a partition that was deleted during the start's enumeration, and hydrates them on the next attempt without the deleted hash", async () => {
    const seedWindow = await loadWindow();
    const hash = await seedWindow.sha256Hex(SEEDED);
    await rawPut(IMAGES_DB, "bytes", hash, SEEDED);
    await rawPut(SIZES_DB, "sizes", hash, 3);
    const held = await holdImageDatabase(hash);
    // The module's own start enumerates the database as it is imported, so
    // that read queues behind the held transaction.
    const windowB = await loadWindow();

    const deletion = deleteAndAwaitInvalidation(
      IMAGES_DB,
      windowB.onLandingImagesDeleted,
    );
    await deletion.invalidated;
    held.release();
    await deletion.removed;
    await windowB.awaitLandingImageSizes();

    expect(windowB.landingImageSizesHydrated()).toBe(false);
    expect(windowB.measuredLandingImageSize(hash)).toBeNull();
    expect(windowB.hasLandingImageBytes(hash)).toBe(false);
    await windowB.ensureMeasuredImageSizes();
    expect(windowB.landingImageSizesHydrated()).toBe(true);
    expect(windowB.measuredLandingImageSize(hash)).toBeNull();
    expect(windowB.hasLandingImageBytes(hash)).toBe(false);
  });

  describe("a put that finds its bytes already stored", () => {
    /** The put is running its read, queued behind the held transaction, when the deletion starts. */
    async function putCaughtByDeletion(
      afterInvalidation: (window: Window, hash: string) => void,
    ): Promise<{ readonly window: Window; readonly hash: string }> {
      const { window, hash } = await windowOverDiskOnlyImage(SEEDED);
      const held = await holdImageDatabase(hash);
      const put = window.putImage(SEEDED);
      // The put has seeded the session, which it does just before it queues its read.
      await vi.waitFor(() =>
        expect(window.sessionImageBytes(hash)).not.toBeNull(),
      );

      const deletion = deleteAndAwaitInvalidation(
        IMAGES_DB,
        window.onLandingImagesDeleted,
      );
      await deletion.invalidated;
      afterInvalidation(window, hash);
      held.release();

      expect(await put).toBe(hash);
      await deletion.removed;
      return { window, hash };
    }

    it("writes the bytes again into the new database, and claims them with their size, when the session let them go after the deletion", async () => {
      const { window, hash } = await putCaughtByDeletion((w, h) =>
        w.releaseSession(h),
      );

      // The read found the deleted database's copy, so the put's first attempt
      // wrote nothing: the claim is only true of the bytes the second one wrote.
      expect(await storedBytes(hash)).toEqual([1, 2, 3]);
      expect(window.hasLandingImageBytes(hash)).toBe(true);
      expect(window.measuredLandingImageSize(hash)).toBe(3);
      expect(numbers(await window.getImageBytes(hash))).toEqual([1, 2, 3]);
    });

    it("keeps the claim true of the bytes once the session lets them go, with the bytes written again into the new database", async () => {
      const { window, hash } = await putCaughtByDeletion(() => undefined);
      expect(window.measuredLandingImageSize(hash)).toBe(3);

      window.releaseSession(hash);

      expect(await storedBytes(hash)).toEqual([1, 2, 3]);
      expect(window.hasLandingImageBytes(hash)).toBe(true);
      expect(window.measuredLandingImageSize(hash)).toBe(3);
      expect(numbers(await window.getImageBytes(hash))).toEqual([1, 2, 3]);
      expect(await window.imageHashKeys()).toEqual([hash]);
    });

    it("claims no more once the session lets go of bytes the deletion took, when nothing wrote them again", async () => {
      const window = await loadWindow();
      await window.awaitLandingImageSizes();
      const hash = await window.putImage(SEEDED);
      expect(await storedBytes(hash)).toEqual([1, 2, 3]);

      const deletion = deleteAndAwaitInvalidation(
        IMAGES_DB,
        window.onLandingImagesDeleted,
      );
      await deletion.invalidated;
      await deletion.removed;
      // The session still holds them, so they are still the window's to claim.
      expect(window.hasLandingImageBytes(hash)).toBe(true);
      window.releaseSession(hash);

      expect(window.hasLandingImageBytes(hash)).toBe(false);
      expect(window.measuredLandingImageSize(hash)).toBeNull();
      expect(await window.getImageBytes(hash)).toBeUndefined();
    });

    it("writes the bytes again each time a deletion overtakes the put, and settles once, after the last", async () => {
      const window = await loadWindow();
      await window.awaitLandingImageSizes();
      const hash = await window.sha256Hex(SEEDED);
      const firstDeletions = window.landingImageDeletions();
      const held1 = await holdImageDatabase(hash);
      const settledAt: number[] = [];
      const reads = holds.reads;
      const put = window.putImage(SEEDED).then((stored) => {
        settledAt.push(window.landingImageDeletions());
        return stored;
      });
      await vi.waitFor(() =>
        expect(window.sessionImageBytes(hash)).not.toBeNull(),
      );

      const deletion1 = deleteAndAwaitInvalidation(
        IMAGES_DB,
        window.onLandingImagesDeleted,
      );
      // Requested behind the pending deletion, so it opens before the put's
      // second attempt does, and that attempt's read queues behind it.
      const opening2 = openHoldingConnection(IMAGES_DB, "bytes");
      await deletion1.invalidated;
      held1.release();
      const held2 = (await opening2).hold(hash);
      onTestFinished(() => held2.release());
      await held2.started;
      await vi.waitFor(() => expect(holds.reads).toBe(reads + 2));

      const deletion2 = deleteAndAwaitInvalidation(
        IMAGES_DB,
        window.onLandingImagesDeleted,
      );
      await deletion2.invalidated;
      expect(window.landingImageDeletions()).toBe(firstDeletions + 2);
      expect(settledAt).toEqual([]);
      held2.release();

      expect(await put).toBe(hash);
      await deletion2.removed;
      expect(settledAt).toEqual([firstDeletions + 2]);
      expect(window.landingImageDeletions()).toBe(firstDeletions + 2);
      expect(await storedBytes(hash)).toEqual([1, 2, 3]);
      window.releaseSession(hash);
      expect(window.hasLandingImageBytes(hash)).toBe(true);
      expect(window.measuredLandingImageSize(hash)).toBe(3);
      expect(numbers(await window.getImageBytes(hash))).toEqual([1, 2, 3]);
    });
  });

  it("records a put image's size again in the new sizes database after the wipe deleted both databases, though the window had measured it", async () => {
    const window = await loadWindow();
    await window.awaitLandingImageSizes();
    const hash = await window.putImage(SEEDED);
    await vi.waitFor(async () =>
      expect(await rawGet(SIZES_DB, "sizes", hash)).toBe(3),
    );
    window.releaseSession(hash);

    // As the wipe does: the image database and the sizes database together.
    const deletion = deleteAndAwaitInvalidation(
      IMAGES_DB,
      window.onLandingImagesDeleted,
    );
    await Promise.all([deletion.removed, deleteDatabaseWhenClosed(SIZES_DB)]);
    await window.putImage(SEEDED);

    await vi.waitFor(async () =>
      expect(await rawGet(SIZES_DB, "sizes", hash)).toBe(3),
    );
  });

  it("reports a reclaim absent, and claims neither presence nor a size, once another window's sweep removed the bytes it had seen", async () => {
    const window = await loadWindow();
    await window.awaitLandingImageSizes();
    const hash = await window.putImage(SEEDED);
    window.releaseSession(hash);
    expect(numbers(await window.getImageBytes(hash))).toEqual([1, 2, 3]);
    expect(window.measuredLandingImageSize(hash)).toBe(3);
    // Between this window's listing and its reclaim, as on the shared partition.
    await rawDelete(IMAGES_DB, "bytes", hash);

    expect(await window.reclaimImageBytes(hash, () => false)).toBe("absent");

    expect(window.hasLandingImageBytes(hash)).toBe(false);
    expect(window.measuredLandingImageSize(hash)).toBeNull();
  });

  describe("a reclaim and a flush of the bytes it holds", () => {
    /** An `isRooted` that answers `false` until the reclaim's delete has committed, which is its third look, and `true` after: the root appears as the delete lands. `onCommitted` runs at that look. */
    function rootAppearsOnceDeleted(onCommitted: () => void): () => boolean {
      let looks = 0;
      return () => {
        looks += 1;
        if (looks < 3) return false;
        onCommitted();
        return true;
      };
    }

    it("keeps the bytes in custody when a deletion overtakes the write that puts them back, and writes them into the new database on the next flush", async () => {
      const { window, hash } = await windowOverDiskOnlyImage(SEEDED);
      const connection = await openHoldingConnection(IMAGES_DB, "bytes");
      let committed = (held: HeldTransaction): void => void held;
      const heldOnCommit = new Promise<HeldTransaction>((resolve) => {
        committed = resolve;
      });
      const reclaim = window.reclaimImageBytes(
        hash,
        rootAppearsOnceDeleted(() => {
          // Started inside the look, ahead of the write the reclaim makes next.
          const held = connection.hold(hash);
          onTestFinished(() => held.release());
          committed(held);
        }),
      );
      const held = await heldOnCommit;
      await held.started;

      const deletion = deleteAndAwaitInvalidation(
        IMAGES_DB,
        window.onLandingImagesDeleted,
      );
      await deletion.invalidated;
      held.release();
      expect(await reclaim).toBe("kept");
      await deletion.removed;

      expect(window.reclaimCustodyHashesForTests()).toEqual([hash]);
      expect(numbers(await window.getImageBytes(hash))).toEqual([1, 2, 3]);
      expect(await window.flushReclaimCustody()).toBe(0);
      expect(window.reclaimCustodyHashesForTests()).toEqual([]);
      expect(await storedBytes(hash)).toEqual([1, 2, 3]);
    });

    it("keeps the bytes in custody when a deletion overtakes a flush that was writing them, and the next flush writes them", async () => {
      const { window, hash } = await windowOverDiskOnlyImage(SEEDED);
      // A reclaim whose restore is refused leaves the bytes in custody.
      holds.refuseWrites = true;
      let looks = 0;
      await expect(
        window.reclaimImageBytes(hash, () => {
          looks += 1;
          return looks >= 3;
        }),
      ).rejects.toThrow("the write was refused");
      holds.refuseWrites = false;
      expect(window.reclaimCustodyHashesForTests()).toEqual([hash]);
      const held = await holdImageDatabase(hash);
      const flushed = window.flushReclaimCustody();

      const deletion = deleteAndAwaitInvalidation(
        IMAGES_DB,
        window.onLandingImagesDeleted,
      );
      await deletion.invalidated;
      held.release();

      expect(await flushed).toBe(1);
      await deletion.removed;
      expect(window.reclaimCustodyHashesForTests()).toEqual([hash]);
      expect(await window.flushReclaimCustody()).toBe(0);
      expect(window.reclaimCustodyHashesForTests()).toEqual([]);
      expect(await storedBytes(hash)).toEqual([1, 2, 3]);
    });
  });
});
