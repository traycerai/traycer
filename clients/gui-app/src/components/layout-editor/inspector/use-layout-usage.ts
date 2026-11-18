import { createContext, use } from "react";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import type { StatusBarRateLimitCluster } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import type { LayoutArrangement } from "@/lib/layout/layout-arrangement";

interface LayoutUsage {
  readonly providerIds: ReadonlyArray<RateLimitProviderId>;
  /** The watched host's profiles per provider, for the Profiles list. */
  readonly profilesByProvider: Readonly<
    Partial<Record<RateLimitProviderId, ReadonlyArray<ProviderProfile>>>
  >;
  /** The watched host, whose accounts `shownProfiles` is keyed by, or `null`. */
  readonly hostId: string | null;
  readonly profileSelection: RateLimitProfileSelection;
  readonly cluster: StatusBarRateLimitCluster;
  readonly hostName: string;
}

export const EMPTY_USAGE: LayoutUsage = {
  providerIds: [],
  profilesByProvider: {},
  hostId: null,
  profileSelection: { shownProfiles: {}, lastProfileByHarness: {} },
  cluster: { kind: "no-providers" },
  hostName: "the watched host",
};
export const LayoutUsageContext = createContext<LayoutUsage | null>(null);

export function useLayoutUsage(): LayoutUsage {
  return use(LayoutUsageContext) ?? EMPTY_USAGE;
}

/** The arrangement narrowed to the watched host's providers, for a depiction. */
export function useLiveUsageArrangement(
  arrangement: LayoutArrangement,
): LayoutArrangement {
  const { providerIds } = useLayoutUsage();
  return {
    ...arrangement,
    usageProviders: arrangement.usageProviders.filter((id) =>
      providerIds.includes(id),
    ),
  };
}
