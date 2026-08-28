import { beforeEach, describe, expect, it } from "vitest";
import { createStore, get as idbGet, set as idbSet } from "idb-keyval";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  adoptDraftImageHandoff,
  discardDraftImageHandoff,
  draftHasIngestingImages,
  draftImageHashes,
  stageDraftImageHandoff,
} from "@/lib/composer/landing-image-move";
import {
  deleteImage,
  getImageBytes,
  putImage,
  releaseSession,
} from "@/lib/composer/landing-image-store";
import { PERSIST_PREFIX } from "@/lib/persist/keys";
import { installFreshIndexedDb } from "./prompt-stash-fake-idb";

/**
 * `landing-image-move.ts` against a REAL fake-indexeddb factory per test (the
 * same harness the prompt-stash repository suites use -
 * `installFreshIndexedDb`), rather than a mocked storage layer: the module's
 * contract IS the cross-DB byte copy, which a mocked in-memory map can't
 * exercise honestly.
 *
 * The delete-triggering paths (adopt's import branch, discard after a real
 * stage) are exercised END TO END here, and that is load-bearing: the module
 * once drove the handoff DB through `idb-keyval`, whose `createStore` never
 * closes its connection - so `indexedDB.deleteDatabase` in the same window
 * blocked forever on the module's own open handle and the cleanup promise
 * never settled. The module now opens raw connections and closes them before
 * any delete; these tests hang rather than pass if that regresses.
 *
 * `idb-keyval` is still used for a couple of ASSERTION-side reads/writes -
 * fine in a test, but never against a draftId whose handoff a later step
 * deletes, because its held connection would re-introduce the block.
 */

function imageNode(hash: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id: hash,
      fileName: "shot.png",
      hash,
      mimeType: "image/png",
      size: 3,
    },
  };
}

function docWithImages(hashes: ReadonlyArray<string>): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: hashes.map((hash) => imageNode(hash)),
      },
    ],
  };
}

function handoffStoreFor(draftId: string) {
  return createStore(
    `${PERSIST_PREFIX}:draft-move:${draftId}:landing-images`,
    "bytes",
  );
}

/**
 * fake-indexeddb structured-clones a `Uint8Array` across its own realm (same
 * reasoning as `prompt-stash-repository-test-helpers.ts`'s
 * `expectUint8ArrayBytes`), so a round-tripped value fails a plain `toEqual`
 * against the original even though its bytes match. Compare by content.
 */
function expectBytes(value: unknown, expected: Uint8Array): void {
  expect(ArrayBuffer.isView(value)).toBe(true);
  const view = value as ArrayBufferView;
  expect(
    Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
  ).toEqual(Array.from(expected));
}

