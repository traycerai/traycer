import { z } from "zod";

/**
 * Maximum UTF-8 byte length of a text-search preview. Hosts truncate previews
 * at a character boundary and clamp or omit ranges that exceed this bound.
 */
export const SEARCH_TEXT_PREVIEW_MAX_BYTES = 512;

/** Byte offsets into a UTF-8 text-search preview. */
export const searchTextPreviewRangeSchema = z
  .object({
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().nonnegative(),
  })
  .refine(
    (range) =>
      range.endByte >= range.startByte &&
      range.endByte <= SEARCH_TEXT_PREVIEW_MAX_BYTES,
    {
      message: `endByte must not precede startByte or exceed ${SEARCH_TEXT_PREVIEW_MAX_BYTES}`,
    },
  );
