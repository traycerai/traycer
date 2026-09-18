/** composer image-preparation: animation verbatim policy and readability validation */
import { describe, expect, it, vi } from "vitest";

import {
  createImagePreparationSession,
  ImageTooLargeError,
  PREPARED_IMAGE_MAX_BYTES,
  PREPARED_IMAGE_POLICY,
  type PreparationPolicy,
} from "@/lib/composer/composer-image-preparation-session";
import {
  animatedWebpBytesOfSize,
  pngBytesOfSize,
  STATIC_MAX,
  structurallyAnimatedGifWithCorruptLzw,
  structurallyAnimatedWebpWithCorruptFrames,
  twoFrameGifBytesOfSize,
} from "./composer-image-preparation-fixtures";
import {
  emptyMockCodecOptions,
  makeDecoded,
  makeMockCodec,
  SPLIT_CEILING_TEST_POLICY,
  type DecodeArgs,
  type EncodeArgs,
} from "./composer-image-preparation-test-helpers";

/**
 * A split policy sized for SPEED, used only by the two boundary cases below.
 *
 * `animatedWebpBytesOfSize` builds a real byte array, so driving these at the
 * shared fixture's 5 MiB animation ceiling cost ~20 s per case and timed out
 * under parallel load - a flake CI would hit on a contended shard, not a
 * defect. The claim being tested is the RELATIONSHIP between the ceilings
 * (`byteCeiling` < `animationCeiling`, and a source ceiling an animation can
 * exceed), which is scale-free, so the same shape two orders of magnitude
 * smaller proves exactly as much.
 *
 * `SPLIT_CEILING_TEST_POLICY` keeps its own numbers because
 * `composer-image-preparation-static.test.ts` pins them; this is deliberately a
 * second, local fixture rather than a change to that shared one.
 */
const FAST_SPLIT_POLICY: PreparationPolicy = {
  sourceCeiling: 256 * 1024,
  maxLongestEdge: 2048,
  byteCeiling: 64 * 1024,
  animationCeiling: 256 * 1024,
};

describe("composer image preparation: animation and readability validation", () => {
  describe("animation verbatim policy (split-ceiling fixture)", () => {
    it("keeps animated WebP byte-identical exactly at the animation ceiling", async () => {
      const bytes = animatedWebpBytesOfSize(FAST_SPLIT_POLICY.animationCeiling);
      expect(bytes.byteLength).toBe(FAST_SPLIT_POLICY.animationCeiling);
      const close = vi.fn<() => void>(() => undefined);
      const { codec, encodeCalls, decode } = makeMockCodec({
        ...emptyMockCodecOptions(),
        close,
      });
      const session = createImagePreparationSession({
        policy: FAST_SPLIT_POLICY,
        codec,
      });
      const prepared = await session.prepare({
        bytes,
        fileName: "motion.webp",
        declaredMimeType: "image/webp",
      });
      expect(prepared.step).toBe("animated-verbatim");
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

    it("rejects animated WebP above the animation ceiling", async () => {
      // This policy's source ceiling equals its animation ceiling, so going
      // over trips the source-ceiling check first - the same boundary the
      // deleted test asserted against.
      //
      // Asserted on the ERROR TYPE rather than the message. `ImageTooLargeError`
      // is what a paste surface actually branches on (it picks "too large even
      // after resizing" over "couldn't attach the image"), while the message
      // interpolates `Math.round(ceiling / 1MiB)` and so says "0 MB" at any
      // sub-megabyte ceiling. Pinning that wording would pin the arithmetic, not
      // the refusal.
      const bytes = animatedWebpBytesOfSize(
        FAST_SPLIT_POLICY.animationCeiling + 2,
      );
      const { codec } = makeMockCodec(emptyMockCodecOptions());
      const session = createImagePreparationSession({
        policy: FAST_SPLIT_POLICY,
        codec,
      });
      await expect(
        session.prepare({
          bytes,
          fileName: "huge.webp",
          declaredMimeType: "image/webp",
        }),
      ).rejects.toThrow(ImageTooLargeError);
    });

    // The sniff-only path never takes an animation, so a decode that never
    // yields a handle must never be closed either — otherwise a real animated
    // GIF/WebP that a decoder genuinely rejects would look "cleaned up" while
    // nothing was ever allocated.
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
        const session = createImagePreparationSession({
          policy: SPLIT_CEILING_TEST_POLICY,
          codec,
        });
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
      const session = createImagePreparationSession({
        policy: SPLIT_CEILING_TEST_POLICY,
        codec,
      });
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
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
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
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
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
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
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
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
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
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
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
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
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
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
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
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
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
      // Sized over PREPARED_IMAGE_POLICY's own byte ceiling (unlike the other
      // validation cases here, this one needs the verbatim-sniff shortcut to
      // genuinely miss so the ladder actually runs) with no readable header,
      // so it also skips the sniff-only path and always reaches decode.
      const bytes = pngBytesOfSize(PREPARED_IMAGE_MAX_BYTES + 1);
      const close = vi.fn<() => void>(() => undefined);
      const { codec } = makeMockCodec({
        ...emptyMockCodecOptions(),
        close,
        encode: (_args: EncodeArgs) => Promise.resolve(null),
      });
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
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
