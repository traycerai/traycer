import { z } from "zod";
import {
  DEFAULT_ACCOUNT_CONTEXT,
  accountContextSchema,
} from "@traycer/protocol/common/schemas";

export const rateLimitUsageRequestSchema = z
  .object({
    accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
  })
  .strict();
export type RateLimitUsageRequest = z.infer<typeof rateLimitUsageRequestSchema>;

// Mirrors the aperture rate-limit shape defined in an internal shared package
// (not in this repo) - the aperture gRPC return shape the Traycer cloud
// backend maps straight onto this wire contract.
export const rateLimitUsageResponseSchema = z.object({
  totalTokens: z.number(),
  remainingTokens: z.number(),
  retryAfter: z.number().optional(),
});
export type RateLimitUsageResponse = z.infer<
  typeof rateLimitUsageResponseSchema
>;
