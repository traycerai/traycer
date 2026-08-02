/** DB promise re-arm, versionchange, and structured-clone reload paths. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PromptStashManifest } from "@/lib/composer/prompt-stash-codec";
import {
  DB_NAME,
  entryRow,
  expectUint8ArrayBytes,
  imageEntry,
  installFreshIndexedDb,
  loadRepo,
  pngBytesOf,
  restoreBlobsOk,
  sha256Hex,
  snapshotFor,
  textEntry,
  textSnapshot,
  PNG_SIGNATURE,
} from "./prompt-stash-repository-test-helpers";
import {
  IDBFactory as FakeIDBFactory,
  IDBKeyRange as FakeIDBKeyRange,
} from "fake-indexeddb";

describe("prompt-stash-repository refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    installFreshIndexedDb();
  });

  it("reload returns structured-cloned Uint8Array blobs, not the original reference", async () => {
    const repo = await loadRepo();
    const original = pngBytesOf([10, 20, 30, 40]);
    const h = await sha256Hex(original);
    const stashEntry = imageEntry("e", 1, h);
    await repo.savePromptStashSnapshot(
      snapshotFor(stashEntry, [[h, original]]),
    );

    const restored = restoreBlobsOk(
      await repo.readPromptStashRestoreBlobs([h]),
    );
    const blob = restored.get(h);
    expect(blob).toBeDefined();
    if (blob === undefined) {
      throw new Error("expected blob for hash h");
    }
    // Structured-cloned (not the same object reference) with correct content.
    expect(blob.bytes).not.toBe(original);
    expectUint8ArrayBytes(blob.bytes, [...PNG_SIGNATURE, 10, 20, 30, 40]);
    expect(blob.byteLength).toBe(12);
    expect(blob.mimeType).toBe("image/png");

    const loaded: PromptStashManifest = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([entryRow(stashEntry)]);
  });
  it("re-arms dbPromise after a failed open so a later call succeeds", async () => {
    const realFactory = new FakeIDBFactory();
    // Fail only the prompt-stash DB open - other modules (e.g. landing-images)
    // also open IndexedDB during import/side effects and must not consume the
    // one-shot failure.
    let failPromptStashOpenOnce = true;
    let promptStashOpenCalls = 0;

    type RequestHandler = (this: IDBRequest, ev: Event) => unknown;

    interface FailingOpenRequest {
      result: IDBDatabase | undefined;
      readonly error: DOMException | null;
      onerror: RequestHandler | null;
      onsuccess: RequestHandler | null;
      onupgradeneeded: RequestHandler | null;
      onblocked: RequestHandler | null;
    }

    function toOpenRequest(request: FailingOpenRequest): IDBOpenDBRequest {
      // Stub only implements the surface openDb wires (onerror/onsuccess).
      return request as IDBOpenDBRequest;
    }

    function failingOpenRequest(): IDBOpenDBRequest {
      let onerror: RequestHandler | null = null;
      let error: DOMException | null = null;
      const request: FailingOpenRequest = {
        result: undefined,
        get error() {
          return error;
        },
        get onerror() {
          return onerror;
        },
        set onerror(handler: RequestHandler | null) {
          onerror = handler;
        },
        onsuccess: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        error = new DOMException("Simulated open failure", "UnknownError");
        if (onerror !== null) {
          onerror.call(toOpenRequest(request), new Event("error"));
        }
      });
      return toOpenRequest(request);
    }

    // Replace the whole factory so the prompt-stash open is guaranteed to fail
    // once (instance method spies on FakeIDBFactory are unreliable here).
    const testFactory: IDBFactory = {
      open(name: string, version: number | undefined): IDBOpenDBRequest {
        if (name === DB_NAME) {
          promptStashOpenCalls += 1;
          if (failPromptStashOpenOnce) {
            failPromptStashOpenOnce = false;
            return failingOpenRequest();
          }
        }
        return version === undefined
          ? realFactory.open(name)
          : realFactory.open(name, version);
      },
      deleteDatabase(name: string): IDBOpenDBRequest {
        return realFactory.deleteDatabase(name);
      },
      cmp(first: IDBValidKey, second: IDBValidKey): number {
        return realFactory.cmp(first, second);
      },
      databases: () =>
        typeof realFactory.databases === "function"
          ? realFactory.databases()
          : Promise.resolve([]),
    };
    globalThis.indexedDB = testFactory;
    globalThis.IDBKeyRange = FakeIDBKeyRange;

    const repo = await loadRepo();
    await expect(repo.loadPromptStashSnapshot()).rejects.toThrow(
      /Simulated open failure|Could not open the prompt stash database/,
    );
    expect(promptStashOpenCalls).toBe(1);

    // Cache must re-arm: the next call opens a real connection successfully.
    expect(await repo.loadPromptStashSnapshot()).toEqual({
      rows: [],
      revision: 0,
    });
    expect(promptStashOpenCalls).toBeGreaterThan(1);
    await repo.savePromptStashSnapshot(
      textSnapshot(textEntry("recovered", 1, "ok")),
    );
    expect(
      (await repo.loadPromptStashSnapshot()).rows.map((row) =>
        row.kind === "entry" ? row.entry.id : row.id,
      ),
    ).toEqual(["recovered"]);
  });

  it("rejects a blocked open and re-arms the cached connection promise", async () => {
    const realFactory = new FakeIDBFactory();
    let blockOnce = true;

    type RequestHandler = (this: IDBRequest, ev: Event) => unknown;

    interface BlockedOpenRequest {
      readonly result: IDBDatabase | undefined;
      readonly error: null;
      onerror: RequestHandler | null;
      onsuccess: RequestHandler | null;
      onupgradeneeded: RequestHandler | null;
      onblocked: RequestHandler | null;
    }

    function toOpenRequest(request: BlockedOpenRequest): IDBOpenDBRequest {
      return request as IDBOpenDBRequest;
    }

    function blockedRequest(): IDBOpenDBRequest {
      const request: BlockedOpenRequest = {
        result: undefined,
        error: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        request.onblocked?.call(toOpenRequest(request), new Event("blocked"));
      });
      return toOpenRequest(request);
    }
    const testFactory: IDBFactory = {
      open(name: string, version: number | undefined): IDBOpenDBRequest {
        if (name === DB_NAME && blockOnce) {
          blockOnce = false;
          return blockedRequest();
        }
        return version === undefined
          ? realFactory.open(name)
          : realFactory.open(name, version);
      },
      deleteDatabase: (name) => realFactory.deleteDatabase(name),
      cmp: (first, second) => realFactory.cmp(first, second),
      databases: () => realFactory.databases(),
    };
    globalThis.indexedDB = testFactory;
    globalThis.IDBKeyRange = FakeIDBKeyRange;

    const repo = await loadRepo();
    await expect(repo.loadPromptStashSnapshot()).rejects.toThrow(
      "blocked by another window",
    );
    await expect(repo.loadPromptStashSnapshot()).resolves.toEqual({
      rows: [],
      revision: 0,
    });
  });

  it("re-arms dbPromise after versionchange closes the cached connection", async () => {
    const repo = await loadRepo();
    await repo.savePromptStashSnapshot(
      textSnapshot(textEntry("before-wipe", 1, "x")),
    );
    expect((await repo.loadPromptStashSnapshot()).rows).toHaveLength(1);

    // deleteDatabase forces onversionchange on the repository's held
    // connection (same path as wipe / cross-window upgrade). The handler
    // must close and null dbPromise so the next open is fresh.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(request.error ?? new Error("deleteDatabase failed"));
      request.onblocked = () => {
        // versionchange should have closed the repo connection; if we stay
        // blocked the production re-arm is incomplete.
      };
    });

    const after = await repo.loadPromptStashSnapshot();
    expect(after).toEqual({ rows: [], revision: 0 });
    await repo.savePromptStashSnapshot(
      textSnapshot(textEntry("after-reopen", 2, "y")),
    );
    expect(
      (await repo.loadPromptStashSnapshot()).rows.map((row) =>
        row.kind === "entry" ? row.entry.id : row.id,
      ),
    ).toEqual(["after-reopen"]);
  });
});
