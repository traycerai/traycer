/** Blob missing/corrupt detection, repair-on-save, and restore-read semantics. */
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
  jpegBytesOf,
  listStoreKeys,
  loadRepo,
  openDb,
  pngBytesOf,
  putBlobRecord,
  requestToPromise,
  restoreBlobsOk,
  sha256Hex,
  snapshotFor,
  transactionComplete,
  PNG_SIGNATURE,
} from "./prompt-stash-repository-test-helpers";

describe("prompt-stash-repository blob corruption", () => {
  beforeEach(() => {
    vi.resetModules();
    installFreshIndexedDb();
  });

  it("readPromptStashRestoreBlobs is all-or-nothing; concurrent delete never yields a partial map", async () => {
    const repo = await loadRepo();
    const a = pngBytesOf([1]);
    const b = pngBytesOf([2]);
    const ha = await sha256Hex(a);
    const hb = await sha256Hex(b);
    const stashEntry: PromptStashEntry = {
      id: "e",
      createdAt: 1,
      blobHashes: [ha, hb],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "imageAttachment",
                attrs: {
                  id: "i1",
                  fileName: "a.png",
                  hash: ha,
                  b64content: null,
                  mimeType: "image/png",
                  size: a.byteLength,
                },
              },
              {
                type: "imageAttachment",
                attrs: {
                  id: "i2",
                  fileName: "b.png",
                  hash: hb,
                  b64content: null,
                  mimeType: "image/png",
                  size: b.byteLength,
                },
              },
            ],
          },
        ],
      },
    };
    await repo.savePromptStashSnapshot(
      snapshotFor(stashEntry, [
        [ha, a],
        [hb, b],
      ]),
    );

    const full = restoreBlobsOk(
      await repo.readPromptStashRestoreBlobs([ha, hb]),
    );
    expect(full.size).toBe(2);
    expect(full.get(ha)?.byteLength).toBe(a.byteLength);
    expect(full.get(hb)?.mimeType).toBe("image/png");

    // After delete, restore of the old hash list is missing (not partial).
    await repo.deletePromptStashEntry("e");
    expect(await repo.readPromptStashRestoreBlobs([ha, hb])).toEqual({
      status: "missing",
    });

    // Race: concurrent restore-read vs delete against a fresh save.
    await repo.savePromptStashSnapshot(
      snapshotFor(stashEntry, [
        [ha, a],
        [hb, b],
      ]),
    );
    const [readResult, deleteResult] = await Promise.all([
      repo.readPromptStashRestoreBlobs([ha, hb]),
      repo.deletePromptStashEntry("e"),
    ]);
    // All-or-nothing: either the full consistent map or missing - never size 1.
    if (readResult.status === "missing") {
      expect(deleteResult.rows).toEqual([]);
    } else {
      expect(readResult.status).toBe("ok");
      if (readResult.status === "ok") {
        expect(readResult.blobs.size).toBe(2);
        expect(readResult.blobs.has(ha)).toBe(true);
        expect(readResult.blobs.has(hb)).toBe(true);
      }
    }
  });
  it("surfaces a missing one-of-many blob as unavailable while keeping best-effort content", async () => {
    const repo = await loadRepo();
    const a = bytesOf([1, 2, 3]);
    const b = bytesOf([4, 5, 6]);
    const ha = await sha256Hex(a);
    const hb = await sha256Hex(b);
    const entry: PromptStashEntry = {
      id: "partial",
      createdAt: 10,
      blobHashes: [ha, hb],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "keep me" },
              {
                type: "imageAttachment",
                attrs: {
                  id: "i1",
                  fileName: "a.png",
                  hash: ha,
                  b64content: null,
                  mimeType: "image/png",
                  size: 3,
                },
              },
              {
                type: "imageAttachment",
                attrs: {
                  id: "i2",
                  fileName: "b.png",
                  hash: hb,
                  b64content: null,
                  mimeType: "image/png",
                  size: 3,
                },
              },
            ],
          },
        ],
      },
    };
    await repo.savePromptStashSnapshot(
      snapshotFor(entry, [
        [ha, a],
        [hb, b],
      ]),
    );
    // Drop only one blob out from under the entry.
    const db = await openDb(DB_NAME, undefined, undefined);
    try {
      const tx = db.transaction("blobs", "readwrite");
      await requestToPromise(tx.objectStore("blobs").delete(hb));
      await transactionComplete(tx);
    } finally {
      db.close();
    }

    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([
      {
        kind: "unavailable",
        id: "partial",
        createdAt: 10,
        content: entry.content,
      },
    ]);
  });

  it("surfaces image nodes with b64content or undeclared hash as unavailable", async () => {
    const repo = await loadRepo();
    await repo.loadPromptStashSnapshot();
    const db = await openDb(DB_NAME, undefined, undefined);
    try {
      const tx = db.transaction("entries", "readwrite");
      await requestToPromise(
        tx.objectStore("entries").put({
          id: "inline-b64",
          createdAt: 5,
          blobHashes: [],
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "copyable" },
                  {
                    type: "imageAttachment",
                    attrs: {
                      id: "i1",
                      fileName: "x.png",
                      hash: null,
                      b64content: "abc",
                      mimeType: "image/png",
                      size: 1,
                    },
                  },
                ],
              },
            ],
          },
        }),
      );
      await requestToPromise(
        tx.objectStore("entries").put({
          id: "undeclared-hash",
          createdAt: 6,
          blobHashes: [],
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "imageAttachment",
                    attrs: {
                      id: "i2",
                      fileName: "y.png",
                      hash: "not-in-blobHashes",
                      b64content: null,
                      mimeType: "image/png",
                      size: 1,
                    },
                  },
                ],
              },
            ],
          },
        }),
      );
      await transactionComplete(tx);
    } finally {
      db.close();
    }

    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows.map((row) => row.kind)).toEqual([
      "unavailable",
      "unavailable",
    ]);
    const inline = loaded.rows.find(
      (row) => row.kind === "unavailable" && row.id === "inline-b64",
    );
    expect(inline?.kind === "unavailable" && inline.content).not.toBeNull();
  });

  it("readPromptStashRestoreBlobs distinguishes missing vs byte-level corruption", async () => {
    const repo = await loadRepo();
    // Open schema before raw blob puts.
    await repo.loadPromptStashSnapshot();
    const good = pngBytesOf([]);
    const goodHash = await sha256Hex(good);
    await putBlobRecord({
      hash: goodHash,
      bytes: good,
      byteLength: good.byteLength,
      mimeType: "image/png",
    });

    expect(await repo.readPromptStashRestoreBlobs(["absent-hash"])).toEqual({
      status: "missing",
    });

    // Wrong runtime type (plain array) is corrupt when the key is present.
    {
      const db = await openDb(DB_NAME, undefined, undefined);
      try {
        const tx = db.transaction("blobs", "readwrite");
        await requestToPromise(
          tx.objectStore("blobs").put({
            hash: "not-bytes",
            bytes: [1, 2, 3],
            byteLength: 3,
            mimeType: "image/png",
          }),
        );
        await transactionComplete(tx);
      } finally {
        db.close();
      }
    }
    expect(await repo.readPromptStashRestoreBlobs(["not-bytes"])).toEqual({
      status: "corrupt",
    });

    // byteLength field disagrees with measured view length.
    await putBlobRecord({
      hash: goodHash,
      bytes: good,
      byteLength: 99,
      mimeType: "image/png",
    });
    expect(await repo.readPromptStashRestoreBlobs([goodHash])).toEqual({
      status: "corrupt",
    });

    // Non-canonical MIME.
    await putBlobRecord({
      hash: goodHash,
      bytes: good,
      byteLength: good.byteLength,
      mimeType: "image/svg+xml",
    });
    expect(await repo.readPromptStashRestoreBlobs([goodHash])).toEqual({
      status: "corrupt",
    });

    // Real signature that disagrees with the declared MIME (JPEG bytes, PNG MIME).
    const jpegAsPng = jpegBytesOf([0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const jpegAsPngHash = await sha256Hex(jpegAsPng);
    await putBlobRecord({
      hash: jpegAsPngHash,
      bytes: jpegAsPng,
      byteLength: jpegAsPng.byteLength,
      mimeType: "image/png",
    });
    expect(await repo.readPromptStashRestoreBlobs([jpegAsPngHash])).toEqual({
      status: "corrupt",
    });

    // SHA-256 does not match the key.
    await putBlobRecord({
      hash: "0".repeat(64),
      bytes: good,
      byteLength: good.byteLength,
      mimeType: "image/png",
    });
    expect(await repo.readPromptStashRestoreBlobs(["0".repeat(64)])).toEqual({
      status: "corrupt",
    });

    // Valid again.
    await putBlobRecord({
      hash: goodHash,
      bytes: good,
      byteLength: good.byteLength,
      mimeType: "image/png",
    });
    const ok = restoreBlobsOk(
      await repo.readPromptStashRestoreBlobs([goodHash]),
    );
    expect(ok.get(goodHash)?.byteLength).toBe(PNG_SIGNATURE.length);
  });

  /**
   * Cases 1-2 below exercise the save cursor visitor over retained malformed
   * blob records. Under the pre-fix code a null `bytes` threw inside the
   * visitor (DOM event handler), hanging `savePromptStashSnapshot` forever;
   * a plain-array `bytes` NaN-poisoned kept-byte accounting. Settlement still
   * must be deterministic; malformed retained records are now reclaimed
   * (deleted) rather than left uncounted, so they cannot hide unbounded
   * storage outside the budget. Sibling entries that still reference the
   * reclaimed hash surface as unavailable/missing on load/restore.
   */
  it("referenced blob with null bytes is reclaimed on save, not counted toward budget, sibling becomes unavailable", async () => {
    const repo = await loadRepo();
    await repo.loadPromptStashSnapshot();

    // Canonical 64-hex form required by load-time hash-format validation.
    const nullHash =
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const holder = imageEntry("holder-null", 1, nullHash);

    const db = await openDb(DB_NAME, undefined, undefined);
    try {
      const tx = db.transaction(["entries", "blobs", "meta"], "readwrite");
      await requestToPromise(tx.objectStore("entries").put(holder));
      // Malformed retained blob: null bytes, but a huge claimed byteLength
      // that would exhaust the budget if the record were kept uncounted.
      await requestToPromise(
        tx.objectStore("blobs").put({
          hash: nullHash,
          bytes: null,
          byteLength: repo.PROMPT_STASH_BUDGET_BYTES,
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

    // Real blob nearly filling the budget. If the null record's claimed
    // byteLength were counted, kept+incoming would exceed and this would reject.
    const realBytes = new Uint8Array(repo.PROMPT_STASH_BUDGET_BYTES - 1);
    realBytes.fill(5);
    const realHash =
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const extra = imageEntry("extra-real", 2, realHash);

    const after = await repo.savePromptStashSnapshot(
      snapshotFor(extra, [[realHash, realBytes]]),
    );
    expect(
      after.rows
        .map((row) => (row.kind === "entry" ? row.entry.id : row.id))
        .toSorted(),
    ).toEqual(["extra-real", "holder-null"]);

    // Malformed record is reclaimed - only the real admitted blob remains.
    expect(await listStoreKeys("blobs")).toEqual([realHash]);
    const nullRecord = (
      await getAllFromStore<{ hash: string; bytes: unknown }>("blobs")
    ).find((record) => record.hash === nullHash);
    expect(nullRecord).toBeUndefined();

    // Sibling that still referenced the reclaimed hash is visible unavailable.
    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([
      entryRow(extra),
      {
        kind: "unavailable",
        id: "holder-null",
        createdAt: 1,
        content: holder.content,
      },
    ]);
  });

  it("referenced blob with plain-array bytes is reclaimed on save, not counted toward budget, sibling becomes unavailable", async () => {
    const repo = await loadRepo();
    await repo.loadPromptStashSnapshot();

    const arrayHash =
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const holder = imageEntry("holder-array", 1, arrayHash);

    const db = await openDb(DB_NAME, undefined, undefined);
    try {
      const tx = db.transaction(["entries", "blobs", "meta"], "readwrite");
      await requestToPromise(tx.objectStore("entries").put(holder));
      await requestToPromise(
        tx.objectStore("blobs").put({
          hash: arrayHash,
          bytes: [1, 2, 3],
          byteLength: repo.PROMPT_STASH_BUDGET_BYTES,
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

    const realBytes = new Uint8Array(repo.PROMPT_STASH_BUDGET_BYTES - 1);
    realBytes.fill(6);
    const realHash =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const extra = imageEntry("extra-array", 2, realHash);

    const after = await repo.savePromptStashSnapshot(
      snapshotFor(extra, [[realHash, realBytes]]),
    );
    expect(
      after.rows
        .map((row) => (row.kind === "entry" ? row.entry.id : row.id))
        .toSorted(),
    ).toEqual(["extra-array", "holder-array"]);
    expect(await listStoreKeys("blobs")).toEqual([realHash]);
    const arrayRecord = (
      await getAllFromStore<{ hash: string; bytes: unknown }>("blobs")
    ).find((record) => record.hash === arrayHash);
    expect(arrayRecord).toBeUndefined();

    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([
      entryRow(extra),
      {
        kind: "unavailable",
        id: "holder-array",
        createdAt: 1,
        content: holder.content,
      },
    ]);
  });

  it("save repairs a same-hash corrupt preexisting blob with the snapshot's verified bytes", async () => {
    const repo = await loadRepo();
    await repo.loadPromptStashSnapshot();

    // Real, signature-valid bytes whose SHA-256 is the key the corrupt record
    // is already sitting under - so the insert path can repair that key.
    const bytes = pngBytesOf([0x0a, 0x0b, 0x0c, 0x0d]);
    const hash = await sha256Hex(bytes);

    // Leftover corrupt record at `hash` with no entry yet referencing it.
    {
      const db = await openDb(DB_NAME, undefined, undefined);
      try {
        const tx = db.transaction("blobs", "readwrite");
        await requestToPromise(
          tx.objectStore("blobs").put({
            hash,
            bytes: null,
            byteLength: 99,
            mimeType: "image/png",
          }),
        );
        await transactionComplete(tx);
      } finally {
        db.close();
      }
    }
    expect(await listStoreKeys("blobs")).toEqual([hash]);

    const stashEntry = imageEntry("repaired", 1, hash);
    const after = await repo.savePromptStashSnapshot(
      snapshotFor(stashEntry, [[hash, bytes]]),
    );
    expect(after.rows).toEqual([entryRow(stashEntry)]);

    // Store now holds the real Uint8Array bytes, not the corrupt placeholder.
    const stored = await getAllFromStore<{
      hash: string;
      bytes: unknown;
      byteLength: number;
      mimeType: string;
    }>("blobs");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.hash).toBe(hash);
    expectUint8ArrayBytes(stored[0]?.bytes, [
      ...PNG_SIGNATURE,
      0x0a,
      0x0b,
      0x0c,
      0x0d,
    ]);
    expect(stored[0]?.byteLength).toBe(bytes.byteLength);
    expect(stored[0]?.mimeType).toBe("image/png");

    // Full restore-side validation (signature, length, SHA-256) passes.
    const restored = restoreBlobsOk(
      await repo.readPromptStashRestoreBlobs([hash]),
    );
    const blob = restored.get(hash);
    expect(blob).toBeDefined();
    if (blob === undefined) {
      throw new Error("expected restored blob after repair");
    }
    expectUint8ArrayBytes(blob.bytes, [
      ...PNG_SIGNATURE,
      0x0a,
      0x0b,
      0x0c,
      0x0d,
    ]);
    expect(blob.byteLength).toBe(bytes.byteLength);
    expect(blob.mimeType).toBe("image/png");

    // Entry is a fully restorable row, not unavailable.
    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([entryRow(stashEntry)]);
  });

  it("save repairs a same-hash typed-but-wrong preexisting blob with the snapshot's verified bytes", async () => {
    const repo = await loadRepo();
    await repo.loadPromptStashSnapshot();

    // Real, signature-valid bytes whose SHA-256 is the key a wrong-content
    // record is already sitting under - so own-hash repair must overwrite it.
    const bytes = pngBytesOf([0x11, 0x22, 0x33, 0x44]);
    const hash = await sha256Hex(bytes);

    // Internally self-consistent wrong content: genuine PNG Uint8Array with
    // matching byteLength/mimeType, but not the bytes this hash key claims.
    // Only the SHA-256-vs-key check would fail on restore - the pre-fix
    // cursor pass would treat this as "already present" and suppress repair.
    const wrongBytes = pngBytesOf([0xff, 0xff]);
    {
      const db = await openDb(DB_NAME, undefined, undefined);
      try {
        const tx = db.transaction("blobs", "readwrite");
        await requestToPromise(
          tx.objectStore("blobs").put({
            hash,
            bytes: wrongBytes,
            byteLength: wrongBytes.byteLength,
            mimeType: "image/png",
          }),
        );
        await transactionComplete(tx);
      } finally {
        db.close();
      }
    }
    expect(await listStoreKeys("blobs")).toEqual([hash]);

    const stashEntry = imageEntry("repaired-typed", 1, hash);
    const after = await repo.savePromptStashSnapshot(
      snapshotFor(stashEntry, [[hash, bytes]]),
    );
    expect(after.rows).toEqual([entryRow(stashEntry)]);

    // Store holds the real bytes for this key, not the typed-but-wrong ones.
    const stored = await getAllFromStore<{
      hash: string;
      bytes: unknown;
      byteLength: number;
      mimeType: string;
    }>("blobs");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.hash).toBe(hash);
    expectUint8ArrayBytes(stored[0]?.bytes, [
      ...PNG_SIGNATURE,
      0x11,
      0x22,
      0x33,
      0x44,
    ]);
    expect(stored[0]?.byteLength).toBe(bytes.byteLength);
    expect(stored[0]?.mimeType).toBe("image/png");

    // Full restore-side validation (signature, length, SHA-256) passes.
    const restored = restoreBlobsOk(
      await repo.readPromptStashRestoreBlobs([hash]),
    );
    const blob = restored.get(hash);
    expect(blob).toBeDefined();
    if (blob === undefined) {
      throw new Error("expected restored blob after typed-wrong repair");
    }
    expectUint8ArrayBytes(blob.bytes, [
      ...PNG_SIGNATURE,
      0x11,
      0x22,
      0x33,
      0x44,
    ]);
    expect(blob.byteLength).toBe(bytes.byteLength);
    expect(blob.mimeType).toBe("image/png");

    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([entryRow(stashEntry)]);
  });
});
