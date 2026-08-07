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

/**
 * Where the credential in effect comes from, as a badge.
 *
 * `api` is provider-named rather than "Saved in Traycer", and the distinction
 * is factual, not cosmetic: a key entered here is written to the PROVIDER's own
 * credential store (OpenCode's `auth.json`, via `auth.set`) and never mirrored
 * into Traycer's config. That was a deliberate plan decision - it is what keeps
 * `opencode auth login` and this tab interchangeable - so a badge claiming
 * Traycer holds the key would have described the one thing the design went out
 * of its way not to do.
 */
export function sourceBadgeLabel(
  source: ModelProviderSource,
  providerLabel: string,
): string {
  switch (source) {
    case "api":
      return `Saved in ${providerLabel}`;
    case "env":
      return "Environment";
    case "config":
      return "Config file";
    case "custom":
      return "Custom";
  }
}

export function sourceBadgeHint(
  source: ModelProviderSource,
  providerLabel: string,
): string {
  switch (source) {
    case "api":
      return `This key is stored in ${providerLabel}'s own credential store, shared with its CLI, and can be removed from here.`;
    case "env":
      return "This credential comes from an environment variable, so it's managed outside Traycer.";
    case "config":
      return `This credential comes from a ${providerLabel} config file, so it's managed outside Traycer.`;
    case "custom":
      return `This provider is loaded by a custom ${providerLabel} loader.`;
  }
}

/**
 * What a read-only row says on its trailing edge, or null for a credential
 * Traycer itself stored (which is not read-only and has buttons instead).
 *
 * It names the CONTROLLING PARTY as a fact, not the restriction that follows
 * from it. The badge beside the name already says where the credential comes
 * from, so a line reading "Managed outside Traycer" spent the row's last words
 * repeating that in the negative - telling the user what they cannot do here
 * rather than who owns it.
 */
export function readOnlySourceLabel(
  source: ModelProviderSource,
): string | null {
  switch (source) {
    case "env":
      return "Set by environment";
    case "config":
      return "Set in config file";
    case "custom":
      // NOT "Set in config file": a `custom` loader is frequently fed by the
      // provider's own auth store (xai signs in through OAuth and still reports
      // `custom`), so naming a file the user should go and edit sends them
      // somewhere the credential is not.
      return "Set by a custom loader";
    case "api":
      return null;
  }
}

/**
 * What a user should know before signing a provider in that ALREADY has a
 * credential from somewhere else - or null when there is nothing to warn about.
 *
 * This used to gate the affordance rather than annotate it: a row sourced from
 * the environment offered no Connect at all, on the reasoning that OpenCode
 * resolves env before its own auth store, so a key stored from here would be
 * shadowed and the click would appear to work while changing nothing.
 *
 * The precedence is real - observed live, an account holding a stored `openai`
 * OAuth credential still reports `source: "env"` while OPENAI_API_KEY is
 * exported - but blocking was the wrong response to it. Setting up a provider
 * and choosing which credential wins are different decisions: a user may
 * legitimately want the OAuth sign-in in place for when the variable is not
 * exported, or intend to unset it afterwards. OpenCode's own app lets you
 * configure any provider regardless of where its current credential comes from,
 * and ours refusing to was a restriction we invented.
 *
 * So the row keeps its Connect button and the dialog says this instead.
 */
export function credentialPrecedenceNotice(
  source: ModelProviderSource | null,
  credentialKey: string | null,
): string | null {
  switch (source) {
    case "env":
      return credentialKey === null
        ? "An environment variable on this host already provides this credential, and it takes precedence - what you save here will not take effect until that variable is unset."
        : `${credentialKey} is already set in this host's environment and takes precedence. What you save here will not take effect until that variable is unset.`;
    case "config":
      return "An OpenCode config file already provides this credential and takes precedence. What you save here will not take effect until it is removed there.";
    case "custom":
      return "This provider is loaded by a custom loader, which may already supply its credential.";
    case "api":
    case null:
      return null;
  }
}

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
 * The plain path is suppressed whenever the provider advertises ANY method.
 * A provider with a method list has told us exhaustively how it can be
 * authenticated, and every one that accepts a pasted key says so with an `api`
 * method of its own - `openai`, `xai`, `poe`, `gitlab`, `digitalocean` and
 * `snowflake-cortex` all carry an explicit "Manually enter API Key"-style arm.
 *
 * `github-copilot` is the case that separates this rule from the narrower
 * "suppress only when an `api` method exists": it advertises `['oauth']` and
 * nothing else, so upstream is saying there is NO manual key path - and its
 * `env` entry (`GITHUB_TOKEN`) exists for env-var DETECTION, not as a field to
 * type into. Under the narrow rule we offered an "API key" option the CLI does
 * not, which would have stored a credential that cannot work: Copilot needs the
 * GitHub token exchanged for a Copilot API token, which pasting cannot do.
 */
export function connectChoicesFor(
  entry: ModelProviderEntry,
  capabilities: ProviderModelProvidersCapabilities,
): readonly ConnectChoice[] {
  const canConnect = capabilities.actions.includes("connect");
  const canOauth = capabilities.actions.includes("oauth");
  const advertisesAnyMethod = entry.methods.length > 0;
  const choices: ConnectChoice[] = [];
  if (entry.credentialKey !== null && !advertisesAnyMethod) {
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
