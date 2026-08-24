import type {
  AgentSelectionGuideResponse,
  AgentSelectionGuideResponseSource,
} from "@traycer/protocol/host";

const TITLE = "# Agent Selection Guide";

const WORKSPACE_GUIDE_LABEL = ".traycer/agent-selection-guide.md";

const LAYERED_OPENER = `The instructions below are grouped by scope. Apply all of them. Where a workspace's instructions conflict with the global instructions, the workspace instructions take precedence and override global — they are more specific. For anything the workspace instructions do not address, follow the global instructions.`;

const MULTI_WORKSPACE_PARAGRAPH = `Multiple workspaces provide their own instructions below, each labeled by its path. Apply the instructions for the workspace that contains the files your task touches. If more than one workspace contains a file, the most specific workspace (the highest-priority workspace shown first) takes precedence and overrides broader workspace instructions.`;

const WORKSPACES_ONLY_OPENER = `Each workspace's instructions apply to work on files under that workspace; multiple workspaces provide instructions below, labeled by path. Apply the instructions for the workspace that contains the files your task touches. If more than one workspace contains a file, the most specific workspace (the highest-priority workspace shown first) takes precedence and overrides broader workspace instructions.`;

export const A2A_PERMISSION_MODE_INSTRUCTION =
  "Use `full_access` unless the user's agent selection guide explicitly instructs you to use `supervised` or `auto_accept_edits`; never infer a more restrictive permission mode from the task, the current or parent agent's mode, or a general safety preference.";

function withPermissionModeInstruction(content: string): string {
  return `${content}\n\nPermission mode: ${A2A_PERMISSION_MODE_INSTRUCTION}`;
}

/**
 * The single place that renders the agent selection guide into the text both
 * the CLI command and the GUI A2A tool hand to an agent.
 *
 * The host returns the contributing guide files unjoined. This formatter owns
 * their precedence framing and layout. A lone guide is plain attributed
 * content. Multiple guides are ordered by priority and explain how workspace
 * instructions refine the global guide. The permission invariant is always
 * appended so silence about permissions cannot authorize a restrictive mode.
 */
export function formatAgentSelectionGuideResponse(
  response: AgentSelectionGuideResponse,
): string {
  if (response.status === "not_found") {
    return withPermissionModeInstruction(response.message);
  }

  if (response.sources.length === 0) {
    return withPermissionModeInstruction("No agent selection guide found.");
  }

  // Most specific first. Do not rely on the order sent by the host.
  const sources = [...response.sources].sort(
    (left, right) => right.priority - left.priority,
  );

  if (sources.length === 1) {
    const only = sources[0];
    return withPermissionModeInstruction(
      `Agent selection instructions from ${only.path}:\n\n${only.content.trimEnd()}`,
    );
  }

  const blocks = sources
    .map((source) => `${sectionHeader(source)}\n${source.content.trimEnd()}`)
    .join("\n\n");
  return withPermissionModeInstruction(
    `${TITLE}\n\n${opener(sources)}\n\n${blocks}`,
  );
}

function opener(sources: readonly AgentSelectionGuideResponseSource[]): string {
  const hasGlobal = sources.some((source) => source.kind === "global");
  if (!hasGlobal) return WORKSPACES_ONLY_OPENER;

  const workspaceCount = sources.filter(
    (source) => source.kind === "workspace",
  ).length;
  return workspaceCount >= 2
    ? `${LAYERED_OPENER}\n\n${MULTI_WORKSPACE_PARAGRAPH}`
    : LAYERED_OPENER;
}

function sectionHeader(source: AgentSelectionGuideResponseSource): string {
  if (source.kind === "global") {
    return `## Global instructions (${source.path})`;
  }
  return `## Workspace instructions — ${source.workspacePath} (${WORKSPACE_GUIDE_LABEL})`;
}
