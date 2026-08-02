/** prompt-stash-image-preparation static codecs/compression */
import { describe, expect, it, vi } from "vitest";

import {
  canonicalPromptStashImageFileName,
  createPromptStashImagePreparationSession,
  PROMPT_STASH_IMAGE_MAX_BYTES,
  PROMPT_STASH_STATIC_IMAGE_MAX_BYTES,
} from "@/lib/composer/prompt-stash-image-preparation";
import {
  encodedJpegBytesOfSize,
  encodedWebpBytesOfSize,
  IMAGE_MAX,
  jpegBytesOfSize,
  pngBytesOfSize,
  singleFrameGifBytesOfSize,
  STATIC_MAX,
  staticWebpBytesOfSize,
  twoFrameGifBytesOfSize,
} from "./prompt-stash-image-fixtures";
import {
  emptyMockCodecOptions,
  makeMockCodec,
  type EncodeArgs,
} from "./prompt-stash-image-preparation-test-helpers";

describe("prompt-stash-image-preparation static codecs/compression", () => {
  describe("canonicalPromptStashImageFileName", () => {
    it("rewrites a mismatched extension to the canonical codec extension", () => {
      expect(
        canonicalPromptStashImageFileName("screenshot.png", "image/webp"),
      ).toBe("screenshot.webp");
      expect(canonicalPromptStashImageFileName("shot.PNG", "image/jpeg")).toBe(
        "shot.jpg",
      );
      expect(canonicalPromptStashImageFileName("anim.webp", "image/gif")).toBe(
        "anim.gif",
      );
    });

    it("preserves directory prefixes and falls back to image.<ext>", () => {
      expect(
        canonicalPromptStashImageFileName("dir/sub/photo.jpeg", "image/png"),
      ).toBe("dir/sub/photo.png");
      expect(canonicalPromptStashImageFileName("", "image/png")).toBe(
        "image.png",
      );
      expect(canonicalPromptStashImageFileName("   ", "image/webp")).toBe(
        "image.webp",
      );
    });
  });
  describe("verbatim static images", () => {
    it.each([
      ["image/png", () => pngBytesOfSize(32)] as const,
      ["image/jpeg", () => jpegBytesOfSize(24)] as const,
      ["image/webp", () => staticWebpBytesOfSize(28)] as const,
    ])(
      "keeps valid %s under the static threshold byte-identical",
      async (mimeType, build) => {
        const bytes = build();
        const close = vi.fn<() => void>(() => undefined);
        const { codec } = makeMockCodec({
          ...emptyMockCodecOptions(),
          close,
        });
        const session = createPromptStashImagePreparationSession(codec);
        const prepared = await session.prepare({
          bytes,
          fileName: `photo.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice(6)}`,
          declaredMimeType: mimeType,
        });
        expect(prepared.bytes).toBe(bytes);
        expect(prepared.byteLength).toBe(bytes.byteLength);
        expect(prepared.mimeType).toBe(mimeType);
        expect(close).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps a static image at exactly 975 KiB verbatim", async () => {
      const bytes = pngBytesOfSize(PROMPT_STASH_STATIC_IMAGE_MAX_BYTES);
      expect(bytes.byteLength).toBe(STATIC_MAX);
      const { codec, encodeCalls, close } = makeMockCodec(
        emptyMockCodecOptions(),
      );
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "edge.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.bytes).toBe(bytes);
      expect(prepared.byteLength).toBe(STATIC_MAX);
      expect(encodeCalls).toHaveLength(0);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("compresses a static image one byte over the 975 KiB threshold", async () => {
      const bytes = pngBytesOfSize(PROMPT_STASH_STATIC_IMAGE_MAX_BYTES + 1);
      const compressed = encodedWebpBytesOfSize(128);
      const { codec, encodeCalls, close } = makeMockCodec({
        ...emptyMockCodecOptions(),
        encode: (_args: EncodeArgs) => Promise.resolve(compressed),
      });
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "oversized.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.bytes).toBe(compressed);
      expect(prepared.mimeType).toBe("image/webp");
      expect(prepared.fileName).toBe("oversized.webp");
      expect(prepared.byteLength).toBe(compressed.byteLength);
      expect(encodeCalls.length).toBeGreaterThan(0);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
  describe("GIF single-frame vs multi-frame policy", () => {
    it("keeps a one-frame GIF at or below 975 KiB byte-identical after decode", async () => {
      const bytes = singleFrameGifBytesOfSize(STATIC_MAX);
      expect(bytes.byteLength).toBe(STATIC_MAX);
      const close = vi.fn<() => void>(() => undefined);
      const { codec, encodeCalls, decode } = makeMockCodec({
        ...emptyMockCodecOptions(),
        close,
      });
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "still.gif",
        declaredMimeType: "image/gif",
      });
      expect(prepared.bytes).toBe(bytes);
      expect(prepared.mimeType).toBe("image/gif");
      expect(prepared.fileName).toBe("still.gif");
      expect(decode).toHaveBeenCalledTimes(1);
      expect(encodeCalls).toHaveLength(0);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("decodes and compresses a one-frame GIF one byte above the static threshold", async () => {
      const bytes = singleFrameGifBytesOfSize(STATIC_MAX + 1);
      const compressed = encodedWebpBytesOfSize(96);
      const close = vi.fn<() => void>(() => undefined);
      const { codec, encodeCalls, decode } = makeMockCodec({
        ...emptyMockCodecOptions(),
        close,
        encode: (_args: EncodeArgs) => Promise.resolve(compressed),
      });
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "big-still.gif",
        declaredMimeType: "image/gif",
      });
      expect(decode).toHaveBeenCalledTimes(1);
      expect(encodeCalls.length).toBeGreaterThan(0);
      expect(prepared.bytes).toBe(compressed);
      expect(prepared.mimeType).toBe("image/webp");
      expect(prepared.fileName).toBe("big-still.webp");
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("keeps a two-frame GIF byte-identical through exactly 5 MiB after decode-validate", async () => {
      const bytes = twoFrameGifBytesOfSize(PROMPT_STASH_IMAGE_MAX_BYTES);
      expect(bytes.byteLength).toBe(IMAGE_MAX);
      const close = vi.fn<() => void>(() => undefined);
      const { codec, encodeCalls, decode } = makeMockCodec({
        ...emptyMockCodecOptions(),
        close,
      });
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "clip.gif",
        declaredMimeType: "image/gif",
      });
      expect(prepared.bytes).toBe(bytes);
      expect(prepared.mimeType).toBe("image/gif");
      expect(prepared.fileName).toBe("clip.gif");
      expect(prepared.byteLength).toBe(bytes.byteLength);
      expect(decode).toHaveBeenCalledTimes(1);
      expect(decode).toHaveBeenCalledWith({
        bytes,
        mimeType: "image/gif",
      });
      expect(encodeCalls).toHaveLength(0);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("rejects GIF above 5 MiB before structure work", async () => {
      const bytes = new Uint8Array(PROMPT_STASH_IMAGE_MAX_BYTES + 1);
      bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
      const { codec } = makeMockCodec(emptyMockCodecOptions());
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes,
          fileName: "huge.gif",
          declaredMimeType: "image/gif",
        }),
      ).rejects.toThrow(/5 MB limit/);
    });
  });
  describe("compression ladder (mocked codec)", () => {
    it("bounds longest edge to 2048 before quality/scale stepping", async () => {
      const bytes = pngBytesOfSize(STATIC_MAX + 1);
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        width: 4096,
        height: 2160,
        encode: (_args: EncodeArgs) =>
          Promise.resolve(encodedWebpBytesOfSize(100)),
      });
      const session = createPromptStashImagePreparationSession(codec);
      await session.prepare({
        bytes,
        fileName: "wide.png",
        declaredMimeType: "image/png",
      });
      expect(encodeCalls.length).toBeGreaterThan(0);
      const first = encodeCalls.at(0);
      if (first === undefined) {
        throw new Error("expected at least one encode call");
      }
      // 4096×2160 → scale 2048/4096 = 0.5 → 2048×1080 at scale 1
      expect(first.width).toBe(2048);
      expect(first.height).toBe(1080);
    });

    it("walks qualities .92/.85/.78/.68 then scales 1/.75/.55 for WebP then JPEG", async () => {
      const bytes = pngBytesOfSize(STATIC_MAX + 1);
      const qualities = [0.92, 0.85, 0.78, 0.68] as const;
      let call = 0;
      const totalWebP = 3 * 4;
      const totalJpeg = 3 * 4;
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        width: 1000,
        height: 800,
        encode: (args: EncodeArgs) => {
          call += 1;
          const oversized = encodedWebpBytesOfSize(STATIC_MAX + 50);
          const jpegOver = encodedJpegBytesOfSize(STATIC_MAX + 50);
          if (call === totalWebP + totalJpeg) {
            return Promise.resolve(encodedJpegBytesOfSize(200));
          }
          return Promise.resolve(
            args.mimeType === "image/webp" ? oversized : jpegOver,
          );
        },
      });
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "ladder.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.mimeType).toBe("image/jpeg");
      expect(prepared.fileName).toBe("ladder.jpg");
      expect(encodeCalls).toHaveLength(totalWebP + totalJpeg);

      for (let i = 0; i < totalWebP; i += 1) {
        const entry = encodeCalls.at(i);
        if (entry === undefined) throw new Error(`missing encode call ${i}`);
        expect(entry.mimeType).toBe("image/webp");
        expect(entry.whiteMatte).toBe(false);
        expect(entry.quality).toBe(qualities[i % 4]);
      }
      for (let i = totalWebP; i < totalWebP + totalJpeg; i += 1) {
        const entry = encodeCalls.at(i);
        if (entry === undefined) throw new Error(`missing encode call ${i}`);
        expect(entry.mimeType).toBe("image/jpeg");
        expect(entry.whiteMatte).toBe(true);
        expect(entry.quality).toBe(qualities[(i - totalWebP) % 4]);
      }

      const expectedSizes = [
        { w: 1000, h: 800 },
        { w: 750, h: 600 },
        { w: 550, h: 440 },
      ] as const;
      for (let scaleIndex = 0; scaleIndex < 3; scaleIndex += 1) {
        const expected = expectedSizes[scaleIndex];
        for (let q = 0; q < 4; q += 1) {
          const webpCall = encodeCalls.at(scaleIndex * 4 + q);
          if (webpCall === undefined) {
            throw new Error(`missing webp call ${scaleIndex}/${q}`);
          }
          expect(webpCall.width).toBe(expected.w);
          expect(webpCall.height).toBe(expected.h);
        }
      }
    });

    it("skips WebP and uses JPEG white-matte when WebP is unsupported", async () => {
      const bytes = pngBytesOfSize(STATIC_MAX + 1);
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        supportsWebP: false,
        encode: (_args: EncodeArgs) =>
          Promise.resolve(encodedJpegBytesOfSize(80)),
      });
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "alpha.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.mimeType).toBe("image/jpeg");
      expect(encodeCalls.every((c) => c.mimeType === "image/jpeg")).toBe(true);
      expect(encodeCalls.every((c) => c.whiteMatte)).toBe(true);
      const first = encodeCalls.at(0);
      if (first === undefined) throw new Error("expected encode call");
      expect(first.quality).toBe(0.92);
    });

    it("falls through WebP to JPEG white-matte when WebP encodes return null", async () => {
      const bytes = pngBytesOfSize(STATIC_MAX + 1);
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        supportsWebP: true,
        encode: (args: EncodeArgs) => {
          if (args.mimeType === "image/webp") return Promise.resolve(null);
          return Promise.resolve(encodedJpegBytesOfSize(90));
        },
      });
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "fallback.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.mimeType).toBe("image/jpeg");
      expect(encodeCalls.some((c) => c.mimeType === "image/webp")).toBe(true);
      expect(
        encodeCalls.some((c) => c.mimeType === "image/jpeg" && c.whiteMatte),
      ).toBe(true);
    });

    it("continues through throwing WebP attempts and falls through to successful JPEG", async () => {
      const bytes = pngBytesOfSize(STATIC_MAX + 1);
      let webPThrows = 0;
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        supportsWebP: true,
        encode: (args: EncodeArgs) => {
          if (args.mimeType === "image/webp") {
            webPThrows += 1;
            return Promise.reject(new Error("webp encode failed"));
          }
          return Promise.resolve(encodedJpegBytesOfSize(88));
        },
      });
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "throw-webp.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.mimeType).toBe("image/jpeg");
      expect(webPThrows).toBe(12);
      expect(
        encodeCalls.filter((c) => c.mimeType === "image/webp"),
      ).toHaveLength(12);
      expect(encodeCalls.some((c) => c.mimeType === "image/jpeg")).toBe(true);
    });

    it("rejects only after the full WebP+JPEG ladder when every attempt throws, and closes", async () => {
      const bytes = pngBytesOfSize(STATIC_MAX + 1);
      const close = vi.fn<() => void>(() => undefined);
      let attempts = 0;
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        close,
        supportsWebP: true,
        encode: (_args: EncodeArgs) => {
          attempts += 1;
          return Promise.reject(new Error(`encode fail #${attempts}`));
        },
      });
      const session = createPromptStashImagePreparationSession(codec);
      await expect(
        session.prepare({
          bytes,
          fileName: "all-throw.png",
          declaredMimeType: "image/png",
        }),
      ).rejects.toThrow(/could not be compressed enough/);
      // 3 scales × 4 qualities × 2 codecs
      expect(attempts).toBe(24);
      expect(encodeCalls).toHaveLength(24);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("probes WebP support once per capture session across images", async () => {
      const bytesA = pngBytesOfSize(STATIC_MAX + 1);
      const bytesB = pngBytesOfSize(STATIC_MAX + 2);
      const { codec, supportsWebP } = makeMockCodec({
        ...emptyMockCodecOptions(),
        encode: (_args: EncodeArgs) =>
          Promise.resolve(encodedWebpBytesOfSize(64)),
      });
      const session = createPromptStashImagePreparationSession(codec);
      await session.prepare({
        bytes: bytesA,
        fileName: "a.png",
        declaredMimeType: "image/png",
      });
      await session.prepare({
        bytes: bytesB,
        fileName: "b.png",
        declaredMimeType: "image/png",
      });
      expect(supportsWebP).toHaveBeenCalledTimes(1);
    });

    it("skips encode candidates whose magic bytes do not match the codec", async () => {
      const bytes = pngBytesOfSize(STATIC_MAX + 1);
      let call = 0;
      const { codec } = makeMockCodec({
        ...emptyMockCodecOptions(),
        encode: (args: EncodeArgs) => {
          call += 1;
          if (call === 1 && args.mimeType === "image/webp") {
            return Promise.resolve(encodedJpegBytesOfSize(40));
          }
          if (args.mimeType === "image/webp") {
            return Promise.resolve(encodedWebpBytesOfSize(50));
          }
          return Promise.resolve(encodedJpegBytesOfSize(50));
        },
      });
      const session = createPromptStashImagePreparationSession(codec);
      const prepared = await session.prepare({
        bytes,
        fileName: "sniff.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.mimeType).toBe("image/webp");
      expect(call).toBeGreaterThan(1);
    });
  });
  it("pins the static and total prompt-stash image byte limits", () => {
    expect(PROMPT_STASH_STATIC_IMAGE_MAX_BYTES).toBe(975 * 1024);
    expect(PROMPT_STASH_IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});
