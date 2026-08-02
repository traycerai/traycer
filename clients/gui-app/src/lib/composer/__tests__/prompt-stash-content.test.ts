import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { bytesToBase64 } from "@/lib/composer/image-base64";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  appendPromptStashContent,
  buildPromptStashSnapshot,
  materializePromptStashEntry,
  PromptStashImagePreparationError,
} from "@/lib/composer/prompt-stash-content";
import type {
  PreparedPromptStashImage,
  PromptStashImageCodec,
  PromptStashImagePreparationSession,
} from "@/lib/composer/prompt-stash-image-preparation";
import { PromptStashCorruptBlobError } from "@/lib/composer/prompt-stash-repository";
import type {
  PromptStashEntry,
  PromptStashRestoreBlob,
  PromptStashRestoreRead,
} from "@/lib/composer/prompt-stash-codec";
import {
  animatedWebpBytesOfSize,
  jpegBytesOfSize,
  pngBytesOfSize,
  STATIC_MAX,
  structurallyAnimatedGifWithCorruptLzw,
  structurallyAnimatedWebpWithCorruptFrames,
  twoFrameGifBytesOfSize,
} from "./prompt-stash-image-fixtures";

const restoreBlobsMock = vi.hoisted(() =>
  vi.fn<(blobHashes: readonly string[]) => Promise<PromptStashRestoreRead>>(),
);

function okRestoreBlobs(
  entries: ReadonlyArray<readonly [string, PromptStashRestoreBlob]>,
): PromptStashRestoreRead {
  return { status: "ok", blobs: new Map(entries) };
}

vi.mock("@/lib/composer/prompt-stash-repository", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/prompt-stash-repository")
    >();
  return {
    ...actual,
    readPromptStashRestoreBlobs: (
      blobHashes: readonly string[],
    ): Promise<PromptStashRestoreRead> => restoreBlobsMock(blobHashes),
  };
});

type PrepareArgs = {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly fileName: string;
  readonly declaredMimeType: string;
};

const prepareSpy = vi.hoisted(() =>
  vi.fn<(args: PrepareArgs) => void>(() => undefined),
);

vi.mock(
  "@/lib/composer/prompt-stash-image-preparation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/composer/prompt-stash-image-preparation")
      >();
    return {
      ...actual,
      createPromptStashImagePreparationSession: (
        codec: PromptStashImageCodec | undefined,
      ): PromptStashImagePreparationSession => {
        const session = actual.createPromptStashImagePreparationSession(codec);
        return {
          prepare: (args: PrepareArgs): Promise<PreparedPromptStashImage> => {
            prepareSpy(args);
            return session.prepare(args);
          },
        };
      },
    };
  },
);

function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    );
}

/** Rich prompt covering marks, lists, mentions, slash + skill chips, and an image. */
function richDoc(imageAttrs: Record<string, unknown>): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "slashCommand",
            attrs: {
              commandName: "implement",
              harnessId: "claude",
              kind: "slash-command",
              description: "Implement the plan",
              argumentHint: null,
              path: null,
              trigger: "/",
            },
          },
          { type: "text", text: " " },
          {
            type: "text",
            text: "bold",
            marks: [{ type: "bold" }],
          },
          { type: "text", text: " and " },
          {
            type: "text",
            text: "italic",
            marks: [{ type: "italic" }],
          },
          { type: "text", text: " with " },
          {
            type: "mention",
            attrs: {
              contextType: "file",
              path: "src/app.tsx",
              relPath: "src/app.tsx",
              pathKind: "file",
              label: "app.tsx",
            },
          },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "bullet one" }],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "slashCommand",
                    attrs: {
                      commandName: "frontend-design",
                      harnessId: "claude",
                      kind: "skill",
                      description: "Use frontend-design",
                      argumentHint: null,
                      path: "/repo/.agents/skills/frontend-design/SKILL.md",
                      trigger: "$",
                    },
                  },
                  { type: "text", text: " chip" },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: imageAttrs,
          },
        ],
      },
    ],
  };
}

function multiImageDoc(
  images: ReadonlyArray<Record<string, unknown>>,
): JsonContent {
  return {
    type: "doc",
    content: images.map((attrs) => ({
      type: "paragraph",
      content: [{ type: "imageAttachment", attrs }],
    })),
  };
}

