import type {
  AgentRunConfig,
  AgentSummary,
  ListAgentsResponse,
} from "@traycer/protocol/host";

/**
 * How much of each row a listing prints.
 *
 * `compact` is the row a caller needs to ADDRESS an agent and nothing else:
 * id, `[self]` / `[archived]`, title, `surface/harness` and the capability
 * token. It exists because a full row repeats every folder path the agent
 * runs in, and on a task with thousands of agents those paths are most of the
 * bytes.
 */
export type AgentListDetail = "full" | "compact";

export type AgentListRenderOptions = {
  readonly detail: AgentListDetail;
  /**
   * The window of agent rows to print: `offset` rows are skipped (an integer,
   * 0 or more) and at most `limit` follow (an integer, 1 or more). `null`
   * renders every row and never prints a footer.
   */
  readonly page: { readonly offset: number; readonly limit: number } | null;
};

/**
 * The whole listing at full detail. Kept beside {@link formatAgentListPage} as
 * the one-argument form every existing caller uses, and it is exactly that
 * function with nothing cut.
 */
export function formatAgentListResponse(response: ListAgentsResponse): string {
  return formatAgentListPage(response, { detail: "full", page: null });
}

/**
 * One page of a listing.
 *
 * The page is cut HERE, over the rows already placed in their sections, and
 * not by the caller slicing `response.agents`: which section a row belongs to
 * and which tree connector it carries are both decided from the whole set, so
 * a child on a later page is still printed under "Children" with its real
 * connector. Slice the input instead and the second page has no caller row,
 * and the rest of the listing falls back to one unlabelled forest.
 *
 * The order is the one a listing has always had, so a listing that fits on
 * one page reads exactly as it did before pages existed.
 */
export function formatAgentListPage(
  response: ListAgentsResponse,
  options: AgentListRenderOptions,
): string {
  const showSend = response.caller.canSendMessages;
  const sections = categorizeAgents(response.agents, response.caller.agentId);
  // Counted over the rows the sections hold, which is what a page can show, so
  // the footer's arithmetic always agrees with the rows a caller pages through.
  const total = sections.reduce(
    (count, section) => count + section.rows.length,
    0,
  );
  const window = resolvePageWindow(options.page, total);
  const pageSections = slicePageSections(sections, window);
  // Every legend gate below reads the rows this call actually prints. A legend
  // line for a marker that is on another page, or that `compact` leaves off the
  // row, explains something the reader cannot see.
  //
  // A listing that is NOT cut reads every agent the response holds instead,
  // which is what this formatter did before pages existed. The two sets
  // differ only when a row is in the response and printed nowhere - agents
  // whose parents form a cycle no root reaches - and a listing with nothing
  // cut must keep the bytes it has always had for that input too.
  const rendered = window.cut
    ? pageSections.flatMap((section) => section.rows.map((row) => row.agent))
    : response.agents;
  const full = options.detail === "full";
  // Gated on the flag being REPORTED rather than on any row being archived -
  // see `hasArchiveEnrichment`.
  const showArchived = rendered.some(hasArchiveEnrichment);
  const showRunConfig = full && rendered.some(hasRunConfigEnrichment);
  const showOwnerHostConnectivity =
    full && rendered.some(hasConnectivityEnrichment);
  // Gated on a row actually RENDERING the token rather than on the key being
  // present: `sessionState` is a schema field since `@9.1`, so it is present
  // and `null` on every row a host with nothing to report serves - and a
  // legend entry explaining a marker that appears nowhere is worse than no
  // entry.
  //
  // Reads the same narrowing the token does, rather than testing
  // `sessionState !== null` directly: a state the allowlist rejects renders no
  // token, so testing the raw field would light a legend for a marker that
  // appears on no row - exactly the case above, one step removed.
  const showSessionState =
    full && rendered.some((agent) => readAgentSessionState(agent) !== null);
  // Gated on a row PRINTING the token, cut or not. The gates above read every
  // agent of an uncut listing to keep the bytes that listing has always had;
  // this token is new, so it has no such bytes to keep, and a legend line for
  // a row that is in the response and printed nowhere would explain a marker
  // the reader cannot see.
  const showActivity =
    full &&
    pageSections.some((section) =>
      section.rows.some((row) => formatActivityToken(row.agent).length > 0),
    );
  const footer = formatAgentListFooter(window, total);
  return `${formatAgentListHeading(response)}
${formatAgentListBody(response, pageSections, window, total, showSend, options.detail)}

${formatAgentListLegend(
  options.detail,
  showSend,
  showArchived,
  showRunConfig,
  showOwnerHostConnectivity,
  showSessionState,
  showActivity,
)}${footer === null ? "" : `\n\n${footer}`}`;
}

