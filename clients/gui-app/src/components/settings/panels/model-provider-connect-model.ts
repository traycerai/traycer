import type {
  ModelProviderAuthMethod,
  ModelProviderEntry,
  ModelProviderPrompt,
  ModelProviderSource,
  ProviderModelProvidersCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";

/** The rules the Model Providers tab and its connect dialog render from, kept out of both components so they
 * can be exercised directly. */

/** One list rather than a "connected" section above a "catalog" section. */
export function sortModelProviderEntries(
  entries: readonly ModelProviderEntry[],
): readonly ModelProviderEntry[] {
  return [...entries].sort((left, right) => {
    if (left.connected !== right.connected) return left.connected ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/** `api` is "API key" rather than "Saved in {provider}". */
export function sourceBadgeLabel(
  source: ModelProviderSource,
  configDeclaredCustom: boolean,
): string {
  switch (source) {
    case "api":
      return "API key";
    case "env":
      return "Environment";
    case "config":
      return configDeclaredCustom ? "Custom" : "Config";
    case "custom":
      return "Custom";
  }
}

export function sourceBadgeHint(
  source: ModelProviderSource,
  providerLabel: string,
  configDeclaredCustom: boolean,
): string {
  switch (source) {
    case "api":
      return `This key is stored in ${providerLabel}'s own credential store, shared with its CLI, and can be removed from here.`;
    case "env":
      return "This credential comes from an environment variable, so it's managed outside Traycer.";
    case "config":
      return configDeclaredCustom
        ? `You declared this provider in ${providerLabel}'s config file, with its own base URL and models.`
        : `This credential comes from a ${providerLabel} config file, so it's managed outside Traycer.`;
    case "custom":
      return `This provider is loaded by a custom ${providerLabel} loader.`;
  }
}

/** What a user should know before signing a provider in that already has a credential from somewhere else - or
 * null when there is nothing to warn about. */
export function credentialPrecedenceNotice(
  source: ModelProviderSource | null,
  providerLabel: string,
): string | null {
  switch (source) {
    case "env":
      // The provider's own env var name is not something the client can know without one, and guessing it would be
      // worse than the general statement.
      return "An environment variable on this host already provides this credential, and it takes precedence - what you save here will not take effect until that variable is unset.";
    case "config":
      // Possessive rather than "A/An {label}": the article cannot be derived from an arbitrary provider name, and "A
      // OpenCode config file" is what interpolating one blindly produces.
      return `${providerLabel}'s own config file already provides this credential and takes precedence. What you save here will not take effect until it is removed there.`;
    case "custom":
      return "This provider is loaded by a custom loader, which may already supply its credential.";
    case "api":
    case null:
      return null;
  }
}

/** The `auto` arm of some flows asks the user to read a short code off our screen and type it into the browser,
 * so it wants to be a copyable field rather than a sentence. */
const CONFIRMATION_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/;

export function extractConfirmationCode(
  instructions: string | null,
): string | null {
  if (instructions === null) return null;
  const trimmed = instructions.trim();
  if (trimmed.length === 0) return null;
  if (CONFIRMATION_CODE_PATTERN.test(trimmed)) return trimmed;
  const tail = trimmed.split(":").pop();
  if (tail === undefined) return null;
  const candidate = tail.trim();
  return CONFIRMATION_CODE_PATTERN.test(candidate) ? candidate : null;
}

/** The plain API-key path is a choice with `methodIndex: null` rather than a separate mode. */
export type ConnectChoice = {
  readonly id: string;
  readonly label: string;
  readonly methodIndex: number | null;
  readonly kind: "api" | "oauth";
  readonly prompts: readonly ModelProviderPrompt[];
  /** Null when this choice is usable; a reason when it is shown disabled. */
  readonly unavailableReason: string | null;
};

/** The host says which verbs it will accept, and a missing one is shown unavailable rather than hidden, because
 * "this provider offers OAuth. */
export function connectChoicesFor(
  entry: ModelProviderEntry,
  capabilities: ProviderModelProvidersCapabilities,
): readonly ConnectChoice[] {
  const canConnect = capabilities.actions.includes("connect");
  const canOauth = capabilities.actions.includes("oauth");
  const choices: ConnectChoice[] = [];
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
      }),
    });
  });
  return choices;
}

function unavailableReasonFor(
  method: ModelProviderAuthMethod,
  gates: { readonly canConnect: boolean; readonly canOauth: boolean },
): string | null {
  if (method.type === "oauth") {
    return gates.canOauth
      ? null
      : "Browser sign-in isn't available on this host.";
  }
  return gates.canConnect
    ? null
    : "Saving an API key isn't available on this host.";
}

export function initialConnectChoiceId(
  choices: readonly ConnectChoice[],
): string {
  const usable = choices.find((choice) => choice.unavailableReason === null);
  return usable?.id ?? choices.at(0)?.id ?? "";
}
