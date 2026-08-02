/** Repository transaction, capacity, concurrency, and CRUD orchestration. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";
import {
  DB_NAME,
  bytesOf,
  entryRow,
  expectUint8ArrayBytes,
  getAllFromStore,
  imageEntry,
  installFreshIndexedDb,
  listStoreKeys,
  loadRepo,
  objectStoreNamesOf,
  openDb,
  pngBytesOf,
  putBlobRecord,
  requestToPromise,
  restoreBlobsOk,
  seedDevOnlyStashStore,
  sha256Hex,
  snapshotFor,
  textDoc,
  textEntry,
  textSnapshot,
  transactionComplete,
  PNG_SIGNATURE,
} from "./prompt-stash-repository-test-helpers";

describe("prompt-stash-repository transactions", () => {
  beforeEach(() => {
    vi.resetModules();
    installFreshIndexedDb();
  });

  it("opens with entries/blobs/meta stores and deletes the dev-only stash store on upgrade", async () => {
    await seedDevOnlyStashStore();
    const pre = await openDb(DB_NAME, undefined, undefined);
    expect(objectStoreNamesOf(pre)).toEqual(["stash"]);
    pre.close();

    const repo = await loadRepo();
    const manifest = await repo.loadPromptStashSnapshot();
    expect(manifest).toEqual({ rows: [], revision: 0 });

    const post = await openDb(DB_NAME, undefined, undefined);
    expect(objectStoreNamesOf(post)).toEqual(["blobs", "entries", "meta"]);
    expect(post.objectStoreNames.contains("stash")).toBe(false);
    post.close();
    expect(repo.PROMPT_STASH_DB_NAME).toBe(DB_NAME);
  });

  it("commits entry + missing blobs + bumped revision in one transaction", async () => {
    const repo = await loadRepo();
    const originalBytes = bytesOf([9, 8, 7]);
    const stashEntry = imageEntry("e1", 50, "hash-a");

    const next = await repo.savePromptStashSnapshot(
      snapshotFor(stashEntry, [["hash-a", originalBytes]]),
    );

    expect(next.rows).toEqual([entryRow(stashEntry)]);
    expect(next.revision).toBe(1);

    const blobs = await getAllFromStore<{
      hash: string;
      bytes: Uint8Array;
      byteLength: number;
      mimeType: string;
    }>("blobs");
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.hash).toBe("hash-a");
    expect(blobs[0]?.byteLength).toBe(3);
    expect(blobs[0]?.mimeType).toBe("image/png");
    expectUint8ArrayBytes(blobs[0]?.bytes, [9, 8, 7]);
  });

  it("writes a shared/dedup blob once across two entries", async () => {
    const repo = await loadRepo();
    const shared = bytesOf([1, 1, 1]);
    const a = imageEntry("a", 2, "shared");
    const b = imageEntry("b", 1, "shared");

    await repo.savePromptStashSnapshot(snapshotFor(a, [["shared", shared]]));
    await repo.savePromptStashSnapshot(snapshotFor(b, [["shared", shared]]));

    const blobKeys = await listStoreKeys("blobs");
    expect(blobKeys).toEqual(["shared"]);

    const afterDeleteA = await repo.deletePromptStashEntry("a");
    expect(
      afterDeleteA.rows.map((row) =>
        row.kind === "entry" ? row.entry.id : row.id,
      ),
    ).toEqual(["b"]);
    expect(await listStoreKeys("blobs")).toEqual(["shared"]);

    const afterDeleteB = await repo.deletePromptStashEntry("b");
    expect(afterDeleteB.rows).toEqual([]);
    expect(await listStoreKeys("blobs")).toEqual([]);
  });
  it("rejects a capacity-exceeding save with no store mutation (including rolled-back orphan deletes)", async () => {
    const repo = await loadRepo();
    const existing = textEntry("kept", 1, "kept");
    await repo.savePromptStashSnapshot(textSnapshot(existing));

    // Seed a leaked orphan blob that save would try to reclaim before the cap check.
    const orphanBytes = bytesOf([4, 4, 4, 4]);
    await putBlobRecord({
      hash: "orphan-leak",
      bytes: orphanBytes,
      byteLength: orphanBytes.byteLength,
      mimeType: "image/png",
    });

    const huge = new Uint8Array(repo.PROMPT_STASH_BUDGET_BYTES + 1);
    huge.fill(7);
    const overCap = imageEntry("over", 2, "huge");

    await expect(
      repo.savePromptStashSnapshot(snapshotFor(overCap, [["huge", huge]])),
    ).rejects.toBeInstanceOf(repo.PromptStashCapacityExceededError);

    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([entryRow(existing)]);
    expect(loaded.revision).toBe(1);
    // Orphan reclamation ran inside the aborted transaction and must roll back.
    expect(await listStoreKeys("blobs")).toEqual(["orphan-leak"]);
    const blobs = await getAllFromStore<{ hash: string }>("blobs");
    expect(blobs.map((b) => b.hash)).toEqual(["orphan-leak"]);
  });

  it("allows exactly PROMPT_STASH_BUDGET_BYTES and rejects one byte over", async () => {
    const repo = await loadRepo();
    const exactBytes = new Uint8Array(repo.PROMPT_STASH_BUDGET_BYTES);
    exactBytes.fill(1);
    const exact = imageEntry("exact", 1, "exact-hash");

    const ok = await repo.savePromptStashSnapshot(
      snapshotFor(exact, [["exact-hash", exactBytes]]),
    );
    expect(ok.revision).toBe(1);
    expect(ok.rows).toEqual([entryRow(exact)]);

    await repo.deletePromptStashEntry("exact");

    const overBytes = new Uint8Array(repo.PROMPT_STASH_BUDGET_BYTES + 1);
    overBytes.fill(2);
    const over = imageEntry("over", 1, "over-hash");
    await expect(
      repo.savePromptStashSnapshot(
        snapshotFor(over, [["over-hash", overBytes]]),
      ),
    ).rejects.toBeInstanceOf(repo.PromptStashCapacityExceededError);

    expect(await repo.loadPromptStashSnapshot()).toEqual({
      rows: [],
      revision: 2,
    });
  });

  it("reclaims orphans before the capacity check so a save can fit", async () => {
    const repo = await loadRepo();
    // Fill the entire budget with blob-old under entry e1.
    const oldBytes = new Uint8Array(repo.PROMPT_STASH_BUDGET_BYTES);
    oldBytes.fill(3);
    const first = imageEntry("e1", 1, "old");
    await repo.savePromptStashSnapshot(snapshotFor(first, [["old", oldBytes]]));

    // Replace e1 with a new blob that only fits because "old" is reclaimed first.
    const newBytes = bytesOf([9, 9, 9]);
    const second = imageEntry("e1", 2, "new");
    const next = await repo.savePromptStashSnapshot(
      snapshotFor(second, [["new", newBytes]]),
    );

    expect(next.rows).toEqual([entryRow(second)]);
    expect(await listStoreKeys("blobs")).toEqual(["new"]);
  });

  it("deletes reclaim unreferenced blobs; unknown id is a no-op", async () => {
    const repo = await loadRepo();
    const shared = pngBytesOf([1, 1, 1]);
    const onlyA = pngBytesOf([2, 2, 2]);
    const sharedHash = await sha256Hex(shared);
    const onlyAHash = await sha256Hex(onlyA);
    const entryA: PromptStashEntry = {
      id: "a",
      createdAt: 2,
      blobHashes: [sharedHash, onlyAHash],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "imageAttachment",
                attrs: {
                  id: "img-a1",
                  fileName: "a1.png",
                  hash: sharedHash,
                  b64content: null,
                  mimeType: "image/png",
                  size: shared.byteLength,
                },
              },
              {
                type: "imageAttachment",
                attrs: {
                  id: "img-a2",
                  fileName: "a2.png",
                  hash: onlyAHash,
                  b64content: null,
                  mimeType: "image/png",
                  size: onlyA.byteLength,
                },
              },
            ],
          },
        ],
      },
    };
    const entryB = imageEntry("b", 1, sharedHash);

    await repo.savePromptStashSnapshot(
      snapshotFor(entryA, [
        [sharedHash, shared],
        [onlyAHash, onlyA],
      ]),
    );
    await repo.savePromptStashSnapshot(
      snapshotFor(entryB, [[sharedHash, shared]]),
    );

    const remaining = await repo.deletePromptStashEntry("a");
    expect(remaining.rows).toEqual([entryRow(entryB)]);
    expect(await listStoreKeys("blobs")).toEqual([sharedHash]);
    expect(await repo.readPromptStashRestoreBlobs([onlyAHash])).toEqual({
      status: "missing",
    });
    const sharedRead = await repo.readPromptStashRestoreBlobs([sharedHash]);
    const sharedMap = restoreBlobsOk(sharedRead);
    expectUint8ArrayBytes(sharedMap.get(sharedHash)?.bytes, [
      ...PNG_SIGNATURE,
      1,
      1,
      1,
    ]);

    const beforeNoop = await repo.loadPromptStashSnapshot();
    const noop = await repo.deletePromptStashEntry("missing");
    expect(noop.revision).toBe(beforeNoop.revision);
    expect(noop.rows).toEqual(beforeNoop.rows);
  });
  it("concurrent saves both commit with strictly increasing revisions", async () => {
    const repo = await loadRepo();
    const first = textEntry("a", 1, "a");
    const second = textEntry("b", 2, "b");

    const [r1, r2] = await Promise.all([
      repo.savePromptStashSnapshot(textSnapshot(first)),
      repo.savePromptStashSnapshot(textSnapshot(second)),
    ]);

    // Each save bumps revision; both must land. Order of completion may vary,
    // but the final store holds both and the higher revision is strictly > 0.
    const final = await repo.loadPromptStashSnapshot();
    expect(
      final.rows
        .map((row) => (row.kind === "entry" ? row.entry.id : row.id))
        .toSorted(),
    ).toEqual(["a", "b"]);
    expect(final.revision).toBe(2);
    expect(new Set([r1.revision, r2.revision])).toEqual(new Set([1, 2]));
    expect(Math.max(r1.revision, r2.revision)).toBe(2);
    expect(Math.min(r1.revision, r2.revision)).toBe(1);
  });

  it("save-vs-delete of different entries resolves with no lost update", async () => {
    const repo = await loadRepo();
    const kept = textEntry("kept", 1, "kept");
    const doomed = textEntry("doomed", 2, "doomed");
    await repo.savePromptStashSnapshot(textSnapshot(kept));
    await repo.savePromptStashSnapshot(textSnapshot(doomed));

    const added = textEntry("added", 3, "added");
    const [saveResult, deleteResult] = await Promise.all([
      repo.savePromptStashSnapshot(textSnapshot(added)),
      repo.deletePromptStashEntry("doomed"),
    ]);

    const final = await repo.loadPromptStashSnapshot();
    const ids = final.rows
      .map((row) => (row.kind === "entry" ? row.entry.id : row.id))
      .toSorted();
    expect(ids).toEqual(["added", "kept"]);
    expect(ids).not.toContain("doomed");
    // Both mutations bumped revision (from 2 -> 4).
    expect(final.revision).toBe(4);
    expect(
      new Set([saveResult.revision, deleteResult.revision]).size,
    ).toBeGreaterThanOrEqual(1);
  });
  it("upserts by id and returns entries newest-first", async () => {
    const repo = await loadRepo();
    const first = textEntry("same", 10, "v1");
    const second = textEntry("other", 20, "other");
    const firstUpdated: PromptStashEntry = {
      id: "same",
      createdAt: 30,
      content: textDoc("v2"),
      blobHashes: [],
    };

    await repo.savePromptStashSnapshot(textSnapshot(first));
    await repo.savePromptStashSnapshot(textSnapshot(second));
    const next = await repo.savePromptStashSnapshot(textSnapshot(firstUpdated));

    expect(
      next.rows.map((row) => (row.kind === "entry" ? row.entry.id : row.id)),
    ).toEqual(["same", "other"]);
    expect(next.rows[0]).toEqual(entryRow(firstUpdated));
    expect(next.revision).toBe(3);
  });
  it("admission sums real bytes.byteLength, not understated byteLength metadata", async () => {
    const repo = await loadRepo();
    // Create schema, then seed a live entry whose blob metadata understates
    // the actual stored view length.
    await repo.loadPromptStashSnapshot();

    // Canonical 64-hex form required by load-time hash-format validation.
    // Not a real SHA-256 of `realBytes` - this test never restores.
    const understatedHash =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const realSize = repo.PROMPT_STASH_BUDGET_BYTES - 10;
    const realBytes = new Uint8Array(realSize);
    realBytes.fill(3);
    const existing = imageEntry("kept", 1, understatedHash);

    const db = await openDb(DB_NAME, undefined, undefined);
    try {
      const tx = db.transaction(["entries", "blobs", "meta"], "readwrite");
      await requestToPromise(tx.objectStore("entries").put(existing));
      // Metadata lies: claims 1 byte while the view is nearly the full budget.
      await requestToPromise(
        tx.objectStore("blobs").put({
          hash: understatedHash,
          bytes: realBytes,
          byteLength: 1,
          mimeType: "image/png",
        }),
      );
      await requestToPromise(
        tx.objectStore("meta").put({ key: "state", revision: 1 }),
      );
      await transactionComplete(tx);
    } finally {
      db.close();
    }

    // Incoming 11 bytes: if metadata (1) were trusted, kept+incoming = 12
    // would fit; using real bytes (BUDGET-10)+11 exceeds the budget.
    // Hash only needs to be canonical for the rejected snapshot shape;
    // save fails on capacity before any durable write.
    const incomingHash =
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const incoming = new Uint8Array(11);
    incoming.fill(9);
    const extra = imageEntry("extra", 2, incomingHash);

    await expect(
      repo.savePromptStashSnapshot(
        snapshotFor(extra, [[incomingHash, incoming]]),
      ),
    ).rejects.toBeInstanceOf(repo.PromptStashCapacityExceededError);

    // Store unchanged: only the seeded entry survives; no incoming blob.
    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([entryRow(existing)]);
    expect(loaded.revision).toBe(1);
    expect(await listStoreKeys("blobs")).toEqual([understatedHash]);
  });
  it("still rejects a real over-budget save after malformed-blob zero-contribution fix", async () => {
    const repo = await loadRepo();
    // Seed real Uint8Array usage just under the cap.
    const keptSize = repo.PROMPT_STASH_BUDGET_BYTES - 10;
    const keptBytes = new Uint8Array(keptSize);
    keptBytes.fill(3);
    const keptHash =
      "1111111111111111111111111111111111111111111111111111111111111111";
    const kept = imageEntry("kept-budget", 1, keptHash);
    await repo.savePromptStashSnapshot(
      snapshotFor(kept, [[keptHash, keptBytes]]),
    );

    // 11 more real bytes would push total over 64 MiB.
    const overBytes = new Uint8Array(11);
    overBytes.fill(9);
    const overHash =
      "2222222222222222222222222222222222222222222222222222222222222222";
    const over = imageEntry("over-budget", 2, overHash);

    await expect(
      repo.savePromptStashSnapshot(snapshotFor(over, [[overHash, overBytes]])),
    ).rejects.toBeInstanceOf(repo.PromptStashCapacityExceededError);

    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([entryRow(kept)]);
    expect(await listStoreKeys("blobs")).toEqual([keptHash]);
  });

  it("save and delete tolerate an unrelated corrupt sibling", async () => {
    const repo = await loadRepo();
    const good = textEntry("good", 2, "good text");
    await repo.savePromptStashSnapshot(textSnapshot(good));

    const db = await openDb(DB_NAME, undefined, undefined);
    try {
      const tx = db.transaction(["entries", "blobs"], "readwrite");
      await requestToPromise(
        tx.objectStore("entries").put({
          id: "corrupt-sib",
          createdAt: 1,
          // missing selection / broken shape
          content: { type: "doc", content: [] },
          blobHashes: ["orphan-from-corrupt"],
        }),
      );
      await requestToPromise(
        tx.objectStore("blobs").put({
          hash: "orphan-from-corrupt",
          bytes: bytesOf([9]),
          byteLength: 1,
          mimeType: "image/png",
        }),
      );
      await transactionComplete(tx);
    } finally {
      db.close();
    }

    // Save of a third entry must not throw despite the corrupt sibling.
    const added = textEntry("added", 3, "added");
    const afterSave = await repo.savePromptStashSnapshot(textSnapshot(added));
    expect(
      afterSave.rows
        .map((row) => (row.kind === "entry" ? row.entry.id : row.id))
        .toSorted(),
    ).toEqual(["added", "corrupt-sib", "good"]);

    // Delete the good entry; corrupt sibling's declared blob must stay.
    await repo.deletePromptStashEntry("good");
    expect(await listStoreKeys("blobs")).toEqual(["orphan-from-corrupt"]);

    // Deleting the corrupt sibling by id works and reclaims its blob.
    const afterCorruptDelete = await repo.deletePromptStashEntry("corrupt-sib");
    expect(
      afterCorruptDelete.rows.map((row) =>
        row.kind === "entry" ? row.entry.id : row.id,
      ),
    ).toEqual(["added"]);
    expect(await listStoreKeys("blobs")).toEqual([]);
  });
});
