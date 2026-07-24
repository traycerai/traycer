import type { AgentSelectionGuideResponse } from "@traycer/protocol/host";

/**
 * The single place that renders the agent selection guide into the text both
 * the CLI command and the GUI A2A tool hand to an agent.
 *
 * Only the global guide is rendered. Workspace-scoped sources are a legacy
 * shape kept in the wire schema because older hosts still emit them; current
 * hosts send a single global source and current clients ignore workspace
 * entries rather than layering them.
 */
export function formatAgentSelectionGuideResponse(
  response: AgentSelectionGuideResponse,
): string {
  if (response.status === "not_found") return response.message;

  const globalSource = response.sources.find(
    (source) => source.kind === "global",
  );
  if (globalSource === undefined) return "No agent selection guide found.";

  return `Agent selection instructions from ${globalSource.path}:\n\n${globalSource.content.trimEnd()}`;
}