/** One printed agent row: the agent, its tree connector, and the cycle mark. */
type AgentListRow = {
  readonly agent: AgentSummary;
  readonly prefix: string;
  readonly cycle: boolean;
};

/** A labelled group of rows; `heading` is `null` for the unlabelled forest. */
type AgentListSection = {
  readonly heading: string | null;
  readonly rows: readonly AgentListRow[];
};

/** Rows `start` (inclusive) to `end` (exclusive) of the listing's `total`. */
type AgentListPageWindow = {
  readonly start: number;
  readonly end: number;
  /**
   * Whether the window leaves any row out. False for an unpaged render and
   * for a page that holds every row, and those two print the same text: a
   * page only changes a listing it cuts.
   */
  readonly cut: boolean;
};

function resolvePageWindow(
  page: AgentListRenderOptions["page"],
  total: number,
): AgentListPageWindow {
  if (page === null) return { start: 0, end: total, cut: false };
  const start = Math.min(wholeNumberAtLeast(page.offset, 0), total);
  const end = Math.min(start + wholeNumberAtLeast(page.limit, 1), total);
  return { start, end, cut: start > 0 || end < total };
}

/**
 * The caller validates its own arguments; this only keeps a value that slipped
 * past (a fraction, a negative, `NaN`) from producing a window that prints
 * rows twice or a footer whose numbers do not add up.
 */
function wholeNumberAtLeast(value: number, floor: number): number {
  return Number.isFinite(value) ? Math.max(floor, Math.trunc(value)) : floor;
}

/**
 * The part of each section that falls inside the window. A section with no row
 * on the page is dropped with its heading; one that is cut keeps its heading,
 * so a row is never printed without the relationship it was listed under.
 */
function slicePageSections(
  sections: readonly AgentListSection[],
  window: AgentListPageWindow,
): readonly AgentListSection[] {
  // With nothing cut every section stays, including one whose members print
  // no row (the cycle case above): its heading has always been printed.
  if (!window.cut) return sections;
  const sliced: AgentListSection[] = [];
  let sectionStart = 0;
  for (const section of sections) {
    const from = Math.max(window.start - sectionStart, 0);
    const to = Math.min(window.end - sectionStart, section.rows.length);
    sectionStart += section.rows.length;
    if (to <= from) continue;
    sliced.push({
      heading: section.heading,
      rows: section.rows.slice(from, to),
    });
  }
  return sliced;
}

function formatAgentListBody(
  response: ListAgentsResponse,
  pageSections: readonly AgentListSection[],
  window: AgentListPageWindow,
  total: number,
  showSend: boolean,
  detail: AgentListDetail,
): string {
  if (response.agents.length === 0) {
    return `No agents found for scope '${response.scope}'.`;
  }
  if (window.cut && window.start >= total) {
    return `No agents on this page: the offset is past the end of the listing, which has ${total} agents. Pass offset=0 for the first page.`;
  }
  return pageSections
    .map((section) => {
      const lines = section.rows
        .map(
          (row) =>
            `${row.prefix}${formatAgentListLine(row.agent, showSend, detail)}${
              row.cycle ? " [cycle]" : ""
            }`,
        )
        .join("\n");
      return section.heading === null ? lines : `${section.heading}\n${lines}`;
    })
    .join("\n\n");
}

/**
 * The line that closes a listing whose page does not hold every row, or
 * `null` when it does. Rows are never left out without the text saying so,
 * and the line names the two arguments that make the listing smaller as well
 * as the one that fetches the rest.
 *
 * An offset past the end prints no footer: the body already says so, and
 * "Showing 451-450" would be a range that does not exist.
 */
