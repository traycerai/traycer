/**
 * Size matrix for the UNIVERSAL policy (`PREPARED_IMAGE_POLICY`): every
 * composer paste/drop surface prepares against this policy, so the ceilings
 * here (2000 px edge, 3.75 MiB output) are what a real paste actually sees —
 * distinct from the split-ceiling fixture policy covered in
 * `composer-image-preparation-static.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createImagePreparationSession,
  PREPARED_IMAGE_MAX_BYTES,
  PREPARED_IMAGE_SOURCE_CEILING,
  PREPARED_IMAGE_POLICY,
  ImageTooLargeError,
} from "@/lib/composer/composer-image-preparation-session";
import {
  encodedJpegBytesOfSize,
  encodedPngBytesOfSize,
  encodedWebpBytesOfSize,
  jpegBytesOfSize,
  pngBytesOfSize,
  pngBytesWithHeader,
  twoFrameGifBytesOfSize,
} from "./composer-image-preparation-fixtures";
import {
  emptyMockCodecOptions,
  makeMockCodec,
  type EncodeArgs,
} from "./composer-image-preparation-test-helpers";

describe("prepared-image policy matrix (universal composer policy)", () => {
  describe("verbatim sniff path (no decode)", () => {
    it("200×200 PNG, small: verbatim, no decode, no encode", async () => {
      const bytes = pngBytesWithHeader(200, 200, 2_000);
      const { codec, decode, encode } = makeMockCodec(emptyMockCodecOptions());
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
      const prepared = await session.prepare({
        bytes,
        fileName: "small.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.step).toBe("verbatim");
      expect(prepared.bytes).toBe(bytes);
      expect(prepared.mimeType).toBe("image/png");
      expect(decode).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
    });

    it("1920×1080 PNG, 2 MB: within the edge and under the ceiling, verbatim, no decode", async () => {
      const bytes = pngBytesWithHeader(1920, 1080, 2 * 1024 * 1024);
      const { codec, decode, encode } = makeMockCodec(emptyMockCodecOptions());
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
      const prepared = await session.prepare({
        bytes,
        fileName: "hd.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.step).toBe("verbatim");
      expect(decode).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
    });
  });

  describe("source-family attempt when a scale is needed", () => {
    it("3840×2160 PNG, 9 MB: scales to 2000×1125, PNG source-family attempt tried once and fits", async () => {
      const bytes = pngBytesOfSize(9 * 1024 * 1024);
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        width: 3840,
        height: 2160,
        encode: (args: EncodeArgs) => {
          if (args.mimeType === "image/png") {
            return Promise.resolve(encodedPngBytesOfSize(3_000_000));
          }
          return Promise.resolve(encodedWebpBytesOfSize(3_000_000));
        },
      });
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
      const prepared = await session.prepare({
        bytes,
        fileName: "screenshot.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.step).toBe("source-family");
      expect(prepared.mimeType).toBe("image/png");
      const pngCalls = encodeCalls.filter((c) => c.mimeType === "image/png");
      expect(pngCalls).toHaveLength(1);
      expect(pngCalls[0]).toMatchObject({
        width: 2000,
        height: 1125,
        quality: 1,
        whiteMatte: false,
      });
    });

    it("3840×2160 PNG, 9 MB, PNG attempt over the ceiling: falls into the ladder, first call is WebP q0.92 at 2000×1125", async () => {
      const bytes = pngBytesOfSize(9 * 1024 * 1024);
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        width: 3840,
        height: 2160,
        encode: (args: EncodeArgs) => {
          if (args.mimeType === "image/png") {
            return Promise.resolve(
              encodedPngBytesOfSize(PREPARED_IMAGE_MAX_BYTES + 1),
            );
          }
          return Promise.resolve(encodedWebpBytesOfSize(1_000_000));
        },
      });
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
      const prepared = await session.prepare({
        bytes,
        fileName: "screenshot.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.step).toBe("recompressed");
      expect(encodeCalls[0]).toMatchObject({ mimeType: "image/png" });
      const ladderFirst = encodeCalls[1];
      expect(ladderFirst).toBeDefined();
      expect(ladderFirst).toMatchObject({
        mimeType: "image/webp",
        quality: 0.92,
        width: 2000,
        height: 1125,
      });
    });

    it("6000×4000 JPEG, 12 MB: scales to 2000×1333, JPEG source-family attempt at q0.92 white-matte", async () => {
      const bytes = jpegBytesOfSize(12 * 1024 * 1024);
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        width: 6000,
        height: 4000,
        encode: (args: EncodeArgs) => {
          if (args.mimeType === "image/jpeg") {
            return Promise.resolve(encodedJpegBytesOfSize(2_000_000));
          }
          return Promise.resolve(encodedWebpBytesOfSize(2_000_000));
        },
      });
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
      const prepared = await session.prepare({
        bytes,
        fileName: "photo.jpg",
        declaredMimeType: "image/jpeg",
      });
      expect(prepared.step).toBe("source-family");
      expect(prepared.mimeType).toBe("image/jpeg");
      const jpegCalls = encodeCalls.filter((c) => c.mimeType === "image/jpeg");
      expect(jpegCalls).toHaveLength(1);
      expect(jpegCalls[0]).toMatchObject({
        width: 2000,
        height: 1333,
        quality: 0.92,
        whiteMatte: true,
      });
    });
  });

  describe("no scale needed skips the source-family attempt entirely", () => {
    it("2000×2000 PNG, 4.5 MB (fits the edge, over the ceiling): no scale, no source-family attempt, straight into the ladder at 2000×2000", async () => {
      const bytes = pngBytesOfSize(4.5 * 1024 * 1024);
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        width: 2000,
        height: 2000,
        encode: (_args: EncodeArgs) =>
          Promise.resolve(encodedWebpBytesOfSize(1_000_000)),
      });
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
      const prepared = await session.prepare({
        bytes,
        fileName: "square.png",
        declaredMimeType: "image/png",
      });
      expect(encodeCalls.some((c) => c.mimeType === "image/png")).toBe(false);
      expect(prepared.step).toBe("recompressed");
      expect(encodeCalls[0]).toMatchObject({
        mimeType: "image/webp",
        width: 2000,
        height: 2000,
        quality: 0.92,
      });
    });
  });

  describe("animation policy", () => {
    it("animated GIF 1 MB: animated-verbatim, decode called once, zero encodes", async () => {
      const bytes = twoFrameGifBytesOfSize(1 * 1024 * 1024);
      const { codec, decode, encodeCalls } = makeMockCodec(
        emptyMockCodecOptions(),
      );
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
      const prepared = await session.prepare({
        bytes,
        fileName: "clip.gif",
        declaredMimeType: "image/gif",
      });
      expect(prepared.step).toBe("animated-verbatim");
      expect(decode).toHaveBeenCalledTimes(1);
      expect(encodeCalls).toHaveLength(0);
    });

    it("animated GIF 6 MB: rejects as ImageTooLargeError (over the animation ceiling)", async () => {
      const bytes = twoFrameGifBytesOfSize(6 * 1024 * 1024);
      const { codec } = makeMockCodec(emptyMockCodecOptions());
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
      await expect(
        session.prepare({
          bytes,
          fileName: "big-clip.gif",
          declaredMimeType: "image/gif",
        }),
      ).rejects.toThrow(ImageTooLargeError);
    });
  });

  describe("source ceiling", () => {
    it("a 60 MB source rejects before decode is called and before any structure parse", async () => {
      const bytes = new Uint8Array(PREPARED_IMAGE_SOURCE_CEILING + 1);
      const { codec, decode } = makeMockCodec(emptyMockCodecOptions());
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
      await expect(
        session.prepare({
          bytes,
          fileName: "huge.png",
          declaredMimeType: "image/png",
        }),
      ).rejects.toThrow(ImageTooLargeError);
      expect(decode).not.toHaveBeenCalled();
    });
  });

  describe("ladder order", () => {
    it("walks the full 24-call quality-outer/scale-inner order: WebP 12 then JPEG 12", async () => {
      const bytes = pngBytesOfSize(PREPARED_IMAGE_MAX_BYTES + 1);
      const qualities = [0.92, 0.85, 0.78, 0.68] as const;
      const { codec, encodeCalls } = makeMockCodec({
        ...emptyMockCodecOptions(),
        width: 1000,
        height: 800,
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
      ).rejects.toThrow(ImageTooLargeError);

      expect(encodeCalls).toHaveLength(24);
      for (let i = 0; i < 12; i += 1) {
        expect(encodeCalls[i]?.mimeType).toBe("image/webp");
        expect(encodeCalls[i]?.quality).toBe(qualities[Math.floor(i / 3)]);
      }
      for (let i = 12; i < 24; i += 1) {
        expect(encodeCalls[i]?.mimeType).toBe("image/jpeg");
        expect(encodeCalls[i]?.quality).toBe(
          qualities[Math.floor((i - 12) / 3)],
        );
      }
    });
  });
});

describe("codec-spy suite: sniff/source-family bookkeeping", () => {
  it("the sniff-only path allocates no bitmap: decode and close are never called", async () => {
    const bytes = pngBytesWithHeader(1200, 800, 500_000);
    const close = vi.fn<() => void>(() => undefined);
    const { codec, decode } = makeMockCodec({
      ...emptyMockCodecOptions(),
      close,
    });
    const session = createImagePreparationSession({
      policy: PREPARED_IMAGE_POLICY,
      codec,
    });
    const prepared = await session.prepare({
      bytes,
      fileName: "shot.png",
      declaredMimeType: "image/png",
    });
    expect(prepared.step).toBe("verbatim");
    expect(decode).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("the PNG source-family attempt runs at most once, even when the ladder is exhausted", async () => {
    const bytes = pngBytesOfSize(9 * 1024 * 1024);
    const { codec, encodeCalls } = makeMockCodec({
      ...emptyMockCodecOptions(),
      width: 3840,
      height: 2160,
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
    ).rejects.toThrow(ImageTooLargeError);
    const pngCalls = encodeCalls.filter((c) => c.mimeType === "image/png");
    expect(pngCalls).toHaveLength(1);
  });

  /**
   * The boundary half of "does a 2000 px screenshot PNG fit the ceiling?": a
   * same-family PNG re-encode AT or under `PREPARED_IMAGE_MAX_BYTES`
   * (3,932,160 B) is accepted as `"source-family"`; one byte over falls
   * through to the ladder as `"recompressed"`. A mocked codec can only pin
   * that comparison, never how big a real PNG comes out.
   *
   * The empirical half was measured outside this suite, against 39 real
   * screenshots re-encoded to a 2000 px longest edge with ImageIO: every one
   * fitted. The 9 genuine downscales (sources over 2000 px) landed between
   * 74 KB and 1.64 MB; the 30 harsher upscale-to-2000 cases topped out at
   * 3.02 MB, still inside the ceiling. So the PNG attempt is expected to be
   * the accepting step for ordinary screenshot content, and the ladder below
   * exists for the photographic and noisy images where it will not be.
   */
  it.each([
    ["a PNG well under the ceiling", 3_000_000, "source-family"],
    ["a PNG exactly at the ceiling", PREPARED_IMAGE_MAX_BYTES, "source-family"],
    [
      "a PNG one byte over the ceiling",
      PREPARED_IMAGE_MAX_BYTES + 1,
      "recompressed",
    ],
  ] as const)(
    "%s (%i bytes) lands as %s",
    async (_label, pngResultBytes, expectedStep) => {
      const bytes = pngBytesOfSize(9 * 1024 * 1024);
      const { codec } = makeMockCodec({
        ...emptyMockCodecOptions(),
        width: 3840,
        height: 2160,
        encode: (args: EncodeArgs) => {
          if (args.mimeType === "image/png") {
            return Promise.resolve(encodedPngBytesOfSize(pngResultBytes));
          }
          // The ladder must always have something to fall back to when the
          // PNG attempt itself doesn't fit.
          return Promise.resolve(encodedWebpBytesOfSize(1_000_000));
        },
      });
      const session = createImagePreparationSession({
        policy: PREPARED_IMAGE_POLICY,
        codec,
      });
      const prepared = await session.prepare({
        bytes,
        fileName: "screenshot.png",
        declaredMimeType: "image/png",
      });
      expect(prepared.step).toBe(expectedStep);
    },
  );
});
