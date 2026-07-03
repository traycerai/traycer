import type { ProviderRateLimitQueryState } from "@/components/settings/panels/provider-rate-limit-views";

/**
 * Whether `ProviderRateLimitBody` would render visible content for `props` -
 * mirrors its branching exactly. Lets a caller that wraps the body in its
 * own chrome (a border, padding) skip that chrome when the body would
 * render nothing, instead of always painting an empty section. Kept out of
 * `provider-rate-limit-views.tsx` (a component-only file) since a plain
 * function export there breaks React Fast Refresh's component-boundary
 * detection.
 */
export function hasProviderRateLimitContent(
  props: ProviderRateLimitQueryState,
): boolean {
  if (props.isPending && props.isFetching) return true;
  if (props.isError) return true;
  return (props.providerRateLimits ?? null) !== null;
}
