/**
 * R11F2 (P2): `savePromptStashSnapshot` (an ORDINARY save) used to delegate
 * to the fenced variant, which registered every transaction in
 * `liveFencedTransactions` unconditionally. That meant an identity teardown
 * (`abortLiveFencedPromptStashWrites`) could reject a legitimate ordinary
 * save - the composer's own stash capture awaits plain `save` before
 * treating a prompt as durable - with `TransactionInactiveError` if it was
 * already active, or `AbortError` if it was merely queued and hadn't started
 * yet. The fix routes `abortable` through `saveSnapshotTransaction` so only
 * `savePromptStashSnapshotWhile` (and never an ordinary save, a read, or a
 * delete) is reachable by the retirement.
 *
 * These tests drive both timings a teardown could land on:
 *  - ACTIVE: the transaction has already issued its first request (hooked at
 *    the real `entries.put` success event, exactly like the R10F1 fenced
 *    test, but for an UNFENCED save);
 *  - QUEUED: the retirement call happens synchronously right after
 *    `savePromptStashSnapshot` is invoked, before even the first macrotask
 *    that starts pumping the transaction's requests has had a chance to run.
 *
 * A fenced save in the identical ACTIVE timing is the control: it must still
 * abort, proving the retirement mechanism itself is exercised by these
 * tests and not merely inert.
 */
import { IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installFreshIndexedDb,
  loadRepo,
  textEntry,
  textSnapshot,
} from "./prompt-stash-repository-test-helpers";

type PutMethod = (
  this: IDBObjectStore,
  value: unknown,
  key: IDBValidKey | undefined,
) => IDBRequest<IDBValidKey>;

/**
 * Fires `onSuccess` synchronously inside the real `entries.put` request's own
 * "success" event, registered via `addEventListener` before
 * `saveSnapshotTransaction`'s own `requestToPromise` attaches its `onsuccess`
 * property handler - so this callback observes the transaction while it is
 * genuinely ACTIVE and mid-flight (the entry's own bytes already queued to
 * commit, `bumpRevision`'s meta requests not yet even issued).
 */
function hookEntriesPutSuccess(onSuccess: () => void): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    FakeIDBObjectStore.prototype,
    "put",
  );
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("Expected IDBObjectStore.prototype.put to exist.");
  }
  const original: PutMethod = descriptor.value as PutMethod;
  FakeIDBObjectStore.prototype.put = function (
    this: IDBObjectStore,
    value: unknown,
    key: IDBValidKey | undefined,
  ): IDBRequest<IDBValidKey> {
    const request = original.call(this, value, key);
    if (this.name === "entries") {
      request.addEventListener("success", () => onSuccess(), { once: true });
    }
    return request;
  };
  return () => {
    FakeIDBObjectStore.prototype.put = original;
  };
}

type GetAllMethod = (
  this: IDBObjectStore,
  query: IDBValidKey | IDBKeyRange | null | undefined,
  count: number | undefined,
) => IDBRequest<unknown[]>;

/**
 * Same idea as {@link hookEntriesPutSuccess}, but for `entries.getAll` - the
 * first request `loadPromptStashSnapshot`'s readonly transaction issues -
 * so a retirement can be landed while a READ is genuinely mid-flight.
 */
function hookEntriesGetAllSuccess(onSuccess: () => void): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    FakeIDBObjectStore.prototype,
    "getAll",
  );
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("Expected IDBObjectStore.prototype.getAll to exist.");
  }
  const original: GetAllMethod = descriptor.value as GetAllMethod;
  FakeIDBObjectStore.prototype.getAll = function (
    this: IDBObjectStore,
    query: IDBValidKey | IDBKeyRange | null | undefined,
    count: number | undefined,
  ): IDBRequest<unknown[]> {
    const request = original.call(this, query, count);
    if (this.name === "entries") {
      request.addEventListener("success", () => onSuccess(), { once: true });
    }
    return request;
  };
  return () => {
    FakeIDBObjectStore.prototype.getAll = original;
  };
}

