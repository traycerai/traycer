import type { AgentSummary, ListAgentsResponse } from "@traycer/protocol/host";

export function formatAgentListResponse(response: ListAgentsResponse): string {
  const agents = response.agents;
  const showSend = response.caller.canSendMessages;
  const body =
    agents.length === 0
      ? `No agents found for scope '${response.scope}'.`
      : formatCategorizedAgents(agents, response.caller.agentId, showSend);
  return `Agents in epic (relative to you):
${body}

${formatAgentListLegend(showSend)}`;
}

export function formatAgentSelf(agent: AgentSummary | null): string {
  if (agent === null) return "Current agent not found.";
  return [
    agent.id,
    `title: ${agent.title ?? "-"}`,
    `surface: ${agent.surface}`,
    `harness: ${agent.harnessId ?? "-"}`,
    `host: ${agent.hostId}`,
    formatSelfLocationLine(agent),
  ].join("\n");
}

/**
 * Renders where the current agent runs as a `dir:`/`worktree:` line so
 * `traycer_get_self` carries the same location detail the list rows already
 * expose - the agent should be able to report its own working directory (or
 * dedicated git worktree) without a separate list call. Falls back to `-` when
 * no folder paths are known (e.g. a chat with no resolved workspace context).
 */
function formatSelfLocationLine(agent: AgentSummary): string {
  // With no resolvable path there is nothing to label as a worktree, so report
  // a neutral `dir: -` rather than the self-contradictory `worktree: -`.
  if (agent.folderPaths.length === 0) return "dir: -";
  return `${agentLocationLabel(agent)}: ${agent.folderPaths.join(", ")}`;
}

/**
 * Groups the visible agents by their relationship to the caller (the agent
 * that issued `agent.list`) and renders one labelled section per group:
 *
 *   - **You** - the caller itself.
 *   - **Parent** - the agent that spawned the caller (if any).
 *   - **Siblings** - agents sharing the caller's parent, each with its own
 *     delegated subtree nested beneath it.
 *   - **Children** - agents the caller spawned, with their subtrees.
 *   - **Other agents (user-triggered)** - everything else: top-level agents the
 *     user started directly plus any unrelated subtrees.
 *
 * Caller identity comes from `caller.agentId` - the same `senderAgentId` the
 * host resolves when launching child agents - so categorization is always
 * anchored on the requesting agent. When the caller is not present in the
 * visible set (unexpected), the whole list falls back to a single relationship
 * forest so no agent is dropped.
 */
