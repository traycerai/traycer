import type { ProviderRateLimits } from "@traycer/protocol/host";
import type { ProviderRateLimitQueryState } from "@/components/settings/panels/provider-rate-limit-views";

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
