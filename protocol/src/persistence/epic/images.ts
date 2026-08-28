import { z } from "zod";

export const supportedImageMediaTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const;

export const supportedImageMediaTypeSchema = z.enum(supportedImageMediaTypes);
export type SupportedImageMediaType = z.infer<
  typeof supportedImageMediaTypeSchema
>;

export const imageSha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const imageByteLengthSchema = z.number().int().nonnegative();
export const imageDimensionSchema = z.number().int().positive().nullable();
