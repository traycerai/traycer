/** Whose Env a provider's tab edits, as its subtitle names it. */
export type ProviderEnvConfiguration =
  | { readonly kind: "personal" }
  | { readonly kind: "team"; readonly teamName: string }
  | { readonly kind: "local" };

/**
 * A provider's Env subtitle: when its variables are set, where, and what
 * Unset does. A Local row's reach is its own computer.
 */
export function providerEnvSubtitle(
  providerName: string,
  configuration: ProviderEnvConfiguration,
): string {
  const unset = `Unset removes a variable ${providerName} would otherwise get from the shell.`;
  switch (configuration.kind) {
    case "personal":
      return `Set for ${providerName} each time it starts, on every computer and sandbox running Personal. ${unset}`;
    case "team":
      return `Set for ${providerName} each time it starts, on every host running ${configuration.teamName}. ${unset}`;
    case "local":
      return `Set for ${providerName} each time it starts, on this computer only. ${unset}`;
  }
}