describe("R11F2: an ordinary save's isolation from the identity-teardown fence", () => {
  beforeEach(() => {
    vi.resetModules();
    installFreshIndexedDb();
  });

  it("an ACTIVE ordinary save survives a teardown abort landing mid-flight", async () => {
    const repo = await loadRepo();
    const entry = textEntry(
      "r11f2-active",
      1,
      "r11f2 ordinary save active during teardown",
    );

    const unhook = hookEntriesPutSuccess(() => {
      repo.abortLiveFencedPromptStashWrites();
    });

    const result = await repo.savePromptStashSnapshot(textSnapshot(entry));
    unhook();

    expect(result.rows).toEqual([{ kind: "entry", entry }]);
    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([{ kind: "entry", entry }]);
  });

  it("a QUEUED ordinary save (its transaction created and registered, but not yet started - genuinely waiting behind another overlapping-scope transaction) still commits", async () => {
    const repo = await loadRepo();
    // fake-indexeddb genuinely serializes overlapping-scope transactions
    // (`Database.processTransactions`): a second readwrite transaction over
    // the same stores is created and can register into
    // `liveFencedTransactions` right away, but its `_start()` (the first
    // moment it can actually run a request) is deferred until the first
    // transaction completes. `blocker`'s save issues several sequential
    // requests (getAll, a cursor, put, two meta requests), each gated by its
    // own macrotask - plenty of ticks for `queued`'s transaction to exist and
    // register while genuinely still waiting.
    const blockerEntry = textEntry("r11f2-blocker", 1, "r11f2 blocker save");
    const queuedEntry = textEntry(
      "r11f2-queued",
      2,
      "r11f2 ordinary save queued during teardown",
    );

    // Anchored on a real EVENT of the blocker's transaction, not a bare
    // `setTimeout(0)`. The timer version was the defect this polish exists for:
    // it landed the retirement at a moment that varied between a full-file run
    // and an isolated one, and in isolation it fired before either transaction
    // had registered at all - so the case passed with nothing under test.
    // The blocker's `entries.put` success is a point where the blocker is
    // mid-flight and `queued`'s transaction has certainly been created (it was
    // requested several macrotasks earlier), which is exactly the window a
    // registering unfenced save would be abortable in.
    const blocker = repo.savePromptStashSnapshot(textSnapshot(blockerEntry));
    const queued = repo.savePromptStashSnapshot(textSnapshot(queuedEntry));

    const unhook = hookEntriesPutSuccess(() => {
      repo.abortLiveFencedPromptStashWrites();
    });
    const [, queuedResult] = await Promise.all([blocker, queued]);
    unhook();

    expect(
      queuedResult.rows.some(
        (row) => row.kind === "entry" && row.entry.id === "r11f2-queued",
      ),
    ).toBe(true);
    const loaded = await repo.loadPromptStashSnapshot();
    expect(
      loaded.rows.some(
        (row) => row.kind === "entry" && row.entry.id === "r11f2-queued",
      ),
    ).toBe(true);
  });

  it("a read (loadPromptStashSnapshot) is untouched by a teardown mid-flight", async () => {
    const repo = await loadRepo();
    const entry = textEntry("r11f2-read-seed", 1, "seed for the read test");
    await repo.savePromptStashSnapshot(textSnapshot(entry));

    const unhook = hookEntriesGetAllSuccess(() => {
      repo.abortLiveFencedPromptStashWrites();
    });
    const loaded = await repo.loadPromptStashSnapshot();
    unhook();

    expect(loaded.rows).toEqual([{ kind: "entry", entry }]);
  });

  it("a delete is untouched by a teardown mid-flight", async () => {
    const repo = await loadRepo();
    const entry = textEntry("r11f2-delete", 1, "delete test entry");
    await repo.savePromptStashSnapshot(textSnapshot(entry));

    // Inside the delete's OWN transaction. Calling the teardown synchronously
    // after `deletePromptStashEntry` returns its promise was too early:
    // `runTransaction` awaits `openDb()` first, so no transaction existed yet
    // and the case passed even with deletes made abortable. `entries.getAll`
    // is the first request the delete's transaction issues.
    const unhook = hookEntriesGetAllSuccess(() => {
      repo.abortLiveFencedPromptStashWrites();
    });
    const result = await repo.deletePromptStashEntry("r11f2-delete");
    unhook();

    expect(result.rows).toEqual([]);
    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([]);
  });

  it("control: a FENCED save in the identical QUEUED timing still aborts", async () => {
    const repo = await loadRepo();
    const blockerEntry = textEntry(
      "r11f2-queued-control-blocker",
      1,
      "blocker for the queued fenced control",
    );
    const fencedEntry = textEntry(
      "r11f2-queued-control-fenced",
      2,
      "fenced save queued during teardown",
    );

    // Same anchor as the queued ordinary case. Without this control that case
    // could pass because the retirement never reached ANY transaction at that
    // moment, rather than because ordinary saves are exempt from it.
    const blocker = repo.savePromptStashSnapshot(textSnapshot(blockerEntry));
    const fenced = repo.savePromptStashSnapshotWhile(
      textSnapshot(fencedEntry),
      () => true,
    );

    const unhook = hookEntriesPutSuccess(() => {
      repo.abortLiveFencedPromptStashWrites();
    });
    await blocker;
    await expect(fenced).rejects.toThrow();
    unhook();

    const loaded = await repo.loadPromptStashSnapshot();
    expect(
      loaded.rows.some(
        (row) =>
          row.kind === "entry" &&
          row.entry.id === "r11f2-queued-control-fenced",
      ),
    ).toBe(false);
  });

  it("control: a FENCED save aborts when the retirement lands on an entries.getAll, the delete case's own timing", async () => {
    const repo = await loadRepo();
    const entry = textEntry(
      "r11f2-getall-control",
      1,
      "fenced save during an entries.getAll",
    );

    // The delete case lands its retirement on `entries.getAll` - the first
    // request of the transaction. A fenced save issues the same request first,
    // so this proves the retirement genuinely bites at that anchor and the
    // delete's survival is exemption, not a missed window.
    const unhook = hookEntriesGetAllSuccess(() => {
      repo.abortLiveFencedPromptStashWrites();
    });
    await expect(
      repo.savePromptStashSnapshotWhile(textSnapshot(entry), () => true),
    ).rejects.toThrow();
    unhook();

    const loaded = await repo.loadPromptStashSnapshot();
    expect(
      loaded.rows.some(
        (row) =>
          row.kind === "entry" && row.entry.id === "r11f2-getall-control",
      ),
    ).toBe(false);
  });

  it("control: a FENCED save in the identical ACTIVE timing still aborts", async () => {
    const repo = await loadRepo();
    const entry = textEntry(
      "r11f2-fenced-control",
      1,
      "r11f2 fenced save active during teardown",
    );

    const unhook = hookEntriesPutSuccess(() => {
      repo.abortLiveFencedPromptStashWrites();
    });

    await expect(
      repo.savePromptStashSnapshotWhile(textSnapshot(entry), () => true),
    ).rejects.toThrow();
    unhook();

    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([]);
  });
});
