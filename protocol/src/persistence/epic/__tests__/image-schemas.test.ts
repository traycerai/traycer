import { prepareArtifactImageResponseSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { imageGenerationResultSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  supportedImageMediaTypeSchema,
  supportedImageMediaTypes,
} from "@traycer/protocol/persistence/epic/images";
import { imageResolutionEntrySchema } from "@traycer/protocol/persistence/epic/messages";
import { describe, expect, it } from "vitest";

const validHash = "a".repeat(64);

const generatedImage = {
  attachmentHash: validHash,
  mediaType: "image/png",
  byteLength: 1,
  width: 1,
  height: 1,
};

const resolvedImage = {
  source: "/tmp/image.png",
  canonicalSource: "/tmp/image.png",
  state: "resolved",
  attachmentHash: validHash,
  mediaType: "image/png",
  width: 1,
  height: 1,
};

const artifactImage = {
  ok: true,
  operationId: "operation-1",
  attachmentHash: validHash,
  mediaType: "image/png",
  src: `images/${validHash}.png`,
};

describe("current image schemas", () => {
  it.each(["a".repeat(63), "A".repeat(64)])(
    "rejects malformed attachment hash %s at every current image schema site",
    (attachmentHash) => {
      expect(
        imageGenerationResultSchema.safeParse({
          ...generatedImage,
          attachmentHash,
        }).success,
      ).toBe(false);
      expect(
        imageResolutionEntrySchema.safeParse({
          ...resolvedImage,
          attachmentHash,
        }).success,
      ).toBe(false);
      expect(
        prepareArtifactImageResponseSchema.safeParse({
          ...artifactImage,
          attachmentHash,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects unknown media at every current image schema site", () => {
    const mediaType = "image/avif";
    expect(
      imageGenerationResultSchema.safeParse({
        ...generatedImage,
        mediaType,
      }).success,
    ).toBe(false);
    expect(
      imageResolutionEntrySchema.safeParse({
        ...resolvedImage,
        mediaType,
      }).success,
    ).toBe(false);
    expect(
      prepareArtifactImageResponseSchema.safeParse({
        ...artifactImage,
        mediaType,
      }).success,
    ).toBe(false);
  });

  it.each([-1, 1.5])("rejects invalid byteLength %s", (byteLength) => {
    expect(
      imageGenerationResultSchema.safeParse({
        ...generatedImage,
        byteLength,
      }).success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5])("rejects invalid dimensions %s", (dimension) => {
    for (const field of ["width", "height"] as const) {
      expect(
        imageGenerationResultSchema.safeParse({
          ...generatedImage,
          [field]: dimension,
        }).success,
      ).toBe(false);
      expect(
        imageResolutionEntrySchema.safeParse({
          ...resolvedImage,
          [field]: dimension,
        }).success,
      ).toBe(false);
    }
  });

  it("uses one media enum instance at every current image schema site", () => {
    expect(imageGenerationResultSchema.shape.mediaType).toBe(
      supportedImageMediaTypeSchema,
    );
    expect(imageResolutionEntrySchema.options[0].shape.mediaType).toBe(
      supportedImageMediaTypeSchema,
    );
    expect(prepareArtifactImageResponseSchema.options[0].shape.mediaType).toBe(
      supportedImageMediaTypeSchema,
    );
    expect(supportedImageMediaTypeSchema.options).toEqual(
      supportedImageMediaTypes,
    );
  });
});
