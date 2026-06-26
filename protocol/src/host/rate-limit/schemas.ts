import { z } from "zod";
import {
  DEFAULT_ACCOUNT_CONTEXT,
  accountContextSchema,
} from "@traycer/protocol/common/schemas";

// v1.0 request: empty, and intentionally NON-strict (no `.strict()`).
//
// The framework downgrades a request to an older same-major minor by
// strip-projecting it through that minor's own request schema
// (`prepareRequestPayload` in ws-rpc-client: `requestSchema.safeParse(params)`).
// A new client (canonical v1.1, sends `{ accountContext }`) talking to a
// released v1.0 host strips that down to `{}` by parsing through THIS schema -
// which only works if the unknown key is STRIPPED, not rejected. `.strict()`
// rejects, which would move the break from host to client. Any request schema
// that is a downgrade target must stay non-strict.
export const rateLimitUsageRequestSchemaV10 = z.object({});
export type RateLimitUsageRequestV10 = z.infer<
  typeof rateLimitUsageRequestSchemaV10
>;

// v1.1 request: adds `accountContext`. `.strict()` is safe here because v1.1 is
// the latest minor and so never a downgrade target.
export const rateLimitUsageRequestSchemaV11 = z
  .object({
    accountContext: accountContextSchema.default(DEFAULT_ACCOUNT_CONTEXT),
  })
  .strict();
export type RateLimitUsageRequestV11 = z.infer<
  typeof rateLimitUsageRequestSchemaV11
>;

// Canonical request type points at the latest version. There is deliberately no
// unversioned `rateLimitUsageRequestSchema` value export - an unversioned alias
// is exactly what invites editing "the" schema in place (the bug this versioning
// fixes). Consumers pick a specific version.
export type RateLimitUsageRequest = RateLimitUsageRequestV11;

// Mirrors the aperture rate-limit shape defined in an internal shared package
// (not in this repo) - the aperture gRPC return shape the Traycer cloud
// backend maps straight onto this wire contract. Unchanged across the v1.0/v1.1
// minor bump.
export const rateLimitUsageResponseSchema = z.object({
  totalTokens: z.number(),
  remainingTokens: z.number(),
  retryAfter: z.number().optional(),
});
export type RateLimitUsageResponse = z.infer<
  typeof rateLimitUsageResponseSchema
>;
