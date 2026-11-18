import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, get, set, type UseStore } from "idb-keyval";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { epicCanvasKey } from "@/lib/persist/keys";

const mocks = vi.hoisted(() => ({
  failSaves: false,
  warn: vi.fn<(message: string) => void>(),
  toast: vi.fn<(error: unknown, fallback: string) => void>(),
}));

// Injects a failing save; every other call is the real IndexedDB.
vi.mock("idb-keyval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb-keyval")>();
  return {
    ...actual,
    set: (key: IDBValidKey, value: unknown, store: UseStore | undefined) =>
      mocks.failSaves
        ? Promise.reject(new Error("QuotaExceededError"))
        : actual.set(key, value, store),
  };
});

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logger")>();
  return {
    ...actual,
    appLogger: { ...actual.appLogger, warn: mocks.warn },
  };
});

vi.mock("@/lib/runner-error-toast", () => ({
  toastFromRunnerError: mocks.toast,
}));

const ACCOUNT_A = epicCanvasKey("user-a");
const ACCOUNT_B = epicCanvasKey("user-b");
const ANONYMOUS = epicCanvasKey(null);
const EMAIL_BUCKET = epicCanvasKey("person@example.com");
const DATABASE = "traycer-gui-app:epic-canvas";

/** The module keeps its connection and wipe flag at module scope, so each test loads its own. */
async function loadStorage() {
  vi.resetModules();
  return import("@/stores/epics/canvas/canvas-browser-storage");
}

function peerStore(): UseStore {
  return createStore(DATABASE, "canvases");
}

beforeEach(() => {
  installFreshIndexedDb();
  window.localStorage.clear();
  mocks.failSaves = false;
  mocks.warn.mockClear();
  mocks.toast.mockClear();
});

