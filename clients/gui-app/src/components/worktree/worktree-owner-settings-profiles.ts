import type {
  ProviderProfile,
  ProviderId as WireProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { ProviderId } from "@/components/home/data/landing-options";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";

const EMPTY_PROFILES: ReadonlyArray<ProviderProfile> = [];

/**
 * One GUI harness's profiles from the wire provider list. Keeping the two id
 * spaces explicit prevents `claude` from being compared directly with the
 * wire's `claude-code` identifier.
 */
export function harnessProfiles(
  providers: ReadonlyArray<{
    readonly providerId: WireProviderId;
    readonly profiles: ReadonlyArray<ProviderProfile>;
  }> | null,
  harnessId: ProviderId | null,
): ReadonlyArray<ProviderProfile> {
  if (providers === null || harnessId === null) return EMPTY_PROFILES;
  const providerId = guiHarnessIdToProviderId(harnessId);
  if (providerId === null) return EMPTY_PROFILES;
  const provider =
    providers.find((candidate) => candidate.providerId === providerId) ?? null;
  return provider === null ? EMPTY_PROFILES : provider.profiles;
}
