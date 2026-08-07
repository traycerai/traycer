import type {
  ModelProviderAuthMethod,
  ModelProviderEntry,
  ModelProviderPrompt,
  ModelProviderSource,
  ProviderModelProvidersCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";

/**
 * The rules the Model Providers tab and its connect dialog render FROM, kept
 * out of both components so they can be exercised directly - and so neither
 * file exports a non-component (which costs the whole module its fast refresh).
 */

/**
 * Connected first, then everything else, each half alphabetical.
 *
 * ONE list rather than a "connected" section above a "catalog" section. The two
 * sections read better on a mock and worse in use: search would either have to
 * run twice or be scoped to the catalog half, and a connected provider would
 * then be the one row a search for its name could not find. Sorting carries the
 * same "what you already did comes first" meaning with one list, one search and
 * one empty state.
 */
export function sortModelProviderEntries(
  entries: readonly ModelProviderEntry[],
): readonly ModelProviderEntry[] {
  return [...entries].sort((left, right) => {
    if (left.connected !== right.connected) return left.connected ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export const SOURCE_BADGE_LABEL: Readonly<Record<ModelProviderSource, string>> =
  {
    api: "Saved in Traycer",
    env: "Environment",
    config: "Config file",
    custom: "Plugin",
  };

export const SOURCE_BADGE_HINT: Readonly<Record<ModelProviderSource, string>> =
  {
    api: "This credential was saved from here and can be removed from here.",
    env: "This credential comes from an environment variable, so it's managed outside Traycer.",
    config:
      "This credential comes from an OpenCode config file, so it's managed outside Traycer.",
    custom:
      "This credential comes from a provider plugin, so it's managed outside Traycer.",
  };

/**
 * One selectable way to sign in.
 *
 * The plain API-key path is a choice with `methodIndex: null` rather than a
 * separate mode: it is what the host means by "no advertised method applies",
 * and modelling it as a peer of the advertised methods is what lets one picker,
 * one form and one submit path cover every provider in the catalog.
 */
export type ConnectChoice = {
  readonly id: string;
  readonly label: string;
  readonly methodIndex: number | null;
  readonly kind: "api" | "oauth";
  readonly prompts: readonly ModelProviderPrompt[];
  /** Null when this choice is usable; a reason when it is shown disabled. */
  readonly unavailableReason: string | null;
};

/**
 * The choices a provider offers, and why some of them are shown but disabled.
 *
 * Three gates, each for a different reason and none of them collapsible into
 * the others:
 *
 * - `credentialKey === null` — this provider has no plain-API-key path at all
 *   (a multi-secret or file-based credential). Every choice that would have to
 *   write one is unusable, including an ADVERTISED `api` method: the host's
 *   connect contract requires exactly one input keyed by the credential's env
 *   var, and there is no such key to send.
 * - the capability `actions` list — the host says which verbs it will accept.
 *   A missing one is shown unavailable rather than hidden, because "this
 *   provider offers OAuth, but not from here" is a fact the user is entitled
 *   to, and silently dropping the row would read as the provider not having it.
 * - nothing offered at all — no key path and no methods. The caller renders the
 *   honest empty state instead of an empty picker.
 *
 * The plain path is also suppressed when the provider ADVERTISES an `api`
 * method, because that method IS the key path - with the extra fields it wants.
 * Offering both would put two "API key" rows in the picker that differ only in
 * whether they collect the provider's own questions, and the bare one would
 * quietly store a credential missing them.
 */
export function connectChoicesFor(
  entry: ModelProviderEntry,
  capabilities: ProviderModelProvidersCapabilities,
): readonly ConnectChoice[] {
  const canConnect = capabilities.actions.includes("connect");
  const canOauth = capabilities.actions.includes("oauth");
  const advertisesApiMethod = entry.methods.some(
    (method) => method.type === "api",
  );
  const choices: ConnectChoice[] = [];
  if (entry.credentialKey !== null && !advertisesApiMethod) {
    choices.push({
      id: "api-key",
      label: "API key",
      methodIndex: null,
      kind: "api",
      prompts: [],
      unavailableReason: canConnect
        ? null
        : "Saving an API key isn't available on this host.",
    });
  }
  entry.methods.forEach((method, index) => {
    choices.push({
      id: `method-${index}`,
      label: method.label,
      methodIndex: index,
      kind: method.type,
      prompts: method.prompts,
      unavailableReason: unavailableReasonFor(method, {
        canConnect,
        canOauth,
        hasCredentialKey: entry.credentialKey !== null,
      }),
    });
  });
  return choices;
}

function unavailableReasonFor(
  method: ModelProviderAuthMethod,
  gates: {
    readonly canConnect: boolean;
    readonly canOauth: boolean;
    readonly hasCredentialKey: boolean;
  },
): string | null {
  if (method.type === "oauth") {
    return gates.canOauth
      ? null
      : "Browser sign-in isn't available on this host.";
  }
  if (!gates.hasCredentialKey) {
    return "This provider's credential can't be entered here — sign in with its CLI.";
  }
  return gates.canConnect
    ? null
    : "Saving an API key isn't available on this host.";
}

/** The choice a freshly opened dialog starts on: the first usable one. */
export function initialConnectChoiceId(
  choices: readonly ConnectChoice[],
): string {
  const usable = choices.find((choice) => choice.unavailableReason === null);
  return usable?.id ?? choices.at(0)?.id ?? "";
}