function formatCategorizedAgents(
  agents: readonly AgentSummary[],
  callerAgentId: string,
  showSend: boolean,
): string {
  const caller = agents.find((agent) => agent.id === callerAgentId) ?? null;
  if (caller === null) {
    return renderAgentForest(agents, showSend);
  }

  const ids = new Set(agents.map((agent) => agent.id));
  const childrenByParent = buildChildrenByParent(agents, ids);

  // The caller's full upward lineage (immediate parent, grandparent, ...).
  // Walking the entire chain - not just the immediate parent - keeps an
  // ancestor out of the "Other agents (user-triggered)" bucket, where it would
  // be mislabelled as unrelated. Visible siblings are still anchored on the
  // immediate parent only.
  const ancestors: AgentSummary[] = [];
  const ancestorIds = new Set<string>();
  let ancestorCursor = caller.parentId;
  while (
    ancestorCursor !== null &&
    ids.has(ancestorCursor) &&
    !ancestorIds.has(ancestorCursor)
  ) {
    const ancestor = agents.find((agent) => agent.id === ancestorCursor);
    if (ancestor === undefined) break;
    ancestors.push(ancestor);
    ancestorIds.add(ancestor.id);
    ancestorCursor = ancestor.parentId;
  }
  const effectiveParentId = ancestors.length > 0 ? ancestors[0].id : null;

  const callerDescendants = collectDescendantIds(caller.id, childrenByParent);

  const directSiblings =
    effectiveParentId === null
      ? []
      : (childrenByParent.get(effectiveParentId) ?? []).filter(
          (agent) => agent.id !== caller.id,
        );
  const siblingMemberIds = new Set<string>();
  for (const sibling of directSiblings) {
    siblingMemberIds.add(sibling.id);
    for (const id of collectDescendantIds(sibling.id, childrenByParent)) {
      siblingMemberIds.add(id);
    }
  }

  const consumed = new Set<string>([caller.id]);
  for (const ancestor of ancestors) consumed.add(ancestor.id);
  for (const id of callerDescendants) consumed.add(id);
  for (const id of siblingMemberIds) consumed.add(id);

  const childrenMembers = agents.filter((agent) =>
    callerDescendants.has(agent.id),
  );
  const siblingMembers = agents.filter((agent) =>
    siblingMemberIds.has(agent.id),
  );
  const otherMembers = agents.filter((agent) => !consumed.has(agent.id));

  const sections: string[] = [`You:\n${formatAgentListLine(caller, showSend)}`];
  if (ancestors.length === 1) {
    sections.push(`Parent:\n${formatAgentListLine(ancestors[0], showSend)}`);
  } else if (ancestors.length > 1) {
    sections.push(
      `Parent chain (nearest first):\n${ancestors
        .map((ancestor) => formatAgentListLine(ancestor, showSend))
        .join("\n")}`,
    );
  }
  if (siblingMembers.length > 0) {
    sections.push(`Siblings:\n${renderAgentForest(siblingMembers, showSend)}`);
  }
  if (childrenMembers.length > 0) {
    sections.push(
      `Children (agents you spawned):\n${renderAgentForest(
        childrenMembers,
        showSend,
      )}`,
    );
  }
  if (otherMembers.length > 0) {
    sections.push(
      `Other agents (user-triggered):\n${renderAgentForest(
        otherMembers,
        showSend,
      )}`,
    );
  }
  return sections.join("\n\n");
}

/**
 * Renders a flat set of agents as an indentation-tree forest. Roots are the
 * members whose (effective) parent is not itself a member of the set, so a
 * category that contains a subtree renders it nested while a category of
 * unrelated agents renders them side by side.
 */
function renderAgentForest(
  members: readonly AgentSummary[],
  showSend: boolean,
): string {
  const ids = new Set(members.map((agent) => agent.id));
  const childrenByParent = buildChildrenByParent(members, ids);
  return formatAgentTreeLevel(
    childrenByParent,
    null,
    "",
    showSend,
    new Set<string>(),
  ).join("\n");
}

function buildChildrenByParent(
  agents: readonly AgentSummary[],
  ids: ReadonlySet<string>,
): Map<string | null, AgentSummary[]> {
  const childrenByParent = new Map<string | null, AgentSummary[]>();
  agents.forEach((agent) => {
    const parentId =
      agent.parentId !== null && ids.has(agent.parentId)
        ? agent.parentId
        : null;
    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) {
      childrenByParent.set(parentId, [agent]);
      return;
    }
    siblings.push(agent);
  });
  return childrenByParent;
}

function collectDescendantIds(
  rootId: string,
  childrenByParent: ReadonlyMap<string | null, readonly AgentSummary[]>,
): Set<string> {
  const out = new Set<string>();
  const walk = (parentId: string): void => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (out.has(child.id)) continue;
      out.add(child.id);
      walk(child.id);
    }
  };
  walk(rootId);
  return out;
}

