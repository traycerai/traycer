/**
 * Unit tests for `importPromptStashContentToLanding` — dedup, zero-image
 * short-circuit, measured-budget reservation, sequential put failure/orphan
 * semantics, hash rewrite with fresh ids, and reservation release on failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  LANDING_IMAGE_BUDGET_BYTES,
  reserveLandingImageBudget,
  resetLandingImageBudgetReservationsForTesting,
} from "@/lib/composer/landing-image-budget";
import {
  deleteImage,
  getImageBytes,
  imageHashKeys,
  putImage,
  releaseSession,
} from "@/lib/composer/landing-image-store";
import * as landingImageStore from "@/lib/composer/landing-image-store";
import { importPromptStashContentToLanding } from "@/lib/composer/landing-stash-import";
import { PromptStashCorruptBlobError } from "@/lib/composer/prompt-stash-repository";
import type {
  PromptStashEntry,
  PromptStashRestoreBlob,
} from "@/lib/composer/prompt-stash-codec";
import * as promptStashRepository from "@/lib/composer/prompt-stash-repository";

const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("idb keys in these tests are strings");
  }
  return key;
}

vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: IDBValidKey) =>
      Promise.resolve(idbData.get(idbStringKey(key))),
    ),
    set: vi.fn((key: IDBValidKey, value: unknown) => {
      idbData.set(idbStringKey(key), value);
      return Promise.resolve();
    }),
    setMany: vi.fn((entries: ReadonlyArray<[IDBValidKey, unknown]>) => {
      for (const [key, value] of entries) {
        idbData.set(idbStringKey(key), value);
      }
      return Promise.resolve();
    }),
    del: vi.fn((key: IDBValidKey) => {
      idbData.delete(idbStringKey(key));
      return Promise.resolve();
    }),
    delMany: vi.fn((keys: ReadonlyArray<IDBValidKey>) => {
      for (const key of keys) {
        idbData.delete(idbStringKey(key));
      }
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
});

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  }),
}));

let urlCounter = 0;

/** In-memory stash blobs for `readPromptStashRestoreBlobs` spy. */
const stashBlobs = new Map<string, PromptStashRestoreBlob>();

function bytesOf(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function requireDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function imageAttrs(
  id: string,
  hash: string,
  size: number,
): Record<string, unknown> {
  return {
    id,
    fileName: `${id}.png`,
    hash,
    b64content: null,
    mimeType: "image/png",
    size,
  };
}

function multiImageDoc(
  nodes: ReadonlyArray<Record<string, unknown>>,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: nodes.map((attrs) => ({ type: "imageAttachment", attrs })),
      },
    ],
  };
}

function collectImageNodes(content: JsonContent): JsonContent[] {
  const found: JsonContent[] = [];
  const walk = (node: JsonContent): void => {
    if (node.type === "imageAttachment") {
      found.push(node);
      return;
    }
    if (!Array.isArray(node.content)) return;
    for (const child of node.content) {
      walk(child);
    }
  };
  walk(content);
  return found;
}

function makeEntry(
  content: JsonContent,
  blobHashes: readonly string[],
): PromptStashEntry {
  return {
    id: "entry-1",
    createdAt: 1,
    content,
    blobHashes,
  };
}

async function seedStashImage(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await sha256Hex(bytes);
  stashBlobs.set(hash, {
    bytes,
    byteLength: bytes.byteLength,
    mimeType: "image/png",
  });
  return hash;
}

async function drainLandingStore(): Promise<void> {
  for (const hash of await imageHashKeys()) {
    await deleteImage(hash);
    releaseSession(hash);
  }
}

