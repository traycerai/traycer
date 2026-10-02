import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import { ProviderLimitsControl } from "@/components/layout-editor/inspector/provider-limits";
import { USAGE_PROVIDER_LEVEL } from "@/components/layout-editor/regions/usage-provider-level";
import { isRateLimitCapableProvider } from "@/lib/rate-limit-providers";
import { isWindowedRateLimitProvider } from "@/lib/rate-limits/rate-limit-window-catalog";

/**
 * Which of this provider's limits the usage readings draw, on the provider's
 * own page. The Layout form used to carry it under each provider of the
 * Profiles list; it is a fact about the provider, so it lives here.
 *
 * Nothing for a provider whose limits are not windowed: it has no limits to
 * pick between.
 */
export function ProviderUsageLimitsSection(props: {
  readonly providerId: ProviderId;
}): ReactNode {
  const { providerId } = props;
  if (
    !isRateLimitCapableProvider(providerId) ||
    !isWindowedRateLimitProvider(providerId)
  ) {
    return null;
  }
  return (
    <section
      data-provider-usage-limits={providerId}
      className="flex flex-col rounded-lg border border-border/60"
    >
      <h3 className="px-5 pt-3 text-ui-sm font-medium text-foreground">
        {USAGE_PROVIDER_LEVEL.sectionLabel}
      </h3>
      <LayoutFormHostContext value="page">
        <ProviderLimitsControl providerId={providerId} />
      </LayoutFormHostContext>
    </section>
  );
}
