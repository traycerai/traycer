import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const supportedImageMediaTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const;

export const supportedImageMediaTypeSchema = lazySchema(() =>
  z.enum(supportedImageMediaTypes),
);
export type SupportedImageMediaType = z.infer<
  typeof supportedImageMediaTypeSchema
>;

export const imageSha256HexSchema = lazySchema(() =>
  z.string().regex(/^[0-9a-f]{64}$/),
);
export const imageByteLengthSchema = lazySchema(() =>
  z.number().int().nonnegative(),
);
export const imageDimensionSchema = lazySchema(() =>
  z.number().int().positive().nullable(),
);
