import type { ProviderSettingsTab } from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";

/** Every wire tab, plus `account` - which is client-only and deliberately never added to
 * `providerSettingsTabSchema`. */
export type ProviderTabKey = ProviderSettingsTab | "account";

/** And placing it there cannot move any provider's default tab: every provider that advertises it also
 * advertises `general` and `env`, which come first. */
export const PROVIDER_TAB_ORDER: readonly ProviderTabKey[] = [
  "account",
  "usage",
  "general",
  "env",
  "modelProviders",
  "mcp",
  "plugins",
  "skills",
];

/** Everything supportedTabsFor needs, and nothing else - so the rule can be exercised without constructing a
 * whole `ProviderCliState` (or rendering the panel) just to ask which tabs a provider should show. */
export interface ProviderTabInputs {
  readonly apiKeySupported: boolean;
  readonly advertised: readonly ProviderSettingsTab[];
}

/** `account` is client-derived and shows exactly when the provider takes an API key. */
export function supportedTabsFor(
  input: ProviderTabInputs,
): readonly ProviderTabKey[] {
  const advertised = new Set<ProviderTabKey>(input.advertised);
  return PROVIDER_TAB_ORDER.filter((tab) => {
    if (tab === "account") return input.apiKeySupported;
    return advertised.has(tab);
  });
}

export function providerTabInputs(state: ProviderCliState): ProviderTabInputs {
  return {
    apiKeySupported: state.apiKey.supported,
    advertised: state.nativeCapabilities.supportedTabs,
  };
}

/** For a provider outside this set `profiles` is empty BY rule rather than by chance
 * (`resolveProfileWireEntries` returns `[]` without consulting the registry). */
function providerSupportsManagedProfiles(providerId: ProviderId): boolean {
  return (
    providerId === "claude-code" ||
    providerId === "codex" ||
    providerId === "grok"
  );
}

/** The tab holds managed profiles and usage limits, and for every provider but two it holds only the second -
 * so a fixed "Profiles & Limits" promised a section that is not there, on ~10 of 12 providers. */
export function providerTabLabel(
  tab: ProviderTabKey,
  labels: Readonly<Record<ProviderTabKey, string>>,
  providerId: ProviderId,
): string {
  if (tab !== "usage" || providerSupportsManagedProfiles(providerId)) {
    return labels[tab];
  }
  return "Usage limits";
}
