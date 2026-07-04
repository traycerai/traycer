import type {
  ProviderRateLimits,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import type { ProviderRateLimitQueryState } from "@/components/settings/panels/provider-rate-limit-views";

/** The provider snapshot arms that actually carry usage detail. */
type AvailableProviderRateLimits = Extract<
  ProviderRateLimits,
  { available: true }
>;

/**
 * The loading/error/empty/data branch every rate-limit surface needs.
 * `ProviderRateLimitBody` renders from this, and `hasProviderRateLimitContent`
 * derives its boolean from it, so the two can't drift out of sync the way two
 * independently-written boolean checks could.
 */
export type ProviderRateLimitViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "empty" }
  | { readonly kind: "data"; readonly data: ProviderRateLimits };

export function resolveProviderRateLimitViewState(
  props: ProviderRateLimitQueryState,
): ProviderRateLimitViewState {
  if (props.isPending && props.isFetching) return { kind: "loading" };
  if (props.isError) return { kind: "error" };
  const data = props.providerRateLimits ?? null;
  if (data === null) return { kind: "empty" };
  return { kind: "data", data };
}

/**
 * Whether `ProviderRateLimitBody` would render visible content for `props`.
 * Lets a caller that wraps the body in its own chrome (a border, padding)
 * skip that chrome when the body would render nothing, instead of always
 * painting an empty section. Kept out of `provider-rate-limit-views.tsx` (a
 * component-only file) since a plain function export there breaks React Fast
 * Refresh's component-boundary detection.
 */
export function hasProviderRateLimitContent(
  props: ProviderRateLimitQueryState,
): boolean {
  return resolveProviderRateLimitViewState(props).kind !== "empty";
}

// Exhaustive set of `reason` codes the host emits (`provider-rate-limits.ts`,
// `rate-limits/{codex,claude,openrouter,kilocode}.ts`, `rate-limits/common.ts`)
// - the wire field is a machine identifier, not display copy.
// `Record<RateLimitUnavailableReason, string>` (not `Record<string, string>`)
// makes this exhaustive at compile time: adding a reason to the protocol's
// closed enum without adding a label here fails the build instead of silently
// showing a raw, underscore-joined reason code. Homed here (a non-component
// module) rather than in `provider-rate-limit-views.tsx` so both the Settings
// card body and the header popover can share it without a plain-function export
// breaking that file's React Fast Refresh component-boundary detection.
const RATE_LIMIT_UNAVAILABLE_REASON_LABELS: Record<
  RateLimitUnavailableReason,
  string
> = {
  cli_not_found: "the CLI isn't installed",
  unsupported_provider: "this provider isn't supported",
  invalid_response: "the CLI returned an unexpected response",
  timeout: "the request timed out",
  connection_failed: "couldn't connect to the CLI",
  sdk_incompatible: "this SDK version doesn't support rate limits",
  rate_limits_not_available: "not available for this account",
  insufficient_permissions:
    "this account doesn't have permission to view usage",
};

export function formatUnavailableReason(
  reason: RateLimitUnavailableReason,
): string {
  return RATE_LIMIT_UNAVAILABLE_REASON_LABELS[reason];
}

/**
 * The header popover's per-provider display state - richer than
 * `resolveProviderRateLimitViewState` (which the Settings card uses) because
 * this surface distinguishes cold-load from degraded from never-fetched-error,
 * each with its own treatment (Core Flows: skeleton bars / dimmed stale reading
 * / plain-language error + retry):
 *
 * - `cold`: no data has ever arrived and no fetch has failed yet -> skeleton.
 * - `error`: no data has ever arrived and the fetch failed (transport-level,
 *   not a provider `available: false` response) -> generic retry message.
 * - `unavailable`: the pull succeeded but the provider reports it can't surface
 *   usage (CLI missing, wrong account, etc.) -> mapped plain-language message.
 * - `ready`: usable snapshot present. `degraded` is true when the latest poll
 *   failed but a last-known-good reading is still shown (dimmed).
 */
export type PopoverProviderRateLimitState =
  | { readonly kind: "cold" }
  | { readonly kind: "error" }
  | {
      readonly kind: "unavailable";
      readonly reason: RateLimitUnavailableReason;
    }
  | {
      readonly kind: "ready";
      readonly data: AvailableProviderRateLimits;
      readonly degraded: boolean;
    };

export function resolvePopoverProviderRateLimitState(
  props: ProviderRateLimitQueryState,
): PopoverProviderRateLimitState {
  const snapshot = props.providerRateLimits ?? null;
  if (snapshot === null) {
    // Nothing usable yet. `isPending` alone stays `true` forever for a
    // disabled query (e.g. a host that goes unreachable while this tab is
    // open, mirroring `resolveProviderRateLimitViewState`'s same fix) - only
    // treat it as a cold load in flight (skeleton) when a fetch is actually
    // happening; a failed fetch, or a pending-but-not-fetching query that will
    // never resolve on its own, both fall through to the retryable error copy.
    return props.isPending && props.isFetching
      ? { kind: "cold" }
      : { kind: "error" };
  }
  if (!snapshot.available) {
    return { kind: "unavailable", reason: snapshot.reason };
  }
  // A last-known-good snapshot is present. `isError` here means the most recent
  // (background) refetch failed while retaining this data - Core Flows' degraded
  // state, shown dimmed rather than replaced.
  return { kind: "ready", data: snapshot, degraded: props.isError };
}

/**
 * `SNAKE_CASE`/`snake_case` token → Title Case, for any enum value that isn't
 * in one of the bespoke display-name maps elsewhere (a forward-compat
 * fallback for values a backend adds before those maps update) - used for
 * provider enum tokens (`provider-rate-limit-views.tsx`, which are already
 * lowercase) and, directly from `rate-limit-popover.tsx`, Traycer's own
 * `SubscriptionStatus` (e.g. `"ULTRA_1X_V3"`, upper-case), so the rest of
 * each word is explicitly lower-cased rather than left as-is. Homed here (a
 * non-component module) rather than a component file so callers can share it
 * without a plain-function export breaking that file's React Fast Refresh
 * component-boundary detection.
 */
export function titleCaseFromToken(value: string): string {
  return value
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

/**
 * A provider's plan/tier label, where one is fetched - the header popover
 * shows this as a chip next to the provider name (Core Flows: "where the
 * provider reports one"). Only Codex (`planType`) and Claude Code
 * (`subscriptionType`) currently report a plan/tier; OpenRouter and Kilo Code
 * have no analogous field, so they always resolve to `null` and render no chip.
 */
export function resolveProviderPlanLabel(
  data: AvailableProviderRateLimits,
): string | null {
  switch (data.provider) {
    case "codex":
      return data.planType !== null ? titleCaseFromToken(data.planType) : null;
    case "claude-code":
      return data.subscriptionType !== null
        ? titleCaseFromToken(data.subscriptionType)
        : null;
    case "openrouter":
    case "kilocode":
      return null;
  }
}
