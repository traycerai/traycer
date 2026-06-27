import { z } from "zod";
import {
  DEFAULT_ACCOUNT_CONTEXT,
  accountContextSchema,
} from "@traycer/protocol/common/schemas";

// `host.getRateLimitUsage` v1.0 request: no fields. Non-strict on purpose so a
// v1.1 client can Zod-strip its `accountContext` away when projecting the request
// onto this shape for a v1.0 host - a `.strict()` schema would *reject* the extra
// field instead of dropping it, breaking the minor downgrade. The shipped v1.0.0
// host parses the resulting `{}` identically (it never carried extra keys), so
// dropping `.strict()` here is invisible on the wire.
export const rateLimitUsageRequestSchemaV10 = z.object({});
export type RateLimitUsageRequestV10 = z.infer<
  typeof rateLimitUsageRequestSchemaV10
>;

// v1.1 request adds the selected account so usage reflects the active
// org/personal context. Added as a minor (NOT an in-place edit to v1.0) so a
// shipped v1.0.0 host still negotiates. Defaulted so a caller that omits it - and
// the v1.0 -> v1.1 upgrade path - resolves to the personal context.
export const rateLimitUsageRequestSchemaV11 =
  rateLimitUsageRequestSchemaV10.extend({
    accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
  });
export type RateLimitUsageRequestV11 = z.infer<
  typeof rateLimitUsageRequestSchemaV11
>;

// Mirrors the aperture rate-limit shape defined in an internal shared package
// (not in this repo) - the aperture gRPC return shape the Traycer cloud
// backend maps straight onto this wire contract. Unchanged across v1.0 / v1.1.
export const rateLimitUsageResponseSchema = z.object({
  totalTokens: z.number(),
  remainingTokens: z.number(),
  retryAfter: z.number().optional(),
});
export type RateLimitUsageResponse = z.infer<
  typeof rateLimitUsageResponseSchema
>;
