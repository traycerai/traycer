/** prompt-stash-image-preparation animation/readability */
import { describe, expect, it, vi } from "vitest";

import {
  createPromptStashImagePreparationSession,
  PROMPT_STASH_IMAGE_MAX_BYTES,
} from "@/lib/composer/prompt-stash-image-preparation";
import {
  animatedWebpBytesOfSize,
  IMAGE_MAX,
  pngBytesOfSize,
  STATIC_MAX,
  structurallyAnimatedGifWithCorruptLzw,
  structurallyAnimatedWebpWithCorruptFrames,
  twoFrameGifBytesOfSize,
} from "./prompt-stash-image-fixtures";
import {
  emptyMockCodecOptions,
  makeDecoded,
  makeMockCodec,
  type DecodeArgs,
  type EncodeArgs,
} from "./prompt-stash-image-preparation-test-helpers";

describe("prompt-stash-image-preparation animation/readability", () => {
  describe("animation verbatim policy", () => {
    it("keeps animated WebP byte-identical through exactly 5 MiB after decode-validate", async () => {
      const bytes = animatedWebpBytesOfSize(PROMPT_STASH_IMAGE_MAX_BYTES);
      expect(bytes.byteLength).toBe(IMAGE_MAX);
      const close = vi.fn<() => void>(() => undefined);
      const { codec, encodeCalls, decode } = makeMockCodec({
        ...emptyMockCodecOptions(),
        close,
      });
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "motion.webp",
        declaredMimeType: "image/webp",
      });
      expect(prepared.bytes).toBe(bytes);
      expect(prepared.mimeType).toBe("image/webp");
      expect(prepared.byteLength).toBe(bytes.byteLength);
      expect(decode).toHaveBeenCalledTimes(1);
      expect(decode).toHaveBeenCalledWith({
        bytes,
        mimeType: "image/webp",
      });
      expect(encodeCalls).toHaveLength(0);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("rejects animated WebP above 5 MiB", async () => {
      const bytes = new Uint8Array(PROMPT_STASH_IMAGE_MAX_BYTES + 1);
      bytes.set(
        [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
        0,
      );
      const { codec } = makeMockCodec(emptyMockCodecOptions());
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes,
          fileName: "huge.webp",
          declaredMimeType: "image/webp",
        }),
      ).rejects.toThrow(/5 MB limit/);
    });

    it.each([
      [
        "structurally parseable multi-frame GIF with corrupt LZW",
        () => structurallyAnimatedGifWithCorruptLzw(128),
        "image/gif",
        "corrupt.gif",
      ] as const,
      [
        "structurally parseable animated WebP with corrupt frames",
        () => structurallyAnimatedWebpWithCorruptFrames(64),
        "image/webp",
        "corrupt.webp",
      ] as const,
    ])(
      "rejects %s without returning original bytes and without closing a never-yielded decode",
      async (_label, build, mimeType, fileName) => {
        const bytes = build();
        const close = vi.fn<() => void>(() => undefined);
        const { codec, encodeCalls, decode } = makeMockCodec({
          ...emptyMockCodecOptions(),
          close,
          decode: (_args: DecodeArgs) =>
            Promise.reject(new Error("codec unreadable animation")),
        });
        const session = createPromptStashImagePreparationSession(codec);
        await expect(
          session.prepare({
            bytes,
            fileName,
            declaredMimeType: mimeType,
          }),
        ).rejects.toThrow(/could not be decoded/);
        expect(decode).toHaveBeenCalledTimes(1);
        expect(decode).toHaveBeenCalledWith({
          bytes,
          mimeType,
        });
        expect(encodeCalls).toHaveLength(0);
        // Decode never produced a resource; close must not be expected/leaked.
        expect(close).not.toHaveBeenCalled();
      },
    );

    it("rejects invalid decoded dimensions on animation and closes the decoded handle", async () => {
      const bytes = twoFrameGifBytesOfSize(96);
      const close = vi.fn<() => void>(() => undefined);
      const { codec, encodeCalls, decode } = makeMockCodec({
        ...emptyMockCodecOptions(),
        decode: (_args: DecodeArgs) =>
          Promise.resolve(makeDecoded(0, 100, close)),
      });
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes,
          fileName: "bad-dims.gif",
          declaredMimeType: "image/gif",
        }),
      ).rejects.toThrow(/invalid dimensions/);
      expect(decode).toHaveBeenCalledTimes(1);
      expect(encodeCalls).toHaveLength(0);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
  describe("validation", () => {
    it("rejects empty images", async () => {
      const { codec } = makeMockCodec(emptyMockCodecOptions());
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes: new Uint8Array(0),
          fileName: "empty.png",
          declaredMimeType: "image/png",
        }),
      ).rejects.toThrow(/empty/);
    });

    it("rejects non-image MIME types", async () => {
      const { codec } = makeMockCodec(emptyMockCodecOptions());
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes: pngBytesOfSize(32),
          fileName: "x.bin",
          declaredMimeType: "application/octet-stream",
        }),
      ).rejects.toThrow(/not an image/);
    });

    it("rejects unsupported image formats", async () => {
      const { codec } = makeMockCodec(emptyMockCodecOptions());
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes: pngBytesOfSize(32),
          fileName: "x.svg",
          declaredMimeType: "image/svg+xml",
        }),
      ).rejects.toThrow(/unsupported format/);
    });

    it("rejects MIME vs magic-byte mismatches", async () => {
      const { codec } = makeMockCodec(emptyMockCodecOptions());
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes: pngBytesOfSize(32),
          fileName: "lie.jpg",
          declaredMimeType: "image/jpeg",
        }),
      ).rejects.toThrow(/do not match its format/);
    });

    it("rejects invalid GIF structure under the size cap", async () => {
      const bytes = new Uint8Array(64);
      bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
      const { codec } = makeMockCodec(emptyMockCodecOptions());
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes,
          fileName: "bad.gif",
          declaredMimeType: "image/gif",
        }),
      ).rejects.toThrow(/invalid image data/);
    });

    it("rejects invalid WebP structure under the size cap", async () => {
      const bytes = new Uint8Array(24);
      bytes.set(
        [0x52, 0x49, 0x46, 0x46, 16, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
        0,
      );
      const { codec } = makeMockCodec(emptyMockCodecOptions());
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes,
          fileName: "bad.webp",
          declaredMimeType: "image/webp",
        }),
      ).rejects.toThrow(/invalid image data/);
    });

    it("rejects unreadable/undecodable static images", async () => {
      const bytes = pngBytesOfSize(STATIC_MAX + 1);
      const { codec } = makeMockCodec({
        ...emptyMockCodecOptions(),
        decode: (_args: DecodeArgs) => Promise.reject(new Error("decode boom")),
      });
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes,
          fileName: "broken.png",
          declaredMimeType: "image/png",
        }),
      ).rejects.toThrow(/could not be decoded/);
    });

    it("rejects invalid decoded dimensions and closes the bitmap", async () => {
      const bytes = pngBytesOfSize(STATIC_MAX + 1);
      const close = vi.fn<() => void>(() => undefined);
      const { codec } = makeMockCodec({
        ...emptyMockCodecOptions(),
        decode: (_args: DecodeArgs) =>
          Promise.resolve(makeDecoded(0, 0, close)),
      });
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes,
          fileName: "zero.png",
          declaredMimeType: "image/png",
        }),
      ).rejects.toThrow(/invalid dimensions/);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("rejects when the ladder cannot produce an acceptable payload and closes", async () => {
      const bytes = pngBytesOfSize(STATIC_MAX + 1);
      const close = vi.fn<() => void>(() => undefined);
      const { codec } = makeMockCodec({
        ...emptyMockCodecOptions(),
        close,
        encode: (_args: EncodeArgs) => Promise.resolve(null),
      });
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes,
          fileName: "unfit.png",
          declaredMimeType: "image/png",
        }),
      ).rejects.toThrow(/could not be compressed enough/);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