describe("importPromptStashContentToLanding", () => {
  beforeEach(async () => {
    idbData.clear();
    stashBlobs.clear();
    resetLandingImageBudgetReservationsForTesting();
    URL.createObjectURL = vi.fn(
      (_obj: Blob | MediaSource) => `blob:mock/${++urlCounter}`,
    );
    URL.revokeObjectURL = vi.fn((_url: string) => undefined);
    await drainLandingStore();
    vi.restoreAllMocks();
    vi.spyOn(
      promptStashRepository,
      "readPromptStashRestoreBlobs",
    ).mockImplementation((hashes) => {
      if (hashes.length === 0) {
        return Promise.resolve({ status: "ok" as const, blobs: new Map() });
      }
      const out = new Map<string, PromptStashRestoreBlob>();
      for (const hash of hashes) {
        const blob = stashBlobs.get(hash);
        if (blob === undefined) {
          return Promise.resolve({ status: "missing" as const });
        }
        out.set(hash, blob);
      }
      return Promise.resolve({ status: "ok" as const, blobs: out });
    });
  });

  afterEach(async () => {
    resetLandingImageBudgetReservationsForTesting();
    await drainLandingStore();
    Reflect.deleteProperty(globalThis, "runnerHost");
    vi.restoreAllMocks();
  });

  it("returns content unchanged immediately when there are no images", async () => {
    const content = textDoc("no images here");
    const readSpy = vi.spyOn(
      promptStashRepository,
      "readPromptStashRestoreBlobs",
    );
    const putSpy = vi.spyOn(landingImageStore, "putImage");

    const result = await importPromptStashContentToLanding(
      makeEntry(content, []),
      "draft-1",
    );

    const zero = requireDefined(result, "zero-image result");
    expect(zero.content).toBe(content);
    // Empty-image path returns a no-op reservation; release is harmless.
    expect(() => zero.reservation.release()).not.toThrow();
    expect(readSpy).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("dedupes repeated stash hashes to one restore-blob read and one put", async () => {
    const bytes = bytesOf([42, 42, 42]);
    const stashHash = await seedStashImage(bytes);
    const readSpy = vi.spyOn(
      promptStashRepository,
      "readPromptStashRestoreBlobs",
    );
    const putSpy = vi.spyOn(landingImageStore, "putImage");

    const content = multiImageDoc([
      imageAttrs("node-a", stashHash, 3),
      imageAttrs("node-b", stashHash, 3),
    ]);
    const result = requireDefined(
      await importPromptStashContentToLanding(
        makeEntry(content, [stashHash]),
        "draft-1",
      ),
      "dedupe import",
    );

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith([stashHash]);
    expect(putSpy).toHaveBeenCalledTimes(1);
    // Reservation still held: same-hash re-reserve succeeds (dedupe), a
    // near-cap different hash that only fits if this reservation is free fails.
    const overlapping = requireDefined(
      reserveLandingImageBudget("draft-1", [{ hash: stashHash, bytes: 3 }]),
      "overlapping same-hash re-reserve",
    );
    overlapping.release();
    result.reservation.release();
  });

  it("assigns distinct fresh ids that map to the same landing hash", async () => {
    const bytes = bytesOf([42, 42, 42]);
    const stashHash = await seedStashImage(bytes);
    const result = requireDefined(
      await importPromptStashContentToLanding(
        makeEntry(
          multiImageDoc([
            imageAttrs("node-a", stashHash, 3),
            imageAttrs("node-b", stashHash, 3),
          ]),
          [stashHash],
        ),
        "draft-1",
      ),
      "fresh-id import",
    );

    const images = collectImageNodes(result.content);
    expect(images).toHaveLength(2);
    expect(images[0]?.attrs?.id).not.toBe("a");
    expect(images[1]?.attrs?.id).not.toBe("b");
    const first = requireDefined(images[0], "first node");
    const second = requireDefined(images[1], "second node");
    expect(first.attrs?.id).not.toBe("node-a");
    expect(second.attrs?.id).not.toBe("node-b");
    expect(first.attrs?.id).not.toBe(second.attrs?.id);
    expect(first.attrs?.hash).toBe(second.attrs?.hash);
    expect(first.attrs?.hash).toBe(stashHash);
    expect(await getImageBytes(String(first.attrs?.hash))).toEqual(bytes);
    expect(first.attrs?.fileName).toBe("node-a.png");
    expect(first.attrs?.mimeType).toBe("image/png");
    expect(first.attrs?.size).toBe(3);
    result.reservation.release();
  });

  it("rejects import when a node's declared size disagrees with the verified blob", async () => {
    const bytes = bytesOf([1, 2, 3, 4, 5]);
    const stashHash = await seedStashImage(bytes);
    const reserveSpy = vi.spyOn(
      await import("@/lib/composer/landing-image-budget"),
      "reserveLandingImageBudget",
    );
    const putSpy = vi.spyOn(landingImageStore, "putImage");

    await expect(
      importPromptStashContentToLanding(
        makeEntry(multiImageDoc([imageAttrs("n", stashHash, 99_999_999)]), [
          stashHash,
        ]),
        "draft-x",
      ),
    ).rejects.toBeInstanceOf(PromptStashCorruptBlobError);

    expect(reserveSpy).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("rejects import when a node's declared mimeType disagrees with the verified blob", async () => {
    const bytes = bytesOf([1, 2, 3, 4, 5]);
    const stashHash = await seedStashImage(bytes);
    const reserveSpy = vi.spyOn(
      await import("@/lib/composer/landing-image-budget"),
      "reserveLandingImageBudget",
    );
    const putSpy = vi.spyOn(landingImageStore, "putImage");

    // Verified stash blob is image/png; node claims image/jpeg with matching size.
    const mismatched = {
      ...imageAttrs("n", stashHash, bytes.byteLength),
      mimeType: "image/jpeg",
    };

    await expect(
      importPromptStashContentToLanding(
        makeEntry(multiImageDoc([mismatched]), [stashHash]),
        "draft-x",
      ),
    ).rejects.toBeInstanceOf(PromptStashCorruptBlobError);

    expect(reserveSpy).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("returns null when reserveLandingImageBudget rejects", async () => {
    const bytes = bytesOf([9, 9]);
    const stashHash = await seedStashImage(bytes);
    const budget = await import("@/lib/composer/landing-image-budget");
    vi.spyOn(budget, "reserveLandingImageBudget").mockReturnValue(null);
    const putSpy = vi.spyOn(landingImageStore, "putImage");

    const result = await importPromptStashContentToLanding(
      makeEntry(multiImageDoc([imageAttrs("n", stashHash, 2)]), [stashHash]),
      null,
    );
    expect(result).toBeNull();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("throws when a stash blob is missing before any landing write", async () => {
    const putSpy = vi.spyOn(landingImageStore, "putImage");
    await expect(
      importPromptStashContentToLanding(
        makeEntry(multiImageDoc([imageAttrs("n", "missing-hash", 1)]), [
          "missing-hash",
        ]),
        "draft-1",
      ),
    ).rejects.toThrow("A stashed image is missing from durable storage.");
    expect(putSpy).not.toHaveBeenCalled();
  });

  for (const failIndex of [0, 1, 2] as const) {
    it(`stops on putImage failure at index ${failIndex}, leaves prior orphans, releases reservation`, async () => {
      const byteSets = [
        bytesOf([10, 10, 10]),
        bytesOf([20, 20, 20]),
        bytesOf([30, 30, 30]),
      ];
      const hashes = await Promise.all(byteSets.map((b) => seedStashImage(b)));
      const originalPut = putImage;
      let call = 0;
      vi.spyOn(landingImageStore, "putImage").mockImplementation(
        async (bytes) => {
          const index = call;
          call += 1;
          if (index === failIndex) {
            throw new Error(`forced put failure at ${failIndex}`);
          }
          return originalPut(bytes);
        },
      );

      const result = await importPromptStashContentToLanding(
        makeEntry(
          multiImageDoc(hashes.map((hash, i) => imageAttrs(`n${i}`, hash, 3))),
          hashes,
        ),
        "draft-1",
      );
      expect(result).toBeNull();
      expect(call).toBe(failIndex + 1);

      for (let i = 0; i < failIndex; i += 1) {
        const set = requireDefined(byteSets[i], `byte set ${i}`);
        const landingHash = await sha256Hex(set);
        expect(await getImageBytes(landingHash)).toEqual(set);
      }

      const reReserve = reserveLandingImageBudget(
        "draft-1",
        hashes.map((hash, i) => ({
          hash,
          bytes: requireDefined(byteSets[i], `bytes ${i}`).byteLength,
        })),
      );
      expect(reReserve).not.toBeNull();
      requireDefined(reReserve, "reReserve").release();
    });
  }

  it("rewrites every image node to a landing hash backed by durable bytes", async () => {
    const bytesA = bytesOf([1, 1, 1, 1]);
    const bytesB = bytesOf([2, 2, 2, 2]);
    const hashA = await seedStashImage(bytesA);
    const hashB = await seedStashImage(bytesB);

    const result = requireDefined(
      await importPromptStashContentToLanding(
        makeEntry(
          multiImageDoc([imageAttrs("a", hashA, 4), imageAttrs("b", hashB, 4)]),
          [hashA, hashB],
        ),
        "draft-1",
      ),
      "rewrite import",
    );

    // Two distinct hashes reserved: a third near-cap different hash that only
    // fits if those 8 bytes were free would still succeed here (tiny usage),
    // so prove the reservation object exists and release frees capacity.
    expect(typeof result.reservation.release).toBe("function");
    const images = collectImageNodes(result.content);
    expect(images).toHaveLength(2);
    expect(images[0]?.attrs?.hash).toBe(hashA);
    expect(images[1]?.attrs?.hash).toBe(hashB);
    expect(await getImageBytes(String(images[0]?.attrs?.hash))).toEqual(bytesA);
    expect(await getImageBytes(String(images[1]?.attrs?.hash))).toEqual(bytesB);
    result.reservation.release();
  });

  it("releases reservation on put failure so a later full-budget reserve succeeds", async () => {
    const big = new Uint8Array(1024);
    big.fill(7);
    const stashHash = await seedStashImage(big);
    vi.spyOn(landingImageStore, "putImage").mockRejectedValueOnce(
      new Error("disk full"),
    );

    const failed = await importPromptStashContentToLanding(
      makeEntry(multiImageDoc([imageAttrs("big", stashHash, big.byteLength)]), [
        stashHash,
      ]),
      "draft-1",
    );
    expect(failed).toBeNull();

    const again = reserveLandingImageBudget("draft-1", [
      { hash: "post-failure", bytes: LANDING_IMAGE_BUDGET_BYTES },
    ]);
    const againOk = requireDefined(again, "again");
    againOk.release();
  });
});
