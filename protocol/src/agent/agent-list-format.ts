import type {
  AgentRunConfig,
  AgentSummary,
  ListAgentsResponse,
} from "@traycer/protocol/host";

export function formatAgentListResponse(response: ListAgentsResponse): string {
  const agents = response.agents;
  const showSend = response.caller.canSendMessages;
  // Only the direct host-enriched listing can ever render an [archived] row, so
  // the legend entry is gated on the enrichment actually being present rather
  // than on any row being archived - see `hasArchiveEnrichment`.
  const showArchived = agents.some(hasArchiveEnrichment);
  const showRunConfig = agents.some(hasRunConfigEnrichment);
  const showOwnerHostConnectivity = agents.some(hasConnectivityEnrichment);
  // Gated on a row actually RENDERING the token rather than on the key being
  // present, which is the difference from the three gates above: `@9.1` makes
  // `sessionState` a real schema field, so it is present and `null` on every
  // row a host with nothing to report serves - and a legend entry explaining a
  // marker that appears nowhere is worse than no entry.
  //
  // Reads the same narrowing the token does, rather than testing
  // `sessionState !== null` directly: a state the allowlist rejects renders no
  // token, so testing the raw field would light a legend for a marker that
  // appears on no row - exactly the case above, one step removed.
  const showSessionState = agents.some(
    (agent) => readAgentSessionState(agent) !== null,
  );
  const body =
    agents.length === 0
      ? `No agents found for scope '${response.scope}'.`
      : formatCategorizedAgents(agents, response.caller.agentId, showSend);
  return `Agents in epic (relative to you):
${body}

${formatAgentListLegend(
  showSend,
  showArchived,
  showRunConfig,
  showOwnerHostConnectivity,
  showSessionState,
)}`;
}