function formatAgentTreeLevel(
  childrenByParent: ReadonlyMap<string | null, readonly AgentSummary[]>,
  parentId: string | null,
  prefix: string,
  showSend: boolean,
  ancestors: Set<string>,
): string[] {
  const children = childrenByParent.get(parentId) ?? [];
  return children.flatMap((agent, index) => {
    const isLast = index === children.length - 1;
    const connector = parentId === null ? "" : isLast ? "└─ " : "├─ ";
    const childPrefix = parentId === null ? "" : prefix + connector;
    const nestedPrefix =
      parentId === null ? "" : prefix + (isLast ? "   " : "│  ");
    if (ancestors.has(agent.id)) {
      return [`${childPrefix}${formatAgentListLine(agent, showSend)} [cycle]`];
    }
    ancestors.add(agent.id);
    const lines = [
      `${childPrefix}${formatAgentListLine(agent, showSend)}`,
      ...formatAgentTreeLevel(
        childrenByParent,
        agent.id,
        nestedPrefix,
        showSend,
        ancestors,
      ),
    ];
    ancestors.delete(agent.id);
    return lines;
  });
}

function formatAgentListLine(agent: AgentSummary, showSend: boolean): string {
  const self = agent.isSelf ? " [self]" : "";
  const parts = [
    `${agent.id}${self}${formatTitleToken(agent)}`,
    `${agent.surface}/${agent.harnessId ?? "-"}`,
  ];
  // The capability token describes what *the caller* can do to a row, so it is
  // meaningless on the caller's own [self] row (you don't read your own
  // transcript or message yourself). Showing "R/S" there is just misleading -
  // the [self] marker already identifies it.
  if (!agent.isSelf) {
    parts.push(formatCapabilityToken(agent, showSend));
  }
  const location = formatAgentLocation(agent);
  if (location.length > 0) parts.push(location);
  return parts.join(" ");
}

// Quoted title placed right after the id (and [self] marker) so the agent can
// tell rows apart by what they're working on. Omitted entirely for untitled
// agents - the absence reads as "untitled" and keeps the line uncluttered.
function formatTitleToken(agent: AgentSummary): string {
  return agent.title === null ? "" : ` "${agent.title}"`;
}

function agentLocationLabel(agent: AgentSummary): "worktree" | "dir" {
  return agent.isWorktree ? "worktree" : "dir";
}

/**
 * Appends where the agent runs to its list line so a caller can tell which
 * agents share a directory and which run in their own git worktree. Omitted
 * entirely when no folder paths are known (e.g. a cross-host GUI row). A
 * cross-host (other-device) row's paths live on a machine the caller can't
 * reach, so they are marked `(other device)` rather than presented as a
 * directory the caller could share.
 *
 * Returns a bare `dir:`/`worktree:` token (no leading separator) - the caller
 * joins line parts with spaces. An earlier em-dash separator read as the `-`
 * "no available action" capability token, so it was dropped; the `dir:` /
 * `worktree:` label already sets the location apart.
 */
function formatAgentLocation(agent: AgentSummary): string {
  // No resolvable path -> no location suffix (and no bare "worktree" claim with
  // nothing to back it).
  if (agent.folderPaths.length === 0) return "";
  const remote = agent.isLocal ? "" : " (other device)";
  return `${agentLocationLabel(agent)}: ${agent.folderPaths.join(
    ", ",
  )}${remote}`;
}

function formatCapabilityToken(agent: AgentSummary, showSend: boolean): string {
  const read = agent.capabilities.readTranscript;
  const send = agent.capabilities.sendMessage;
  if (!showSend) return read ? "R" : "-";
  if (read && send) return "R/S";
  if (read) return "R";
  if (send) return "S";
  return "-";
}

function formatAgentListLegend(showSend: boolean): string {
  if (!showSend) {
    return `Legend:
[self]: this agent, i.e. the caller of agent.list
"<title>": the agent's chat/session title (omitted when untitled)
R: the agent has a readable transcript
-: the agent has no readable transcript
dir: <path>: the working directory the agent runs in
worktree: <path>: the agent runs in a dedicated git worktree
Sending is unavailable in this session`;
  }
  return `Legend:
[self]: this agent, i.e. the caller of agent.list
"<title>": the agent's chat/session title (omitted when untitled)
R: the agent has a readable transcript
S: the agent can be sent messages to
R/S: the agent has a readable transcript and can be sent messages to
-: no available action
dir: <path>: the working directory the agent runs in
worktree: <path>: the agent runs in a dedicated git worktree`;
}
