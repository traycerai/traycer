import type { ProviderSettingsTab } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { hidesCliCandidates } from "./provider-cli-candidates-visibility";

/**
 * A tab the detail pane can render. Every wire tab, plus `account` — which is
 * CLIENT-ONLY and deliberately never added to `providerSettingsTabSchema`.
 *
 * The API key and the profile/limits surfaces answer different questions
 * ("how does this provider authenticate?" vs "which account is running, and
 * how much of it is left?"), and a provider can support either without the
 * other: amp advertises no `usage` tab at all yet takes an API key, while
 * claude-code has profiles and limits but no key field. One shared tab meant
 * whichever half a provider lacked left a hole in it.
 *
 * Client-only because the wire enum is a compatibility surface, not a UI list:
 * `supportedTabs` rides `nativeCapabilities`, which released clients decode
 * through a single `.catch(DEFAULT_PROVIDER_NATIVE_CAPABILITIES)` over the
 * whole object — an id an older client cannot parse fails the enum and drops
 * MCP/Plugins/Skills with it. Nothing about "does this provider take an API
 * key?" needs the host to say so anyway; `state.apiKey.supported` already does.
 */
export type ProviderTabKey = ProviderSettingsTab | "account";

/**
 * Stable display order for the provider detail tab bar. Unsupported tabs are
 * filtered out per provider by {@link supportedTabsFor}.
 */
export const PROVIDER_TAB_ORDER: readonly ProviderTabKey[] = [
  "general",
  "account",
  "usage",
  "env",
  "mcp",
  "plugins",
  "skills",
];

/**
 * Everything {@link supportedTabsFor} needs, and nothing else - so the rule can
 * be exercised without constructing a whole `ProviderCliState` (or rendering
 * the panel) just to ask which tabs a provider should show.
 */
export interface ProviderTabInputs {
  readonly providerId: ProviderCliState["providerId"];
  readonly apiKeySupported: boolean;
  /** `nativeCapabilities.supportedTabs` as advertised by the host. */
  readonly advertised: readonly ProviderSettingsTab[];
}

/**
 * The visible tab set: what the provider ADVERTISES, minus what would render
 * EMPTY, plus what must stay reachable.
 *
 * - `general` holds exactly the CLI candidate table and the terminal-agent args
 *   field. Both self-gate on the same providers (`hidesCliCandidates` covers
 *   cursor/amp, which are GUI-only and so never advertise the `tui` mode the
 *   args field needs), so a hidden candidate table means an empty tab. Cursor
 *   used to list a "General" tab that rendered nothing at all.
 * - `account` is client-derived and shows exactly when the provider takes an
 *   API key — the key field is the only way to authenticate those providers,
 *   so its visibility must not depend on a host advertisement that (for amp)
 *   legitimately omits every account-ish tab.
 * - `usage` is taken at the host's word. It already gates that tab on being
 *   able to populate it (managed profiles, the Traycer subscription card, or
 *   rate limits), which is the same question this side would have to re-derive.
 */
export function supportedTabsFor(
  input: ProviderTabInputs,
): readonly ProviderTabKey[] {
  const advertised = new Set<ProviderTabKey>(input.advertised);
  return PROVIDER_TAB_ORDER.filter((tab) => {
    if (tab === "general" && hidesCliCandidates(input.providerId)) return false;
    if (tab === "account") return input.apiKeySupported;
    return advertised.has(tab);
  });
}

export function providerTabInputs(state: ProviderCliState): ProviderTabInputs {
  return {
    providerId: state.providerId,
    apiKeySupported: state.apiKey.supported,
    advertised: state.nativeCapabilities.supportedTabs,
  };
}
