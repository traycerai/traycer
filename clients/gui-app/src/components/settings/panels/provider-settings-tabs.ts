import type { ProviderSettingsTab } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";

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
 *
 * Account and Profiles & Limits lead: they are what people open Providers to
 * do (sign in, switch profile, check remaining quota). CLI & Args is rarer
 * setup and sits after them. The first *supported* tab is also the default
 * selection ({@link supportedTabsFor} keeps this order), so a provider with
 * neither account nor usage still opens on a sensible first tab (env, mcp, …).
 *
 * `modelProviders` sits after `env` and before the three inventory tabs, for
 * two reasons. It is CONFIGURATION - which upstream models this provider can
 * reach at all - rather than an inventory of things installed into it, so it
 * belongs with the other configuration tabs. And placing it there cannot move
 * any provider's DEFAULT tab: every provider that advertises it also advertises
 * `general` and `env`, which come first.
 */
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

/**
 * Everything {@link supportedTabsFor} needs, and nothing else - so the rule can
 * be exercised without constructing a whole `ProviderCliState` (or rendering
 * the panel) just to ask which tabs a provider should show.
 *
 * Carries no `providerId` on purpose. It used to, for the sole benefit of the
 * `hidesCliCandidates` id check below; keeping it once that check went would
 * leave an unread field sitting here as an invitation to write the next
 * per-provider rule against an id instead of a fact.
 */
export interface ProviderTabInputs {
  /** `nativeCapabilities.supportedTabs` as advertised by the host. */
  readonly advertised: readonly ProviderSettingsTab[];
}

/**
 * The visible tab set: what the provider ADVERTISES, minus what would render
 * EMPTY, plus what must stay reachable.
 *
 * - `general` holds exactly the CLI candidate table and the terminal-agent args
 *   field, and is now shown whenever the host advertises it. It used to be
 *   suppressed for cursor/amp by a `hidesCliCandidates(providerId)` id check on
 *   the premise that those two have no CLI-binary concept - which was never
 *   true: both route their MCP write verbs through the Traycer-resolved binary
 *   (`runAmpCliCapture`, `runCursorMcpCli`), so the candidate table is the only
 *   control over the binary those verbs spawn and the only way to point Traycer
 *   at one when none is found. Hiding it turned "no amp on PATH" into an MCP
 *   tab with no Add button and no route back.
 *
 *   Nothing replaced the id check: the emptiness worry it encoded is already
 *   answered upstream. `baseBinaryName` (host) is an exhaustive switch, so
 *   every provider has a binary name to search for, and the candidates section
 *   renders a real empty state when nothing is found rather than nothing at
 *   all.
 * - `account` is client-derived and always shown (D05: every provider exposes
 *   a Default account row, so the Account tab is always the first tab).
 * - `usage` is taken at the host's word. It already gates that tab on being
 *   able to populate it (managed profiles, the Traycer subscription card, or
 *   rate limits), which is the same question this side would have to re-derive.
 */
export function supportedTabsFor(
  input: ProviderTabInputs,
): readonly ProviderTabKey[] {
  const advertised = new Set<ProviderTabKey>(input.advertised);
  return PROVIDER_TAB_ORDER.filter((tab) => {
    if (tab === "account") return true;
    return advertised.has(tab);
  });
}

export function providerTabInputs(state: ProviderCliState): ProviderTabInputs {
  return {
    advertised: state.nativeCapabilities.supportedTabs,
  };
}

/**
 * The tab's label. Presentation only - the tab ID (`labels`' keys) is the
 * wire enum and is untouched by this lookup.
 *
 * Used to vary `usage`'s label by provider (profiles existed on only three of
 * them); the profile switcher (D25) now owns profile display everywhere, so
 * every provider's `usage` tab holds the same thing and the label no longer
 * varies.
 */
export function providerTabLabel(
  tab: ProviderTabKey,
  labels: Readonly<Record<ProviderTabKey, string>>,
): string {
  return labels[tab];
}
