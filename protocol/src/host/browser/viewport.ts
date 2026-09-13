import { z } from "zod";

/** CSS layout limits, independent of raster density and capture quality. */
export const BROWSER_VIEWPORT_MIN_EDGE = 64;
export const BROWSER_VIEWPORT_MAX_EDGE = 8192;
export const BROWSER_VIEWPORT_MAX_PIXELS = 16_777_216;

const viewportEdgeSchema = z
  .number()
  .int()
  .min(BROWSER_VIEWPORT_MIN_EDGE)
  .max(BROWSER_VIEWPORT_MAX_EDGE);

export const browserViewportSizeSchema = z
  .object({ width: viewportEdgeSchema, height: viewportEdgeSchema })
  .strict()
  .refine(
    ({ width, height }) => width * height <= BROWSER_VIEWPORT_MAX_PIXELS,
    {
      message: `Viewport area cannot exceed ${BROWSER_VIEWPORT_MAX_PIXELS.toLocaleString("en-US")} CSS pixels`,
    },
  );
export type BrowserViewportSize = z.infer<typeof browserViewportSizeSchema>;

export const browserViewportIntentSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("fit") }).strict(),
  browserViewportSizeSchema.safeExtend({ mode: z.literal("fixed") }),
]);
export type BrowserViewportIntent = z.infer<typeof browserViewportIntentSchema>;

/** Observed geometry can be smaller than the manual editor's minimum. */
export const browserViewportGeometrySchema = z
  .object({
    width: z.number().int().positive().max(BROWSER_VIEWPORT_MAX_EDGE),
    height: z.number().int().positive().max(BROWSER_VIEWPORT_MAX_EDGE),
    dpr: z.number().positive().max(8),
  })
  .strict();
export type BrowserViewportGeometry = z.infer<
  typeof browserViewportGeometrySchema
>;

export const browserViewportStateSchema = z
  .object({
    sessionId: z.string(),
    tabId: z.string(),
    intent: browserViewportIntentSchema,
    // Last confirmed application. Null means there is no observed live layout.
    // Native display-density changes are remeasured on the next application.
    applied: browserViewportGeometrySchema.nullable(),
    revision: z.number().int().nonnegative(),
    source: z.enum(["user", "agent"]).nullable(),
    fitOwnerId: z.string().nullable(),
  })
  .strict();
export type BrowserViewportState = z.infer<typeof browserViewportStateSchema>;
