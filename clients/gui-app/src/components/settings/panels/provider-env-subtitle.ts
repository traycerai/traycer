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

/**
 * The same subtitle for a provider whose variables apply only to native
 * configuration operations (MCP setup and the like), never its
 * conversations - `envOverrideScope === "native-config-only"`, e.g. Cursor.
 * The reach and Unset lines are the same as {@link providerEnvSubtitle}; only
 * when the variables apply differs.
 */
export function providerNativeConfigOnlyEnvSubtitle(
  providerName: string,
  configuration: ProviderEnvConfiguration,
): string {
  const unset = `Unset removes a variable ${providerName} would otherwise get from the shell.`;
  const noConversations = `${providerName}'s conversations don't get them.`;
  switch (configuration.kind) {
    case "personal":
      return `Set for ${providerName} when Traycer sets up its tools, such as MCP servers, on every computer and sandbox running Personal. ${noConversations} ${unset}`;
    case "team":
      return `Set for ${providerName} when Traycer sets up its tools, such as MCP servers, on every host running ${configuration.teamName}. ${noConversations} ${unset}`;
    case "local":
      return `Set for ${providerName} when Traycer sets up its tools, such as MCP servers, on this computer only. ${noConversations} ${unset}`;
  }
}

/**
 * The same subtitle for a provider whose `envOverrideScope` isn't known yet
 * (e.g. a team's Env tab with no reachable host to read its catalog from):
 * states the reach and what Unset does, the two facts true either way,
 * without committing to {@link providerEnvSubtitle}'s "each time it starts"
 * claim or {@link providerNativeConfigOnlyEnvSubtitle}'s native-config-only
 * one - either could be wrong until the scope is confirmed.
 */
export function providerEnvSubtitleUnknownScope(
  providerName: string,
  configuration: ProviderEnvConfiguration,
): string {
  const unset = `Unset removes a variable ${providerName} would otherwise get from the shell.`;
  switch (configuration.kind) {
    case "personal":
      return `Set for ${providerName} on every computer and sandbox running Personal. ${unset}`;
    case "team":
      return `Set for ${providerName} on every host running ${configuration.teamName}. ${unset}`;
    case "local":
      return `Set for ${providerName} on this computer only. ${unset}`;
  }
}
