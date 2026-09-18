/**
 * R11F1 (P1): registration in `liveFencedTransactions` used to be released in
 * the transaction BODY's `finally` - i.e. when `work(tx)` returned, which is
 * strictly BEFORE `runTransaction` goes on to `await done` (the transaction's
 * real completion). A retirement (`abortLiveFencedPromptStashWrites`) landing
 * in that gap found nothing registered to abort, and the entry committed
 * anyway even though the write was supposed to be fenced.
 *
 * This drives that gap directly, at the reviewer's exact point, without going
 * through the whole auth bridge: fake-indexeddb schedules a transaction's
 * request pump (`_start`) via a macrotask (`queueTask` -> `setImmediate`),
 * one per remaining request. So after the LAST request in the transaction
 * (`meta`'s `put`, from `bumpRevision`) fires its "success" event:
 *
 *   1. our hook (attached via `addEventListener`, so it runs before
 *      `requestToPromise`'s `onsuccess` property handler) schedules a
 *      macrotask calling `abortLiveFencedPromptStashWrites()` - queued
 *      FIRST, before fake-indexeddb requeues its own `_start` macrotask;
 *   2. every microtask this event triggers drains before either macrotask
 *      runs - that is exactly where `work(tx)` finishes and returns, and (in
 *      the reverted code) exactly where the old `finally` released the
 *      registration;
 *   3. our abort macrotask runs next (queued first => runs first), while the
 *      transaction is still merely "active", not yet completed;
 *   4. fake-indexeddb's own requeued `_start` runs after that and fires
 *      "complete" only if nothing aborted it in step 3.
 *
 * So by the time our abort call lands, `work(tx)` has already returned in
 * BOTH the fixed and the reverted code - the only thing that differs is
 * whether the transaction is still in `liveFencedTransactions` at that
 * instant. Fixed: yes (removed only on `done` settling) -> the abort call
 * finds it, tears it down, and the save rejects with nothing durable.
 * Reverted (release-on-`work`-return): no -> the abort call is a no-op and
 * the entry commits anyway, undetected.
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
 * Same macrotask primitive fake-indexeddb's own `queueTask` uses (see
 * `lib/scheduling.js`: `setImmediate` when available, `setTimeout(fn, 0)`
 * otherwise). Relative FIFO ordering between our scheduled callback and
 * fake-indexeddb's own requeued `_start` only holds when both go through the
 * SAME timer mechanism - `setImmediate` and `setTimeout(0)` have no
 * guaranteed relative order in Node's event loop.
 */
function queueSameTaskAs(fn: () => void): void {
  const schedule: (cb: () => void) => void =
    typeof globalThis.setImmediate === "function"
      ? globalThis.setImmediate
      : (cb) => setTimeout(cb, 0);
  schedule(fn);
}

/**
 * Schedules `onLastPutSuccess` from inside the real `success` event of the
 * named store's `put` request - registered before `requestToPromise` attaches
 * its own `onsuccess`, so ours always runs first for that same event. Every
 * other store's `put` passes through untouched.
 */
function hookStorePutSuccess(
  storeName: string,
  onSuccess: () => void,
): () => void {
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
    if (this.name === storeName) {
      request.addEventListener("success", () => onSuccess(), { once: true });
    }
    return request;
  };
  return () => {
    FakeIDBObjectStore.prototype.put = original;
  };
}

/** Counts real "abort" events fired on a transaction that had `entries` in scope. */
function hookEntriesTransactionAbort(onAbort: () => void): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    FakeIDBObjectStore.prototype,
    "put",
  );
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("Expected IDBObjectStore.prototype.put to exist.");
  }
  const original: PutMethod = descriptor.value as PutMethod;
  const observed = new WeakSet<IDBTransaction>();
  FakeIDBObjectStore.prototype.put = function (
    this: IDBObjectStore,
    value: unknown,
    key: IDBValidKey | undefined,
  ): IDBRequest<IDBValidKey> {
    const request = original.call(this, value, key);
    if (this.name === "entries" && !observed.has(this.transaction)) {
      observed.add(this.transaction);
      this.transaction.addEventListener("abort", () => onAbort());
    }
    return request;
  };
  return () => {
    FakeIDBObjectStore.prototype.put = original;
  };
}

describe("R11F1: release-on-settle, exercised at the transaction's last request", () => {
  beforeEach(() => {
    vi.resetModules();
    installFreshIndexedDb();
  });

  it("a retirement landing after work() returns but before the transaction completes aborts a fenced save (DRIVE RED on release-in-work's-finally)", async () => {
    const repo = await loadRepo();
    const entry = textEntry(
      "r11f1",
      1,
      "r11f1 fenced save at the last request",
    );

    let abortedTransactions = 0;
    const unhookAbort = hookEntriesTransactionAbort(() => {
      abortedTransactions += 1;
    });
    const unhookPut = hookStorePutSuccess("meta", () => {
      queueSameTaskAs(() => {
        repo.abortLiveFencedPromptStashWrites();
      });
    });

    const save = repo.savePromptStashSnapshotWhile(
      textSnapshot(entry),
      () => true,
    );

    await expect(save).rejects.toThrow();

    unhookPut();
    unhookAbort();

    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([]);
    expect(abortedTransactions).toBeGreaterThan(0);
  });

  it("positive control: with nothing retiring, the same fenced save commits normally", async () => {
    const repo = await loadRepo();
    const entry = textEntry(
      "r11f1-control",
      1,
      "r11f1 fenced save with no retirement",
    );

    let sawPutSuccess = false;
    const unhookPut = hookStorePutSuccess("meta", () => {
      sawPutSuccess = true;
    });

    const result = await repo.savePromptStashSnapshotWhile(
      textSnapshot(entry),
      () => true,
    );
    unhookPut();

    expect(sawPutSuccess).toBe(true);
    expect(result.rows).toEqual([{ kind: "entry", entry }]);

    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([{ kind: "entry", entry }]);
  });
});
