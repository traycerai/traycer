import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  rateLimitCapableProviderIdSchema,
  type RateLimitCapableProviderId,
} from "@traycer/protocol/host/rate-limit";

/**
 * The two providers `host.getRateLimitUsage @1.2`'s `providerRateLimits`
 * union reports full native detail for. Every other `ProviderId` (including
 * `traycer`, which uses the flat aperture fields on the same RPC) resolves
 * to the `available: false` arm if ever queried - the GUI simply never asks
 * for it. Re-exported from the protocol's own enum (rather than hand-listed
 * here again) so the host's dispatch, the wire schema's two available arms,
 * and this GUI type can't silently drift apart.
 */
export type RateLimitProviderId = RateLimitCapableProviderId;

export function isRateLimitCapableProvider(
  providerId: ProviderId,
): providerId is RateLimitProviderId {
  return rateLimitCapableProviderIdSchema.safeParse(providerId).success;
}
