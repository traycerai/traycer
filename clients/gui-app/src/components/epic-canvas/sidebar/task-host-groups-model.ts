import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";

/** The reach mark, verbatim from the surfaces page. */
export const TASK_HOST_UNREACHABLE_LINE = "not reachable from this host";
export const TASK_HOST_UNNAMED_LABEL = "Unnamed host";

export type TaskHostState = "online" | "offline";

/**
 * The task's hosts that this host's principal does not reach, from the server's
 * `reach` alone: the Agents tree marks the agents on them.
 */
export function otherPrincipalHostIds(
  hosts: readonly TaskHostRow[],
): ReadonlySet<string> {
  return new Set(
    hosts
      .filter((row) => row.reach === "other_principal")
      .map((row) => row.hostId),
  );
}

/**
 * A host in the person's own host directory: its label, and its state or
 * `null` when the directory cannot say.
 */
export interface TaskHostDirectoryFact {
  readonly label: string;
  readonly state: TaskHostState | null;
}

export interface TaskHostGroupsInput {
  readonly hosts: readonly TaskHostRow[];
  readonly viewerUserId: string;
  /** The person's teams, named by slug. */
  readonly teams: readonly { readonly teamId: string; readonly name: string }[];
  /** A collaborator's display name by user id. */
  readonly collaboratorNames: ReadonlyMap<string, string>;
  /** The person's host directory, by host id. */
  readonly directory: ReadonlyMap<string, TaskHostDirectoryFact>;
  /** The task's published chats per owning host. */
  readonly agentCountByHostId: ReadonlyMap<string, number>;
}

export interface TaskHostGroupRow {
  readonly hostId: string;
  readonly label: string;
  readonly agentsLine: string | null;
  /** From the server's `reach` alone, never from connectivity. */
  readonly unreachable: boolean;
  /** Only from the person's directory; `null` is unknown and shows nothing. */
  readonly state: TaskHostState | null;
  /** The person can open it: it is in their host directory. */
  readonly openable: boolean;
}

export interface TaskHostGroup {
  readonly key: string;
  readonly title: string;
  readonly rows: readonly TaskHostGroupRow[];
}

/** The viewer's own group's key. */
export const TASK_HOST_PERSONAL_GROUP_KEY = "personal";
/** A team group's title when the person is not in the team. */
export const TASK_HOST_UNKNOWN_TEAM_TITLE = "A team";
/** A collaborator group's title when the collaborator has no display name. */
export const TASK_HOST_UNKNOWN_COLLABORATOR_TITLE = "A collaborator's";

const PERSONAL_KEY = TASK_HOST_PERSONAL_GROUP_KEY;

type GroupRank = 0 | 1 | 2;

const COLLABORATOR_RANK: GroupRank = 2;

interface GroupHead {
  readonly key: string;
  readonly title: string;
  readonly rank: GroupRank;
  readonly id: string;
}

export function taskHostAgentsLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 agent" : `${count} agents`;
}

/** The group a host's owner puts it in: Personal, a team, or a collaborator. */
function groupHead(row: TaskHostRow, input: TaskHostGroupsInput): GroupHead {
  const { principal } = row;
  if (principal.kind === "team") {
    const team = input.teams.find((t) => t.teamId === principal.id) ?? null;
    return {
      key: `team:${principal.id}`,
      title: team === null ? TASK_HOST_UNKNOWN_TEAM_TITLE : team.name,
      rank: 1,
      id: principal.id,
    };
  }
  if (principal.id === input.viewerUserId) {
    return { key: PERSONAL_KEY, title: "Personal", rank: 0, id: principal.id };
  }
  const name = input.collaboratorNames.get(principal.id) ?? null;
  return {
    key: `user:${principal.id}`,
    title: name === null ? TASK_HOST_UNKNOWN_COLLABORATOR_TITLE : `${name}'s`,
    rank: COLLABORATOR_RANK,
    id: principal.id,
  };
}

/**
 * The directory's name for a host, or `null`: a host the registry never named
 * reaches the directory labelled with its own id, which names nothing a person
 * would recognise, so it reads as unnamed.
 */
function directoryName(
  hostId: string,
  fact: TaskHostDirectoryFact | null,
): string | null {
  if (fact === null || fact.label === hostId) return null;
  return fact.label;
}

function groupRow(
  row: TaskHostRow,
  head: GroupHead,
  input: TaskHostGroupsInput,
): TaskHostGroupRow {
  // A collaborator's host carries the summary only, whatever the person's
  // directory says: no state, and nothing to open.
  const fact =
    head.rank === COLLABORATOR_RANK
      ? null
      : (input.directory.get(row.hostId) ?? null);
  return {
    hostId: row.hostId,
    label:
      row.label ?? directoryName(row.hostId, fact) ?? TASK_HOST_UNNAMED_LABEL,
    agentsLine: taskHostAgentsLine(
      input.agentCountByHostId.get(row.hostId) ?? 0,
    ),
    unreachable: row.reach === "other_principal",
    state: fact === null ? null : fact.state,
    openable: fact !== null,
  };
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * The task's hosts grouped by owner: Personal first, then each team, then each
 * collaborator, each by name; rows by label. A foreign row carries only the
 * task-authorized summary: state and opening come from the person's own
 * directory and nowhere else.
 */
export function taskHostGroups(
  input: TaskHostGroupsInput,
): readonly TaskHostGroup[] {
  const groups = new Map<
    string,
    { readonly head: GroupHead; readonly rows: TaskHostGroupRow[] }
  >();
  for (const host of input.hosts) {
    const head = groupHead(host, input);
    const group = groups.get(head.key) ?? { head, rows: [] };
    group.rows.push(groupRow(host, head, input));
    groups.set(head.key, group);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        a.head.rank - b.head.rank ||
        compareText(a.head.title, b.head.title) ||
        compareText(a.head.id, b.head.id),
    )
    .map(({ head, rows }) => ({
      key: head.key,
      title: head.title,
      rows: rows.sort(
        (a, b) =>
          compareText(a.label, b.label) || compareText(a.hostId, b.hostId),
      ),
    }));
}
