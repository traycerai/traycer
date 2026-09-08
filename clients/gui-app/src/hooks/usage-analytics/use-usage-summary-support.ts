import {
  useHostMethodMajorAtLeast,
  useHostSupportsMethod,
} from "@/hooks/host/use-host-supports-method";

const USAGE_SUMMARY_METHOD = "host.usage.summary";

/** D21/D27: the `host.usage.summary` major that carries the `profileId` filter (protocol/host/usage-analytics/contracts.ts's `hostUsageSummaryV20`). */
const USAGE_SUMMARY_PROFILE_FILTER_MAJOR = 2;

/**
 * Whether `hostId` advertised `host.usage.summary` at its last handshake.
 * `host.usage.summary` is registered `degrade: { kind: "unsupported" }` (see
 * the protocol registry), so an older host simply omits it rather than
 * failing the handshake - this is the gate every usage-cost affordance
 * (Usage page nav entry, epic cost badge) checks before rendering, fails
 * closed like every other optional-method gate in this app.
 */
export function useUsageSummarySupported(hostId: string | null): boolean {
  return useHostSupportsMethod(hostId, USAGE_SUMMARY_METHOD);
}

/**
 * D21/D27: whether `hostId` negotiated `host.usage.summary` at major 2 or
 * newer - the minimum that understands the wire's `profileId` filter
 * (`hostUsageSummaryV20`, `protocol/host/usage-analytics/contracts.ts`).
 *
 * `false`-collapsing, like {@link useUsageSummarySupported}: an older host
 * degrades a `profileId` filter to "every profile" rather than refusing (the
 * registry's downgrade bridge - a read returning MORE than asked is an
 * honest degradation, never a silently-wrong target). That protects the
 * REQUEST, not the LABEL: a caller showing the response as "this profile's
 * totals" would be lying to the reader on a host that quietly widened it, so
 * every profile-scoped totals affordance gates on this hook first and falls
 * back to an unsupported-host notice instead of mislabeling an
 * account-wide total as one profile's.
 */
export function useUsageSummaryProfileFilterSupported(
  hostId: string | null,
): boolean {
  return (
    useHostMethodMajorAtLeast(
      hostId,
      USAGE_SUMMARY_METHOD,
      USAGE_SUMMARY_PROFILE_FILTER_MAJOR,
    ) === true
  );
}