afterEach(() => {
  // A spy left on IndexedDB would fail every later test's own seeding.
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("the browser canvas storage", () => {
  it("keeps a canvas larger than localStorage allows, byte for byte across a reload", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `pages/p${index}.html`,
        { sha256: "a".repeat(64), byteLength: index, mediaType: "text/html" },
      ]),
    );
    const canvas = JSON.stringify({
      state: {
        tiles: Array.from({ length: 1500 }, (_, index) => ({
          id: index,
          htmlVersion: { manifest: { files, capturedAt: index } },
        })),
      },
    });
    expect(canvas.length).toBeGreaterThan(5_000_000);
    const first = await loadStorage();
    first.createCanvasBrowserStorage(null).setItem(ACCOUNT_A, canvas);
    await first.drainCanvasBrowserStorage();

    const second = await loadStorage();
    const restored = await second
      .createCanvasBrowserStorage(null)
      .getItem(ACCOUNT_A);

    expect(restored === canvas).toBe(true);
    expect(window.localStorage.getItem(ACCOUNT_A)).toBeNull();
  });

  it("keeps each account's canvas under its own key, even when writes queue across an account change", async () => {
    const storage = await loadStorage();
    const writer = storage.createCanvasBrowserStorage(null);

    writer.setItem(ACCOUNT_A, "canvas of a");
    writer.setItem(ACCOUNT_B, "canvas of b");
    await storage.drainCanvasBrowserStorage();

    expect(await get(ACCOUNT_A, peerStore())).toBe("canvas of a");
    expect(await get(ACCOUNT_B, peerStore())).toBe("canvas of b");
  });

  it("never restores or saves the anonymous bucket", async () => {
    window.localStorage.setItem(ANONYMOUS, "signed-out leftovers");
    const storage = await loadStorage();
    const accountStorage = storage.createCanvasBrowserStorage(null);

    expect(await accountStorage.getItem(ANONYMOUS)).toBeNull();
    accountStorage.setItem(ANONYMOUS, "must not persist");
    await storage.drainCanvasBrowserStorage();

    expect(await get(ANONYMOUS, peerStore())).toBeUndefined();
  });

  describe("adopting canvases saved before this storage existed", () => {
    it("moves the canonical localStorage copy into IndexedDB and drops it only afterwards", async () => {
      window.localStorage.setItem(ACCOUNT_A, "old canonical");
      const first = await loadStorage();

      expect(
        await first.createCanvasBrowserStorage(null).getItem(ACCOUNT_A),
      ).toBe("old canonical");

      expect(window.localStorage.getItem(ACCOUNT_A)).toBeNull();
      expect(await get(ACCOUNT_A, peerStore())).toBe("old canonical");
    });

    it("adopts the email-keyed copy when the account has none, and retires it after the commit", async () => {
      window.localStorage.setItem(EMAIL_BUCKET, "saved under the email");
      const storage = await loadStorage();

      const restored = await storage
        .createCanvasBrowserStorage(EMAIL_BUCKET)
        .getItem(ACCOUNT_A);

      expect(restored).toBe("saved under the email");
      expect(window.localStorage.getItem(EMAIL_BUCKET)).toBeNull();
      expect(await get(ACCOUNT_A, peerStore())).toBe("saved under the email");
    });

    it("hands an old email-keyed layout to only one account when two windows migrate at once", async () => {
      window.localStorage.setItem(EMAIL_BUCKET, "shared old layout");
      const firstWindow = await loadStorage();
      const secondWindow = await loadStorage();

      const results = await Promise.all([
        firstWindow.createCanvasBrowserStorage(EMAIL_BUCKET).getItem(ACCOUNT_A),
        secondWindow
          .createCanvasBrowserStorage(EMAIL_BUCKET)
          .getItem(ACCOUNT_B),
      ]);

      expect(results.filter((result) => result !== null)).toEqual([
        "shared old layout",
      ]);
      expect(window.localStorage.getItem(EMAIL_BUCKET)).toBeNull();
    });

    it("prefers a copy another window already saved over a stale localStorage one", async () => {
      await set(ACCOUNT_A, "peer window's newer canvas", peerStore());
      window.localStorage.setItem(ACCOUNT_A, "stale");
      const storage = await loadStorage();

      expect(
        await storage.createCanvasBrowserStorage(null).getItem(ACCOUNT_A),
      ).toBe("peer window's newer canvas");
    });
  });

  describe("when storage fails", () => {
    it("leaves the only localStorage copy in place, and stores nothing, when the migration's transaction fails", async () => {
      window.localStorage.setItem(ACCOUNT_A, "only copy");
      const storage = await loadStorage();
      const put = vi
        .spyOn(IDBObjectStore.prototype, "put")
        .mockImplementation(() => {
          throw new DOMException("quota", "QuotaExceededError");
        });

      try {
        // The read fails; which error carries the cause depends on the engine's
        // event order, and the data assertions below are what must hold.
        await expect(
          storage.createCanvasBrowserStorage(null).getItem(ACCOUNT_A),
        ).rejects.toThrow();
      } finally {
        put.mockRestore();
      }

      expect(window.localStorage.getItem(ACCOUNT_A)).toBe("only copy");
      expect(await get(ACCOUNT_A, peerStore())).toBeUndefined();
    });

    it("refuses to guess at a stored layout it cannot read, rather than falling back to the old copy", async () => {
      await set(ACCOUNT_A, 12345, peerStore());
      window.localStorage.setItem(ACCOUNT_A, "older copy");
      const storage = await loadStorage();

      await expect(
        storage.createCanvasBrowserStorage(null).getItem(ACCOUNT_A),
      ).rejects.toThrow(/unreadable/);

      expect(window.localStorage.getItem(ACCOUNT_A)).toBe("older copy");
      expect(await get(ACCOUNT_A, peerStore())).toBe(12345);
    });

    it("absorbs a failed save, warns on each, tells the person once, and keeps the last good canvas", async () => {
      await set(ACCOUNT_A, "last good", peerStore());
      const storage = await loadStorage();
      const writer = storage.createCanvasBrowserStorage(null);
      mocks.failSaves = true;

      writer.setItem(ACCOUNT_A, "first failing save");
      await storage.drainCanvasBrowserStorage();
      writer.setItem(ACCOUNT_A, "second failing save");
      await storage.drainCanvasBrowserStorage();

      expect(mocks.warn).toHaveBeenCalledTimes(2);
      expect(mocks.toast).toHaveBeenCalledTimes(1);
      expect(await get(ACCOUNT_A, peerStore())).toBe("last good");
    });
  });

  describe("when the saved tabs are wiped", () => {
    it("drops queued saves and accepts no later ones, so nothing is written back after the wipe", async () => {
      const storage = await loadStorage();
      const writer = storage.createCanvasBrowserStorage(null);

      writer.setItem(ACCOUNT_A, "queued before the wipe");
      await storage.retireCanvasBrowserStorage();
      writer.setItem(ACCOUNT_A, "saved after the wipe");
      await storage.drainCanvasBrowserStorage();

      expect(await get(ACCOUNT_A, peerStore())).toBeUndefined();
      await expect(writer.getItem(ACCOUNT_A)).rejects.toThrow(/cleared/);
    });
  });
});
