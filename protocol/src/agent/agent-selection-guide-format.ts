import type {
  AgentSelectionGuideResponse,
  AgentSelectionGuideResponseSource,
} from "@traycer/protocol/host";

const TITLE = "# Agent Selection Guide";

// Cosmetic label appended to a workspace header so the reader knows the file
// inside the workspace root, without the host sending a redundant path.
const WORKSPACE_GUIDE_LABEL = ".traycer/agent-selection-guide.md";

// Leads with the operative rule (apply every layer) so an agent never reads the
// section ordering as first-wins; the conflict and fallback rules follow.
const LAYERED_OPENER = `The instructions below are grouped by scope. Apply all of them. Where a workspace's instructions conflict with the global instructions, the workspace instructions take precedence and override global — they are more specific. For anything the workspace instructions do not address, follow the global instructions.`;

const MULTI_WORKSPACE_PARAGRAPH = `Multiple workspaces provide their own instructions below, each labeled by its path. Apply the instructions for the workspace that contains the files your task touches.`;

// No global guide exists, so there is nothing to override or fall back to —
// the framing reduces to picking the right workspace's instructions.
const WORKSPACES_ONLY_OPENER = `Each workspace's instructions apply to work on files under that workspace; multiple workspaces provide instructions below, labeled by path. Apply the instructions for the workspace that contains the files your task touches.`;

/**
 * The single place that renders the agent selection guide into the text both
 * the CLI command and the GUI A2A tool hand to an agent. The host returns the
 * contributing guide files unjoined; precedence framing and layout live here.
 *
 * The framing scales to what is actually present: a lone guide is plain
 * attributed content with no precedence preamble, while two or more blocks gain
 * the layering opener (and, with two or more workspace blocks, the per-workspace
 * selection paragraph).
 */
export function formatAgentSelectionGuideResponse(
  response: AgentSelectionGuideResponse,
): string {
  if (response.status === "not_found") return response.message;

  if (response.sources.length === 0) return "No agent selection guide found.";

  // Most specific first; never rely on the order the host happened to send.
  const sources = [...response.sources].sort(
    (left, right) => right.priority - left.priority,
  );

  if (sources.length === 1) {
    const only = sources[0];
    return `Agent selection instructions from ${only.path}:\n\n${only.content.trimEnd()}`;
  }

  const blocks = sources
    .map((source) => `${sectionHeader(source)}\n${source.content.trimEnd()}`)
    .join("\n\n");
  return `${TITLE}\n\n${opener(sources)}\n\n${blocks}`;
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
  if (source.kind === "global")
    return `## Global instructions (${source.path})`;
  return `## Workspace instructions — ${source.workspacePath} (${WORKSPACE_GUIDE_LABEL})`;
}
