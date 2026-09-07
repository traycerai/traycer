import type { ProviderMcpCapabilities } from "@traycer/protocol/host/provider-native-schemas";

/** The routing fields survive the gate while the scope lists do not, which is exactly what separates "stripped
 * just now" from "never offered". */
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