describe("landing-image-move", () => {
  beforeEach(() => {
    installFreshIndexedDb();
  });

  describe("draftImageHashes", () => {
    it("returns distinct hashes referenced by imageAttachment nodes, in document order", () => {
      const doc = docWithImages(["hash-a", "hash-b", "hash-a"]);
      expect(draftImageHashes(doc)).toEqual(["hash-a", "hash-b"]);
    });

    it("returns an empty array for content with no image atoms", () => {
      const doc: JsonContent = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      };
      expect(draftImageHashes(doc)).toEqual([]);
    });
  });

  describe("draftHasIngestingImages", () => {
    it("is true while a pasted node still carries base64 and no hash", () => {
      const doc: JsonContent = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              imageNode("hash-a"),
              {
                type: "imageAttachment",
                attrs: {
                  id: "pending-1",
                  fileName: "pasted.png",
                  b64content: "AAAA",
                  mimeType: "image/png",
                  size: 3,
                },
              },
            ],
          },
        ],
      };
      expect(draftHasIngestingImages(doc)).toBe(true);
      // And that node is invisible to staging - which is exactly why the move
      // has to wait for it rather than stage around it.
      expect(draftImageHashes(doc)).toEqual(["hash-a"]);
    });

    it("is false once every node carries a hash", () => {
      expect(draftHasIngestingImages(docWithImages(["hash-a"]))).toBe(false);
    });
  });

  describe("stageDraftImageHandoff", () => {
    it("copies a locally-reachable hash's bytes into the draft's handoff store", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const hash = await putImage(bytes);
      const draftId = "draft-stage-copy";

      await stageDraftImageHandoff(draftId, [hash]);

      const staged = await idbGet<unknown>(hash, handoffStoreFor(draftId));
      expectBytes(staged, bytes);
    });

    it("skips a hash with no local bytes, without throwing and without writing anything for it", async () => {
      const missingHash = "0".repeat(64);
      const draftId = "draft-stage-skip";

      await expect(
        stageDraftImageHandoff(draftId, [missingHash]),
      ).resolves.toBeUndefined();

      expect(await getImageBytes(missingHash)).toBeUndefined();
      const staged = await idbGet<unknown>(
        missingHash,
        handoffStoreFor(draftId),
      );
      expect(staged).toBeUndefined();
    });

    it("is a no-op for an empty hash list", async () => {
      await expect(
        stageDraftImageHandoff("draft-stage-empty", []),
      ).resolves.toBeUndefined();
    });
  });

  describe("adoptDraftImageHandoff", () => {
    it("imports a staged hash that is missing locally, then deletes the handoff", async () => {
      const bytes = new Uint8Array([7, 7, 7, 7, 7]);
      const hash = await putImage(bytes);
      const draftId = "draft-adopt-import";
      // The production sequence: the source stages, then the bytes go missing
      // from THIS partition (in production it is a different window's
      // partition that never had them; here the local copy is removed).
      await stageDraftImageHandoff(draftId, [hash]);
      releaseSession(hash);
      await deleteImage(hash);
      expect(await getImageBytes(hash)).toBeUndefined();

      // Must RESOLVE - a regression back to a held handoff connection makes
      // the trailing deleteDatabase block forever and this await hang.
      await adoptDraftImageHandoff(draftId, [hash]);

      expectBytes(await getImageBytes(hash), bytes);
      // The handoff DB was deleted: a fresh read finds nothing under the hash.
      expect(
        await idbGet<unknown>(hash, handoffStoreFor(draftId)),
      ).toBeUndefined();
    });

    it("no-ops without touching the handoff store when every hash is already locally reachable", async () => {
      const bytes = new Uint8Array([9, 9, 9]);
      const hash = await putImage(bytes);
      const draftId = "draft-adopt-noop";
      // Pre-seed the handoff store with an unrelated entry. If the no-op
      // path opened (and, per its own doc comment, deleted) the handoff DB
      // regardless, this entry would disappear too - its survival is the
      // proof the no-op path never touches the handoff DB at all.
      const sentinel = new Uint8Array([1]);
      await idbSet("sentinel", sentinel, handoffStoreFor(draftId));

      await adoptDraftImageHandoff(draftId, [hash]);

      expectBytes(
        await idbGet<unknown>("sentinel", handoffStoreFor(draftId)),
        sentinel,
      );
    });
  });

  describe("discardDraftImageHandoff", () => {
    it("resolves cleanly for a draft whose handoff was never staged", async () => {
      await expect(
        discardDraftImageHandoff("draft-discard-never-staged"),
      ).resolves.toBeUndefined();
    });

    it("resolves after a real stage - the refused-move cleanup path", async () => {
      const bytes = new Uint8Array([3, 1, 4, 1, 5]);
      const hash = await putImage(bytes);
      const draftId = "draft-discard-staged";
      await stageDraftImageHandoff(draftId, [hash]);

      // Must RESOLVE: stage closes its connection, so the delete cannot block
      // on this window. A regression to a held connection hangs this await.
      await expect(discardDraftImageHandoff(draftId)).resolves.toBeUndefined();
      expect(
        await idbGet<unknown>(hash, handoffStoreFor(draftId)),
      ).toBeUndefined();
    });
  });
});
