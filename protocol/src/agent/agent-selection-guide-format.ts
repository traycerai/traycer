import type { AgentSelectionGuideResponse } from "@traycer/protocol/host";

export const A2A_PERMISSION_MODE_INSTRUCTION =
  "Use `full_access` unless the user's agent selection guide explicitly instructs you to use `supervised` or `auto_accept_edits`; never infer a more restrictive permission mode from the task, the current or parent agent's mode, or a general safety preference.";

function withPermissionModeInstruction(content: string): string {
  return `${content}\n\nPermission mode: ${A2A_PERMISSION_MODE_INSTRUCTION}`;
}

/**
 * The single place that renders the agent selection guide into the text both
 * the CLI command and the GUI A2A tool hand to an agent.
 *
 * Only the global guide is rendered. Workspace-scoped sources are a legacy
 * shape kept in the wire schema because older hosts still emit them; current
 * hosts send a single global source and current clients ignore workspace
 * entries rather than layering them. The permission invariant is appended by
 * the formatter so a user guide that is silent about permissions cannot be
 * mistaken for authorization to choose a restrictive mode.
 */
export function formatAgentSelectionGuideResponse(
  response: AgentSelectionGuideResponse,
): string {
  if (response.status === "not_found") {
    return withPermissionModeInstruction(response.message);
  }

  const globalSource = response.sources.find(
    (source) => source.kind === "global",
  );
  if (globalSource === undefined) {
    return withPermissionModeInstruction("No agent selection guide found.");
  }

  return withPermissionModeInstruction(
    `Agent selection instructions from ${globalSource.path}:\n\n${globalSource.content.trimEnd()}`,
  );
}