function findImageAttrs(
  node: JsonContent,
): Record<string, unknown> | undefined {
  if (node.type === "imageAttachment") return node.attrs;
  for (const child of node.content ?? []) {
    const found = findImageAttrs(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findAllImageAttrs(node: JsonContent): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  if (node.type === "imageAttachment" && node.attrs !== undefined) {
    found.push(node.attrs);
  }
  for (const child of node.content ?? []) {
    found.push(...findAllImageAttrs(child));
  }
  return found;
}

function neverReadHash(): Promise<Uint8Array<ArrayBuffer> | null> {
  return Promise.reject(new Error("hash resolver must not be consulted"));
}

function missingHash(): Promise<Uint8Array<ArrayBuffer> | null> {
  return Promise.resolve(null);
}

const originalCreateImageBitmap = globalThis.createImageBitmap;

describe("prompt-stash-content", () => {
  beforeEach(() => {
    restoreBlobsMock.mockReset();
    prepareSpy.mockClear();
    // Static images under the threshold still decode once; give the browser
    // codec stub real dimensions so preparation succeeds.
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: vi.fn(() =>
        Promise.resolve({
          width: 16,
          height: 16,
          close: () => undefined,
        }),
      ),
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: originalCreateImageBitmap,
    });
  });

  it("round-trips marks, lists, mentions, slash/skill nodes and selection while re-owning images", async () => {
    const imageBytes = pngBytesOfSize(32);
    const b64 = bytesToBase64(imageBytes);
    // Transient source nodes may carry both inline bytes and a source hash.
    // Inline is authoritative; the source hash is discarded after re-owning.
    const sourceHash = "source-epic-hash-not-kept";
    const content = richDoc({
      id: "img-source-1",
      fileName: "diagram.png",
      b64content: b64,
      hash: sourceHash,
      mimeType: "image/png",
      size: imageBytes.byteLength,
    });
    const snapshot = await buildPromptStashSnapshot({
      id: "entry-1",
      createdAt: 1_700_000_000_000,
      content,
      readHashImage: neverReadHash,
    });

    const ownedHash = await sha256Hex(imageBytes);

    expect(snapshot.entry.content.content?.[0]).toEqual(content.content?.[0]);
    expect(snapshot.entry.content.content?.[1]).toEqual(content.content?.[1]);
    expect(snapshot.entry.content.content).toHaveLength(3);

    const stashedAttrs = findImageAttrs(snapshot.entry.content);
    expect(stashedAttrs).toEqual({
      id: "img-source-1",
      fileName: "diagram.png",
      hash: ownedHash,
      b64content: null,
      mimeType: "image/png",
      size: imageBytes.byteLength,
    });
    expect(stashedAttrs?.hash).not.toBe(sourceHash);
    expect(snapshot.imagesByHash.get(ownedHash)).toEqual({
      bytes: imageBytes,
      mimeType: "image/png",
    });
    expect(snapshot.entry.blobHashes).toEqual([ownedHash]);

    restoreBlobsMock.mockResolvedValueOnce(
      okRestoreBlobs([
        [
          ownedHash,
          {
            bytes: imageBytes,
            byteLength: imageBytes.byteLength,
            mimeType: "image/png",
          },
        ],
      ]),
    );

    const restored = await materializePromptStashEntry(snapshot.entry);
    expect(restoreBlobsMock).toHaveBeenCalledTimes(1);
    expect(restoreBlobsMock).toHaveBeenCalledWith([ownedHash]);
    const restoredAttrs = findImageAttrs(restored);
    expect(restoredAttrs?.hash).toBeNull();
    expect(restoredAttrs?.b64content).toBe(b64);
    expect(restoredAttrs?.id).toEqual(expect.any(String));
    expect(restoredAttrs?.id).not.toBe("img-source-1");
    expect(restoredAttrs).toMatchObject({
      fileName: "diagram.png",
      mimeType: "image/png",
      size: imageBytes.byteLength,
    });

    expect(restored.content?.[0]).toEqual(content.content?.[0]);
    expect(restored.content?.[1]).toEqual(content.content?.[1]);
  });

  it("resolves hash-only images via the caller-supplied reader (chat / landing adapters)", async () => {
    const imageBytes = pngBytesOfSize(48);
    const hash = await sha256Hex(imageBytes);
    const content = richDoc({
      id: "img-hash-only",
      fileName: "paste.png",
      b64content: null,
      hash,
      mimeType: "image/png",
      size: imageBytes.byteLength,
    });

    const readHashImage = vi.fn((requested: string) => {
      expect(requested).toBe(hash);
      return Promise.resolve(imageBytes);
    });

    const snapshot = await buildPromptStashSnapshot({
      id: "entry-hash",
      createdAt: 10,
      content,
      readHashImage,
    });

    expect(readHashImage).toHaveBeenCalledWith(hash);
    expect(snapshot.imagesByHash.get(hash)).toEqual({
      bytes: imageBytes,
      mimeType: "image/png",
    });
    expect(snapshot.entry.blobHashes).toEqual([hash]);
    expect(findImageAttrs(snapshot.entry.content)).toMatchObject({
      hash,
      b64content: null,
      id: "img-hash-only",
      mimeType: "image/png",
      size: imageBytes.byteLength,
      fileName: "paste.png",
    });
  });

  it("resolves and prepares a duplicated inline source exactly once", async () => {
    const imageBytes = pngBytesOfSize(40);
    const b64 = bytesToBase64(imageBytes);
    const content = multiImageDoc([
      {
        id: "img-a",
        fileName: "dup-a.png",
        b64content: b64,
        hash: null,
        mimeType: "image/png",
        size: imageBytes.byteLength,
      },
      {
        id: "img-b",
        fileName: "dup-b.png",
        b64content: b64,
        hash: null,
        mimeType: "image/png",
        size: imageBytes.byteLength,
      },
    ]);

    const snapshot = await buildPromptStashSnapshot({
      id: "entry-dup",
      createdAt: 1,
      content,
      readHashImage: neverReadHash,
    });

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    const ownedHash = await sha256Hex(imageBytes);
    expect(snapshot.imagesByHash.size).toBe(1);
    expect(snapshot.imagesByHash.get(ownedHash)).toEqual({
      bytes: imageBytes,
      mimeType: "image/png",
    });
    expect(snapshot.entry.blobHashes).toEqual([ownedHash]);
    const attrs = findAllImageAttrs(snapshot.entry.content);
    expect(attrs).toHaveLength(2);
    expect(attrs[0]?.hash).toBe(ownedHash);
    expect(attrs[1]?.hash).toBe(ownedHash);
  });

  it("aborts the whole snapshot when a middle image is invalid and never yields blobs", async () => {
    const goodA = pngBytesOfSize(32);
    const goodC = jpegBytesOfSize(24);
    const badMiddle = jpegBytesOfSize(24);
    const content = multiImageDoc([
      {
        id: "img-1",
        fileName: "a.png",
        b64content: bytesToBase64(goodA),
        hash: null,
        mimeType: "image/png",
        size: goodA.byteLength,
      },
      {
        id: "img-2",
        fileName: "b.png",
        b64content: bytesToBase64(badMiddle),
        hash: null,
        mimeType: "image/png",
        size: badMiddle.byteLength,
      },
      {
        id: "img-3",
        fileName: "c.jpg",
        b64content: bytesToBase64(goodC),
        hash: null,
        mimeType: "image/jpeg",
        size: goodC.byteLength,
      },
    ]);

    await expect(
      buildPromptStashSnapshot({
        id: "entry-abort",
        createdAt: 1,
        content,
        readHashImage: missingHash,
      }),
    ).rejects.toThrow(/do not match its format/);

    expect(restoreBlobsMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "corrupt multi-frame GIF",
      () => structurallyAnimatedGifWithCorruptLzw(128),
      "image/gif",
      "corrupt.gif",
    ] as const,
    [
      "corrupt animated WebP",
      () => structurallyAnimatedWebpWithCorruptFrames(64),
      "image/webp",
      "corrupt.webp",
    ] as const,
  ])(
    "aborts the whole snapshot when a %s is codec-unreadable and never yields blobs",
    async (_label, build, mimeType, fileName) => {
      const good = pngBytesOfSize(32);
      const corrupt = build();
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        writable: true,
        value: vi.fn((source: ImageBitmapSource) => {
          // Reject only the animated fixture; static PNG still decodes.
          if (source instanceof Blob && source.type === mimeType) {
            return Promise.reject(new Error("codec unreadable animation"));
          }
          return Promise.resolve({
            width: 16,
            height: 16,
            close: () => undefined,
          });
        }),
      });
      const content = multiImageDoc([
        {
          id: "img-1",
          fileName: "a.png",
          b64content: bytesToBase64(good),
          hash: null,
          mimeType: "image/png",
          size: good.byteLength,
        },
        {
          id: "img-2",
          fileName,
          b64content: bytesToBase64(corrupt),
          hash: null,
          mimeType,
          size: corrupt.byteLength,
        },
      ]);

      await expect(
        buildPromptStashSnapshot({
          id: "entry-corrupt-anim",
          createdAt: 1,
          content,
          readHashImage: missingHash,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(PromptStashImagePreparationError);
        expect((error as Error).message).toMatch(/could not be decoded/);
        return true;
      });

      expect(restoreBlobsMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "readable multi-frame GIF",
      () => twoFrameGifBytesOfSize(96),
      "image/gif",
      "clip.gif",
    ] as const,
    [
      "readable animated WebP",
      () => animatedWebpBytesOfSize(48),
      "image/webp",
      "motion.webp",
    ] as const,
  ])(
    "keeps a %s byte-identical through capture after decode-validate",
    async (_label, build, mimeType, fileName) => {
      const imageBytes = build();
      const content = richDoc({
        id: "img-anim",
        fileName,
        b64content: bytesToBase64(imageBytes),
        hash: null,
        mimeType,
        size: imageBytes.byteLength,
      });

      const snapshot = await buildPromptStashSnapshot({
        id: "entry-anim",
        createdAt: 1,
        content,
        readHashImage: neverReadHash,
      });

      const ownedHash = await sha256Hex(imageBytes);
      expect(snapshot.imagesByHash.get(ownedHash)).toEqual({
        bytes: imageBytes,
        mimeType,
      });
      expect(findImageAttrs(snapshot.entry.content)).toMatchObject({
        fileName,
        mimeType,
        size: imageBytes.byteLength,
        hash: ownedHash,
        b64content: null,
      });
    },
  );

  it("aborts the whole snapshot when a middle image is over the 5 MB cap", async () => {
    const good = pngBytesOfSize(32);
    const huge = pngBytesOfSize(STATIC_MAX);
    const overCap = pngBytesOfSize(5 * 1024 * 1024 + 1);
    const content = multiImageDoc([
      {
        id: "img-1",
        fileName: "a.png",
        b64content: bytesToBase64(good),
        hash: null,
        mimeType: "image/png",
        size: good.byteLength,
      },
      {
        id: "img-2",
        fileName: "huge.png",
        b64content: bytesToBase64(overCap),
        hash: null,
        mimeType: "image/png",
        size: overCap.byteLength,
      },
      {
        id: "img-3",
        fileName: "c.png",
        b64content: bytesToBase64(huge),
        hash: null,
        mimeType: "image/png",
        size: huge.byteLength,
      },
    ]);

    await expect(
      buildPromptStashSnapshot({
        id: "entry-over",
        createdAt: 1,
        content,
        readHashImage: missingHash,
      }),
    ).rejects.toThrow(/5 MB limit/);
  });

  it("aborts snapshot build when any image cannot be resolved", async () => {
    const content = richDoc({
      id: "img-missing",
      fileName: "gone.png",
      b64content: null,
      hash: "missing-hash",
      mimeType: "image/png",
      size: 12,
    });

    await expect(
      buildPromptStashSnapshot({
        id: "entry-fail",
        createdAt: 1,
        content,
        readHashImage: missingHash,
      }),
    ).rejects.toThrow(/not available/);
  });

  it("aborts snapshot build when an image has neither inline bytes nor a hash", async () => {
    const content = richDoc({
      id: "img-empty",
      fileName: "empty.png",
      b64content: null,
      hash: null,
      mimeType: "image/png",
      size: null,
    });

    await expect(
      buildPromptStashSnapshot({
        id: "entry-empty",
        createdAt: 1,
        content,
        readHashImage: () => Promise.resolve(pngBytesOfSize(8)),
      }),
    ).rejects.toThrow(/no restorable payload/);
  });

  it("records canonical MIME, size, and filename extension on the stashed node", async () => {
    const imageBytes = pngBytesOfSize(64);
    const content = richDoc({
      id: "img-meta",
      fileName: "shot.JPEG",
      b64content: bytesToBase64(imageBytes),
      hash: null,
      mimeType: "image/png",
      size: 9999,
    });

    const snapshot = await buildPromptStashSnapshot({
      id: "entry-meta",
      createdAt: 1,
      content,
      readHashImage: missingHash,
    });

    expect(findImageAttrs(snapshot.entry.content)).toMatchObject({
      fileName: "shot.png",
      mimeType: "image/png",
      size: imageBytes.byteLength,
      b64content: null,
    });
  });

  it("aborts materialize when a stashed image blob is missing", async () => {
    const entry: PromptStashEntry = {
      id: "entry-orphan",
      createdAt: 1,
      blobHashes: ["deadbeef"],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "imageAttachment",
                attrs: {
                  id: "img-1",
                  fileName: "x.png",
                  hash: "deadbeef",
                  b64content: null,
                  mimeType: "image/png",
                  size: 1,
                },
              },
            ],
          },
        ],
      },
    };

    restoreBlobsMock.mockResolvedValueOnce({ status: "missing" });

    await expect(materializePromptStashEntry(entry)).rejects.toThrow(
      /missing from durable storage/,
    );
    expect(restoreBlobsMock).toHaveBeenCalledTimes(1);
    expect(restoreBlobsMock).toHaveBeenCalledWith(["deadbeef"]);
  });

  it("rejects materialize when image node metadata disagrees with the verified blob", async () => {
    const imageBytes = pngBytesOfSize(16);
    const hash = await sha256Hex(imageBytes);
    const entry: PromptStashEntry = {
      id: "entry-meta-mismatch",
      createdAt: 1,
      blobHashes: [hash],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "imageAttachment",
                attrs: {
                  id: "img-1",
                  fileName: "x.png",
                  hash,
                  b64content: null,
                  // Declared size lies; verified blob is imageBytes.byteLength.
                  mimeType: "image/png",
                  size: 99_999_999,
                },
              },
            ],
          },
        ],
      },
    };

    restoreBlobsMock.mockResolvedValueOnce(
      okRestoreBlobs([
        [
          hash,
          {
            bytes: imageBytes,
            byteLength: imageBytes.byteLength,
            mimeType: "image/png",
          },
        ],
      ]),
    );

    await expect(materializePromptStashEntry(entry)).rejects.toBeInstanceOf(
      PromptStashCorruptBlobError,
    );
    expect(restoreBlobsMock).toHaveBeenCalledTimes(1);
    expect(restoreBlobsMock).toHaveBeenCalledWith([hash]);
  });

  it("materialize reads all blobHashes in one restore-blob call", async () => {
    const bytesA = pngBytesOfSize(16);
    const bytesB = pngBytesOfSize(24);
    const hashA = await sha256Hex(bytesA);
    const hashB = await sha256Hex(bytesB);
    const entry: PromptStashEntry = {
      id: "entry-multi",
      createdAt: 1,
      blobHashes: [hashA, hashB],
      content: multiImageDoc([
        {
          id: "img-a",
          fileName: "a.png",
          hash: hashA,
          b64content: null,
          mimeType: "image/png",
          size: bytesA.byteLength,
        },
        {
          id: "img-b",
          fileName: "b.png",
          hash: hashB,
          b64content: null,
          mimeType: "image/png",
          size: bytesB.byteLength,
        },
      ]),
    };

    restoreBlobsMock.mockResolvedValueOnce(
      okRestoreBlobs([
        [
          hashA,
          {
            bytes: bytesA,
            byteLength: bytesA.byteLength,
            mimeType: "image/png",
          },
        ],
        [
          hashB,
          {
            bytes: bytesB,
            byteLength: bytesB.byteLength,
            mimeType: "image/png",
          },
        ],
      ]),
    );

    const restored = await materializePromptStashEntry(entry);
    expect(restoreBlobsMock).toHaveBeenCalledTimes(1);
    expect(restoreBlobsMock).toHaveBeenCalledWith([hashA, hashB]);
    const attrs = findAllImageAttrs(restored);
    expect(attrs).toHaveLength(2);
    expect(attrs[0]?.b64content).toBe(bytesToBase64(bytesA));
    expect(attrs[1]?.b64content).toBe(bytesToBase64(bytesB));
    expect(attrs[0]?.hash).toBeNull();
    expect(attrs[1]?.hash).toBeNull();
  });

  it("appendPromptStashContent replaces empty docs and appends into non-empty ones", () => {
    const empty: JsonContent = {
      type: "doc",
      content: [{ type: "paragraph" }],
    };
    const restored: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "restored" }],
        },
      ],
    };
    const current: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "current" }],
        },
        { type: "paragraph" },
      ],
    };

    expect(appendPromptStashContent(empty, restored)).toEqual(restored);
    expect(appendPromptStashContent(current, restored)).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "current" }],
        },
        { type: "paragraph" },
        {
          type: "paragraph",
          content: [{ type: "text", text: "restored" }],
        },
      ],
    });
    expect(
      collectImageAtoms(
        appendPromptStashContent(empty, {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "imageAttachment",
                  attrs: {
                    id: "i",
                    fileName: "a.png",
                    b64content: "YQ==",
                    hash: null,
                    mimeType: "image/png",
                    size: 1,
                  },
                },
              ],
            },
          ],
        }),
      ),
    ).toHaveLength(1);
  });
});
