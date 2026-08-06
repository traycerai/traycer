import type { ProviderMcpCapabilities } from "@traycer/protocol/host/provider-native-schemas";

/**
 * The sentence a user is owed when the host could not resolve this provider's
 * CLI binary and `applyBinaryAbsentGate` therefore emptied its CLI-routed write
 * verbs. `null` when nothing was taken away.
 *
 * Without this the degradation is completely silent: amp's contract routes both
 * `addServer` and `removeServer` through the CLI, so a machine with no `amp`
 * binary gets an MCP tab that lists servers, offers no Add button, no Delete
 * and no auth actions, and explains none of it. Chat keeps working the whole
 * time (amp's SDK spawns its own private copy, invisible to Traycer's
 * resolver), so nothing else on screen hints that anything is missing.
 *
 * Enumerates ONLY what the wire can prove was subtracted: a `"cli"`-routed verb
 * whose scope list is now empty. The routing fields survive the gate while the
 * scope lists do not, which is exactly what separates "stripped just now" from
 * "never offered".
 *
 * Auth is deliberately left out even though the gate always empties it.
 * Post-gate `authActions: []` is indistinguishable from a contract that never
 * had auth actions - droid and copilot are precisely that - so naming auth here
 * would be a guess dressed as a fact. Providers whose write verbs are
 * patch-routed (cursor) therefore get no notice from this helper; their route
 * back is the CLI-candidates table on the General tab, which is no longer
 * hidden from them.
 *
 * Its own module rather than a helper inside `provider-mcp-tab.tsx`: it is pure
 * (so it is tested without a DOM) and exporting a non-component from a
 * component file breaks Fast Refresh.
 */
export function mcpBinaryAbsentNotice(
  capabilities: ProviderMcpCapabilities,
  cliBinaryResolved: boolean,
  providerLabel: string,
): string | null {
  if (cliBinaryResolved) return null;
  const scopes = capabilities.actionScopes;
  const lost: string[] = [];
  if (capabilities.addServer === "cli" && scopes.add.length === 0) {
    lost.push("adding");
  }
  if (capabilities.removeServer === "cli" && scopes.remove.length === 0) {
    lost.push("removing");
  }
  if (capabilities.updateServer === "cli" && scopes.update.length === 0) {
    lost.push("editing");
  }
  if (lost.length === 0) return null;
  const verbs =
    lost.length === 1
      ? lost[0]
      : `${lost.slice(0, -1).join(", ")} and ${lost[lost.length - 1]}`;
  return `Traycer couldn't find the ${providerLabel} CLI on this machine, so ${verbs} MCP servers is unavailable here. Point Traycer at a binary under CLI & Args, or install ${providerLabel}.`;
}
