import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStore, set as idbSet } from "idb-keyval";

import {
  deleteImage,
  getImageBytes,
  imageHashKeys,
  imageStore,
  landingImagePartition,
  putImage,
  releaseSession,
  sessionHashKeys,
  sessionImageBytes,
  sessionObjectUrl,
} from "@/lib/composer/landing-image-store";

// In-memory stand-in for idb-keyval. The store argument is ignored — the module
// only ever keys by string hash, and each test drains the map via the module's
// own API between cases. `createStore` is a real spy so the DB-name shape
// (`traycer-gui-app:<partition>:landing-images`) can be asserted.
vi.mock("idb-keyval", () => {
  const data = new Map<string, unknown>();
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(data.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(data.keys()))),
  };
});

let urlCounter = 0;
const createObjectURL = vi.fn(
  (_obj: Blob | MediaSource) => `blob:mock/${++urlCounter}`,
);
const revokeObjectURL = vi.fn((_url: string) => undefined);

function bytesOf(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

describe("landing-image-store", () => {
  beforeEach(async () => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    // Drain the in-memory IndexedDB stand-in through the public API so each case
    // starts empty, then zero the spy call counts.
    for (const hash of await imageHashKeys()) {
      await deleteImage(hash);
      releaseSession(hash);
    }
    vi.clearAllMocks();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "runnerHost");
  });

  it("hashes by content: identical bytes write to IndexedDB exactly once", async () => {
    const bytes = bytesOf([1, 2, 3, 4]);

    const first = await putImage(bytesOf([1, 2, 3, 4]));
    const second = await putImage(bytesOf([1, 2, 3, 4]));

    expect(first).toBe(second);
    // SHA-256 hex is 64 chars.
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(idbSet).toHaveBeenCalledTimes(1);
    // Different content → different hash → a second write.
    await putImage(bytesOf([9, 9, 9]));
    expect(idbSet).toHaveBeenCalledTimes(2);
    expect(bytes).toEqual(bytesOf([1, 2, 3, 4]));
  });

  it("round-trips put → get → keys → delete", async () => {
    const hash = await putImage(bytesOf([10, 20, 30]));

    expect(await getImageBytes(hash)).toEqual(bytesOf([10, 20, 30]));
    expect(await imageHashKeys()).toContain(hash);

    await deleteImage(hash);
    releaseSession(hash);

    expect(await imageHashKeys()).not.toContain(hash);
    expect(await getImageBytes(hash)).toBeUndefined();
  });

  it("creates a session object-URL on put and revokes it on release", async () => {
    const hash = await putImage(bytesOf([7, 7, 7]));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    const url = sessionObjectUrl(hash);
    expect(url).toBe(createObjectURL.mock.results[0]?.value);

    releaseSession(hash);

    expect(revokeObjectURL).toHaveBeenCalledWith(url);
    expect(sessionObjectUrl(hash)).toBeNull();
  });

  it("does not create a second object-URL for a repeat put of the same bytes", async () => {
    await putImage(bytesOf([5, 5]));
    await putImage(bytesOf([5, 5]));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("reads session bytes synchronously and drops them on release", async () => {
    expect(sessionImageBytes("absent")).toBeNull();

    const hash = await putImage(bytesOf([3, 1, 4, 1, 5]));

    expect(sessionImageBytes(hash)).toEqual(bytesOf([3, 1, 4, 1, 5]));

    releaseSession(hash);

    expect(sessionImageBytes(hash)).toBeNull();
  });

  it("exposes session hashes as GC roots, reflecting puts and releases", async () => {
    expect(sessionHashKeys()).toEqual([]);

    const a = await putImage(bytesOf([1, 1]));
    const b = await putImage(bytesOf([2, 2]));

    expect(sessionHashKeys().sort()).toEqual([a, b].sort());

    releaseSession(a);

    expect(sessionHashKeys()).toEqual([b]);
  });

  it("resolves the partition and DB name: windowId on desktop, default in browser", () => {
    // Browser / no desktop global → "default".
    expect(landingImagePartition()).toBe("default");

    // Desktop: imperative read of runnerHost.windows.windowId. Switching the
    // partition re-opens the store, so createStore sees the desktop DB name.
    Reflect.set(globalThis, "runnerHost", {
      windows: { windowId: "win-123" },
    });
    expect(landingImagePartition()).toBe("win-123");
    imageStore();
    expect(createStore).toHaveBeenLastCalledWith(
      "traycer-gui-app:win-123:landing-images",
      "bytes",
    );

    // Empty / malformed windowId falls back to "default"; switching back re-opens
    // the store under the browser DB name.
    Reflect.set(globalThis, "runnerHost", { windows: { windowId: "" } });
    expect(landingImagePartition()).toBe("default");
    imageStore();
    expect(createStore).toHaveBeenLastCalledWith(
      "traycer-gui-app:default:landing-images",
      "bytes",
    );
  });
});