export function formatAgentSelf(agent: AgentSummary | null): string {
  if (agent === null) return "Current agent not found.";
  return [
    agent.id,
    `title: ${agent.title ?? "-"}`,
    `archived: ${isArchivedAgent(agent) ? "yes" : "no"}`,
    `surface: ${agent.surface}`,
    `harness: ${agent.harnessId ?? "-"}`,
    ...formatRunConfigSelfLines(agent),
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
  const archived = isArchivedAgent(agent) ? " [archived]" : "";
  const parts = [
    `${agent.id}${self}${archived}${formatTitleToken(agent)}`,
    `${agent.surface}/${agent.harnessId ?? "-"}`,
  ];
  const runConfig = formatRunConfigToken(agent);
  if (runConfig.length > 0) parts.push(runConfig);
  // The capability token describes what *the caller* can do to a row, so it is
  // meaningless on the caller's own [self] row (you don't read your own
  // transcript or message yourself). Showing "R/S" there is just misleading -
  // the [self] marker already identifies it.
  if (!agent.isSelf) {
    parts.push(formatCapabilityToken(agent, showSend));
  }
  const location = formatAgentLocation(agent);
  if (location.length > 0) parts.push(location);
  const session = formatSessionStateToken(agent);
  if (session.length > 0) parts.push(session);
  const ownerHost = formatOwnerHostToken(agent);
  if (ownerHost.length > 0) parts.push(ownerHost);
  return parts.join(" ");
}

/**
 * The agent's session state, so a silent peer is not read as a dead one.
 *
 * `active` says whether the agent is executing right now and says nothing
 * about what a `false` MEANS: an agent between turns, an agent whose session
 * was idle-reaped, and an archived agent all looked identical, so an
 * orchestrator enumerating its peers concluded a reaped one had died and
 * stopped addressing it. A reaped agent resumes on the very next message.
 *
 * Read straight off the row, with no `in` probe - unlike `archived` and
 * `ownerHostConnectivity`, this is a real `@9.1` schema field, so the wire
 * carries it and the `@9.0 -> @9.1` upgrade path fills `null` for a host that
 * predates it.
 *
 * `null` renders NOTHING, and the absence is the honest report: the serving
 * host cannot know (a cross-host row, a GUI chat with no session, a record
 * older than the facet). Printing a word there would turn "not observable"
 * into a claim. The reason rides the `sleeping` arm only - it is the state
 * where "how did it end" is a question anyone asks, and a `running` agent's
 * previous exit would read as a current one.
 */
function formatSessionStateToken(agent: AgentSummary): string {
  const state = readAgentSessionState(agent);
  if (state === null) return "";
  if (state !== "sleeping" || agent.lastExit === null) {
    return `session: ${state}`;
  }
  return `session: ${state} (last exit: ${agent.lastExit})`;
}

/**
 * The three words the legend can explain. Kept as a value for the same reason
 * `OWNER_HOST_CONNECTIVITY_WORDS` is: so an unrecognised state degrades to
 * "not observable" instead of putting a token in front of a model whose legend
 * cannot describe it.
 */
const AGENT_SESSION_STATE_WORDS = ["running", "sleeping", "stopped"] as const;

type AgentSessionStateWord = (typeof AGENT_SESSION_STATE_WORDS)[number];

/**
 * `sessionState` off a row, narrowed to a word the legend covers.
 *
 * Unlike `archived` and `ownerHostConnectivity` this is a real `@9.1` schema
 * field, so it survives the wire and needs no `in` probe - but the allowlist is
 * the same defence. The enum is deliberately CLOSED (widening it is a new minor
 * with the response growth declared), so a fourth word can only reach here from
 * a host this build does not understand, and an absent key can only reach here
 * from a hand-built summary that skipped the schema. Both render as absent:
 * `session: undefined` in front of an orchestrator is strictly worse than no
 * token, which is the honest report for a state we cannot explain.
 */
function readAgentSessionState(
  agent: AgentSummary,
): AgentSessionStateWord | null {
  const value = agent.sessionState;
  return AGENT_SESSION_STATE_WORDS.find((word) => word === value) ?? null;
}

/**
 * The three words the host may attach to a row, in the order a reader is most
 * likely to care about. Kept as a value, not only a type, so the runtime
 * narrowing below has something to check an unknown property against.
 */
const OWNER_HOST_CONNECTIVITY_WORDS = [
  "connectable",
  "offline",
  "unknown",
] as const;

type OwnerHostConnectivityWord = (typeof OWNER_HOST_CONNECTIVITY_WORDS)[number];

/**
 * `ownerHostConnectivity` off a row, or `null` when the row does not carry it.
 *
 * Narrowed at RUNTIME rather than typed, for the same reason `archived` is: the
 * released `AgentSummary` has no such property, so a listing that has been
 * through the wire schema has had it stripped, and this formatter renders both
 * shapes. An unrecognised value reads as absent rather than being printed
 * verbatim - a newer host inventing a fourth word must not put an unexplained
 * token in front of a model whose legend cannot describe it.
 */
function readOwnerHostConnectivity(
  agent: AgentSummary,
): OwnerHostConnectivityWord | null {
  if (!("ownerHostConnectivity" in agent)) return null;
  const value = agent.ownerHostConnectivity;
  return OWNER_HOST_CONNECTIVITY_WORDS.find((word) => word === value) ?? null;
}

function hasConnectivityEnrichment(agent: AgentSummary): boolean {
  return readOwnerHostConnectivity(agent) !== null;
}

/**
 * Rendered on every enriched row, including `connectable` ones. A field that
 * appears only when something is wrong reads as noise-free until the day it
 * matters, and then a reader cannot tell "reachable" from "this build does not
 * report it" - which is exactly the distinction an agent deciding whether to
 * address a remote peer needs.
 */
function formatOwnerHostToken(agent: AgentSummary): string {
  const connectivity = readOwnerHostConnectivity(agent);
  return connectivity === null ? "" : `owner host: ${connectivity}`;
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

function formatAgentListLegend(
  showSend: boolean,
  showArchived: boolean,
  showRunConfig: boolean,
  showOwnerHostConnectivity: boolean,
  showSessionState: boolean,
): string {
  const archived = showArchived
    ? "\n[archived]: the agent/chat is archived and treated as inactive until its next user or A2A message"
    : "";
  const runConfig = showRunConfig
    ? "\nmodel: <slug>: the configured model (provider default means the TUI provider resolves it)\neffort: <level>: the configured reasoning effort; omitted when absent\nfast: fast mode is enabled"
    : "";
  // The caveat is not optional politeness: without it `unknown` reads as
  // "probably down", and it is the value EVERY row belonging to another user
  // carries - the host directory lists only the machines on your own account,
  // so another person's host cannot appear in it at all.
  const ownerHost = showOwnerHostConnectivity
    ? "\nowner host: <state>: whether the machine running the agent is reachable - connectable, offline, or unknown. It is a real answer only for your OWN hosts; a row owned by another user is always unknown, because the host directory lists only your own machines - unknown there means not observable, not down"
    : "";
  // Three sentences here are load-bearing, not politeness, and each one is
  // pinned literally by a test because a paraphrase would quietly undo it.
  //
  // "sleeping is not dead": an orchestrator that reads a reaped peer as gone
  // stops addressing it, which is the failure this field was added for.
  //
  // "an ARCHIVED agent is not over": `stopped` reaching a reader essentially
  // always MEANS archived. The archive mutation is what writes it (see
  // `registry-backed-tui-agent-storage`), and the only other writer - the
  // `delete` exit arm - stamps a record that is tombstoned out of the listing
  // before anyone can enumerate it. So a bare "the agent is over" documented
  // the unreachable case and asserted finality about the reachable one, while
  // archiving is explicitly recoverable: a later user or A2A message
  // unarchives and wakes the agent. The CLI is why the wording carries the
  // whole burden - it parses through the wire schema, which has no `archived`
  // key, so there is no `[archived]` marker on the row to contradict a
  // finality claim in the legend.
  //
  // "running does NOT mean mid-turn": `active` is the executing-right-now
  // field and this formatter never renders it, so `running` is the listing's
  // only liveness word. It reports that a session exists on the binding host,
  // which is equally true of an agent sitting idle at a prompt for an hour.
  const sessionState = showSessionState
    ? "\nsession: <state>: the agent's own session as its binding host sees it - running (a live session exists on that host - the agent's process is up; it does NOT say the agent is mid-turn), sleeping (no live session; it RESUMES on your next message or when the agent is opened, so a sleeping peer is still addressable and is not dead), or stopped (the agent was archived, or deleted; a stopped row you can still see is almost always the archived case, because a deleted record drops out of the listing. An ARCHIVED agent is not over - it stays addressable, and your next message unarchives and wakes it; a deleted one is gone). 'last exit' says how the last session ended - reaped (idle), user-stop, restart, or process-exit - and is display detail only: all four resume identically. A row with no session token is one this host cannot observe (another machine's agent, a GUI chat, or a record older than the field), which is not the same as stopped"
    : "";
  if (!showSend) {
    return `Legend:
[self]: this agent, i.e. the caller of agent.list${archived}
"<title>": the agent's chat/session title (omitted when untitled)
R: the agent has a readable transcript
-: the agent has no readable transcript
dir: <path>: the working directory the agent runs in
worktree: <path>: the agent runs in a dedicated git worktree${runConfig}${sessionState}${ownerHost}
Sending is unavailable in this session`;
  }
  return `Legend:
[self]: this agent, i.e. the caller of agent.list${archived}
"<title>": the agent's chat/session title (omitted when untitled)
R: the agent has a readable transcript
S: the agent can be sent messages to
R/S: the agent has a readable transcript and can be sent messages to
-: no available action
dir: <path>: the working directory the agent runs in
worktree: <path>: the agent runs in a dedicated git worktree${runConfig}${sessionState}${ownerHost}`;
}

function hasRunConfigEnrichment(agent: AgentSummary): boolean {
  return agent.runConfig !== null;
}

function formatRunConfigModel(model: AgentRunConfig["model"]): string {
  return model.kind === "concrete" ? model.slug : "provider default";
}

function formatRunConfigToken(agent: AgentSummary): string {
  if (agent.runConfig === null) return "";
  const parts = [`model: ${formatRunConfigModel(agent.runConfig.model)}`];
  if (agent.runConfig.reasoningEffort !== null) {
    parts.push(`effort: ${agent.runConfig.reasoningEffort}`);
  }
  if (agent.runConfig.fastMode === true) parts.push("fast");
  return parts.join(" ");
}

function formatRunConfigSelfLines(agent: AgentSummary): string[] {
  if (agent.runConfig === null) return [];
  const lines = [`model: ${formatRunConfigModel(agent.runConfig.model)}`];
  if (agent.runConfig.reasoningEffort !== null) {
    lines.push(`effort: ${agent.runConfig.reasoningEffort}`);
  }
  if (agent.runConfig.fastMode !== null) {
    lines.push(`fast: ${agent.runConfig.fastMode ? "yes" : "no"}`);
  }
  return lines;
}

/**
 * The direct host-side A2A list enriches the released RPC row with an
 * `archived` flag before calling this formatter. The versioned `agent.list`
 * wire schema intentionally remains unchanged, so a response that has been
 * through `listAgentsResponseSchema` (the CLI path) has the key stripped and
 * carries no archive information at all.
 *
 * Presence - not truthiness - is what distinguishes the two: an enriched
 * listing whose agents are all unarchived still carries `archived: false` on
 * every row, and must keep explaining the marker, while a stripped listing must
 * never advertise a marker its schema cannot represent.
 */
function hasArchiveEnrichment(agent: AgentSummary): boolean {
  return "archived" in agent;
}

/**
 * Archived rows are only ever marked on the enriched surface: an absent key can
 * never be `true`, so the row marker needs no separate gate.
 */
function isArchivedAgent(agent: AgentSummary): boolean {
  return "archived" in agent && agent.archived === true;
}