function formatAgentListFooter(
  window: AgentListPageWindow,
  total: number,
): string | null {
  if (!window.cut) return null;
  if (window.start >= total) return null;
  const shown = `Showing ${window.start + 1}-${window.end} of ${total} agents`;
  const shrink = "archived='exclude' / detail='compact' to shrink the listing.";
  return window.end < total
    ? `${shown}; pass offset=${window.end} for the next page, or ${shrink}`
    : `${shown}; pass ${shrink}`;
}

/**
 * Names the task the rows were read from, when the listing says which.
 *
 * Every row is a bare agent id, so a listing that does not name its task is
 * not addressable by anyone it is forwarded to - and now that `agent.list` can
 * be asked about another task, one agent can hold listings from more than one
 * and has nothing to tell them apart by.
 *
 * Read at RUNTIME rather than typed, for the same reason
 * `ownerHostConnectivity` is on the rows: `listAgentsResponseSchema` has no
 * `epicId`, so a response that has been through it (the CLI path) has had the
 * key stripped and must keep the older wording rather than print a task it
 * cannot name. The direct host-side A2A listing carries it.
 */
function formatAgentListHeading(response: ListAgentsResponse): string {
  if (!("epicId" in response)) return "Agents in epic (relative to you):";
  const epicId = response.epicId;
  if (typeof epicId !== "string" || epicId.length === 0) {
    return "Agents in epic (relative to you):";
  }
  return `Agents in task '${epicId}' (relative to you):`;
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
 *
 * Returns the sections as rows rather than as text, in the order they print,
 * so a page can be cut out of them after every row has its section and its
 * tree connector.
 */
function categorizeAgents(
  agents: readonly AgentSummary[],
  callerAgentId: string,
): AgentListSection[] {
  if (agents.length === 0) return [];
  const caller = agents.find((agent) => agent.id === callerAgentId) ?? null;
  if (caller === null) {
    return [{ heading: null, rows: buildAgentForestRows(agents) }];
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

  const sections: AgentListSection[] = [
    { heading: "You:", rows: [flatAgentRow(caller)] },
  ];
  if (ancestors.length === 1) {
    sections.push({ heading: "Parent:", rows: [flatAgentRow(ancestors[0])] });
  } else if (ancestors.length > 1) {
    sections.push({
      heading: "Parent chain (nearest first):",
      rows: ancestors.map(flatAgentRow),
    });
  }
  if (siblingMembers.length > 0) {
    sections.push({
      heading: "Siblings:",
      rows: buildAgentForestRows(siblingMembers),
    });
  }
  if (childrenMembers.length > 0) {
    sections.push({
      heading: "Children (agents you spawned):",
      rows: buildAgentForestRows(childrenMembers),
    });
  }
  if (otherMembers.length > 0) {
    sections.push({
      heading: "Other agents (user-triggered):",
      rows: buildAgentForestRows(otherMembers),
    });
  }
  return sections;
}

/** A row printed on its own, outside any tree: no connector, never a cycle. */
function flatAgentRow(agent: AgentSummary): AgentListRow {
  return { agent, prefix: "", cycle: false };
}

/**
 * Lays a flat set of agents out as an indentation-tree forest, one row per
 * printed line. Roots are the members whose (effective) parent is not itself a
 * member of the set, so a category that contains a subtree renders it nested
 * while a category of unrelated agents renders them side by side.
 */
function buildAgentForestRows(
  members: readonly AgentSummary[],
): AgentListRow[] {
  const ids = new Set(members.map((agent) => agent.id));
  const childrenByParent = buildChildrenByParent(members, ids);
  return buildAgentTreeLevelRows(childrenByParent, null, "", new Set<string>());
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

function buildAgentTreeLevelRows(
  childrenByParent: ReadonlyMap<string | null, readonly AgentSummary[]>,
  parentId: string | null,
  prefix: string,
  ancestors: Set<string>,
): AgentListRow[] {
  const children = childrenByParent.get(parentId) ?? [];
  return children.flatMap((agent, index): AgentListRow[] => {
    const isLast = index === children.length - 1;
    const connector = parentId === null ? "" : isLast ? "└─ " : "├─ ";
    const childPrefix = parentId === null ? "" : prefix + connector;
    const nestedPrefix =
      parentId === null ? "" : prefix + (isLast ? "   " : "│  ");
    if (ancestors.has(agent.id)) {
      return [{ agent, prefix: childPrefix, cycle: true }];
    }
    ancestors.add(agent.id);
    const rows = [
      { agent, prefix: childPrefix, cycle: false },
      ...buildAgentTreeLevelRows(
        childrenByParent,
        agent.id,
        nestedPrefix,
        ancestors,
      ),
    ];
    ancestors.delete(agent.id);
    return rows;
  });
}

function formatAgentListLine(
  agent: AgentSummary,
  showSend: boolean,
  detail: AgentListDetail,
): string {
  const self = agent.isSelf ? " [self]" : "";
  const archived = isArchivedAgent(agent) ? " [archived]" : "";
  const parts = [
    `${agent.id}${self}${archived}${formatTitleToken(agent)}`,
    `${agent.surface}/${agent.harnessId ?? "-"}`,
  ];
  const full = detail === "full";
  const runConfig = full ? formatRunConfigToken(agent) : "";
  if (runConfig.length > 0) parts.push(runConfig);
  // The capability token describes what *the caller* can do to a row, so it is
  // meaningless on the caller's own [self] row (you don't read your own
  // transcript or message yourself). Showing "R/S" there is just misleading -
  // the [self] marker already identifies it.
  if (!agent.isSelf) {
    parts.push(formatCapabilityToken(agent, showSend));
  }
  // A compact row stops here: where the agent runs, its model, its session and
  // its owner host are what make a row long, and none of them is needed to
  // address it.
  if (!full) return parts.join(" ");
  const location = formatAgentLocation(agent);
  if (location.length > 0) parts.push(location);
  const activity = formatActivityToken(agent);
  if (activity.length > 0) parts.push(activity);
  const session = formatSessionStateToken(agent);
  if (session.length > 0) parts.push(session);
  const ownerHost = formatOwnerHostToken(agent);
  if (ownerHost.length > 0) parts.push(ownerHost);
  return parts.join(" ");
}

/**
 * The host's busy signal for the agent, so an orchestrator waiting on a silent
 * peer has something better than the silence to go on
 * (traycerai/traycer#2009).
 *
 * `active` is a released schema field the host fills from its activity
 * tracker, and the token is named for what that tracker measures, which is
 * not "a turn is running". For a GUI chat it stays true after a turn ends
 * while queued or scheduled work, a shell, a subagent or a background task is
 * outstanding; for a terminal agent without provider hooks it follows recent
 * output, so a long silent tool call reads false. So this is `activity:`,
 * never `turn:`, and the legend claims neither a live turn for `working` nor
 * finished work for `idle`.
 *
 * `active` is also `false` for every cross-host row, because the serving host
 * cannot see another machine's work. So the token renders on LOCAL rows only:
 * `activity: idle` on a remote row would turn "not observable" into a claim,
 * the same reason `session:` renders nothing for `null`.
 *
 * Omitted on the caller's own row, like the capability token: the question is
 * about a peer, and a `[self] ... activity: idle` line in front of the agent
 * that is reading it is noise at best.
 */
function formatActivityToken(agent: AgentSummary): string {
  if (agent.isSelf || !agent.isLocal) return "";
  return agent.active ? "activity: working" : "activity: idle";
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
 * Read straight off the row, with no `in` probe - unlike
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
 * Unlike `ownerHostConnectivity` this is a real `@9.1` schema field, so it
 * survives the wire and needs no `in` probe - but the allowlist is the same
 * defence. The enum is deliberately CLOSED (widening it is a new minor
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
 * Narrowed at RUNTIME rather than typed: `AgentSummary` has no such property,
 * so a listing that has been through the wire schema has had it stripped, and
 * this formatter renders both shapes. An unrecognised value reads as absent rather than being printed
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
  detail: AgentListDetail,
  showSend: boolean,
  showArchived: boolean,
  showRunConfig: boolean,
  showOwnerHostConnectivity: boolean,
  showSessionState: boolean,
  showActivity: boolean,
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
  // unarchives and wakes the agent. A host older than `agent.list@9.2` is why
  // the wording carries the whole burden - its rows reach a client with
  // `archived: null`, so there is no `[archived]` marker on the row to
  // contradict a finality claim in the legend.
  //
  // "running does NOT mean mid-turn": `running` reports that a session exists
  // on the binding host, which is equally true of an agent sitting idle at a
  // prompt for an hour. The host's busy signal is the `activity:` token, which
  // is absent on every row this host cannot observe.
  const sessionState = showSessionState
    ? "\nsession: <state>: the agent's own session as its binding host sees it - running (a live session exists on that host - the agent's process is up; it does NOT say the agent is mid-turn), sleeping (no live session; it RESUMES on your next message or when the agent is opened, so a sleeping peer is still addressable and is not dead), or stopped (the agent was archived, or deleted; a stopped row you can still see is almost always the archived case, because a deleted record drops out of the listing. An ARCHIVED agent is not over - it stays addressable, and your next message unarchives and wakes it; a deleted one is gone). 'last exit' says how the last session ended - reaped (idle), user-stop, restart, or process-exit - and is display detail only: all four resume identically. A row with no session token is one this host cannot observe (another machine's agent, a GUI chat, or a record older than the field), which is not the same as stopped"
    : "";
  // Three sentences carry the weight, one per way the signal is weaker than
  // it looks. "a working row may already have ended its turn": `active`
  // outlives the turn while queued, scheduled or background work is
  // outstanding. "reads idle even while it is still working": a terminal
  // agent's signal follows its output, not its process. "it has NOT
  // necessarily replied": a turn that ended without the reply it owed reads
  // idle too.
  const activity = showActivity
    ? "\nactivity: <state>: the host's busy signal for the agent, as this host tracks it - working (the host counts live or pending work for it: a turn, queued or scheduled work, or something it started in the background such as a shell, a subagent or a background task - so a working row may already have ended its turn: read its transcript to tell) or idle (the host currently reports no activity for it; it has NOT necessarily replied to you, and a terminal agent that has printed nothing for a while reads idle even while it is still working). Your own row carries none. Any other row with no activity token runs on another machine, whose activity this host cannot observe - that is not the same as idle"
    : "";
  // A compact row prints no location, so its legend explains none. The other
  // three detail entries are already off for it: their gates are false.
  const location =
    detail === "full"
      ? "\ndir: <path>: the working directory the agent runs in\nworktree: <path>: the agent runs in a dedicated git worktree"
      : "";
  if (!showSend) {
    return `Legend:
[self]: this agent, i.e. the caller of agent.list${archived}
"<title>": the agent's chat/session title (omitted when untitled)
R: the agent has a readable transcript
-: the agent has no readable transcript${location}${runConfig}${activity}${sessionState}${ownerHost}
Sending is unavailable in this session`;
  }
  return `Legend:
[self]: this agent, i.e. the caller of agent.list${archived}
"<title>": the agent's chat/session title (omitted when untitled)
R: the agent has a readable transcript
S: the agent can be sent messages to
R/S: the agent has a readable transcript and can be sent messages to
-: no available action${location}${runConfig}${activity}${sessionState}${ownerHost}`;
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
 * Whether this row REPORTS its archive status, which is what the legend entry
 * is gated on.
 *
 * `archived` is a wire field since `agent.list@9.2`: a host at or past it
 * answers `true` or `false`, and a host that predates it is upgraded to
 * `null`, "never asked". A hand-built row that skipped the schema may carry no
 * key at all. Both read as not reported.
 *
 * A boolean - not `true` - is what lights the entry: a listing whose agents
 * are all unarchived still carries `archived: false` on every row and must
 * keep explaining the marker, while a listing from an older host must never
 * advertise a marker none of its rows can show.
 */
function hasArchiveEnrichment(agent: AgentSummary): boolean {
  return typeof agent.archived === "boolean";
}

/**
 * Only an affirmative `true` marks a row. `null` and an absent key are "not
 * reported", which is neither archived nor live, and prints nothing.
 */
function isArchivedAgent(agent: AgentSummary): boolean {
  return agent.archived === true;
}
