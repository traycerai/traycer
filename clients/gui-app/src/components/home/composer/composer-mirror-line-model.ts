import type {
  TaskHostPrincipal,
  TaskHostRow,
} from "@traycer/protocol/host/task-host-summary";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";
import {
  TASK_HOST_PERSONAL_GROUP_KEY,
  TASK_HOST_UNKNOWN_COLLABORATOR_TITLE,
  TASK_HOST_UNKNOWN_TEAM_TITLE,
  TASK_HOST_UNNAMED_LABEL,
  type TaskHostGroup,
} from "@/components/epic-canvas/sidebar/task-host-groups-model";

/** The mirror line's text. */
export function composerMirrorLineText(otherHostLabel: string): string {
  return `Agents here cannot work with the agents on ${otherHostLabel}; the task still shares its files and chats.`;
}

function samePrincipal(a: TaskHostPrincipal, b: TaskHostPrincipal): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * A host's name in the line: the host's label, or, when it can only say
 * "Unnamed host", its owner group ("Alice's host"), so a person's laptop the
 * wire sends without a label is still told apart.
 */
function mirrorHostName(group: TaskHostGroup, label: string): string {
  if (label !== TASK_HOST_UNNAMED_LABEL) return label;
  if (group.key === TASK_HOST_PERSONAL_GROUP_KEY) return "one of your hosts";
  // Only the two generic titles read mid-sentence in lower case; a name is
  // kept as written, including one that starts with "A ".
  if (group.title === TASK_HOST_UNKNOWN_TEAM_TITLE) return "a team host";
  if (group.title === TASK_HOST_UNKNOWN_COLLABORATOR_TITLE) {
    return "a collaborator's host";
  }
  return `${group.title} host`;
}

/**
 * The host the mirror line names: the first host already in the task, in the
 * task-host groups' order, whose owner differs from the start host's; `null`
 * when every one shares it. The start host's owner is its own task row's when
 * it already serves the task, else the caller's fallback (its registry owner,
 * or the viewer).
 */
export function mirrorLineOtherHostName(input: {
  readonly groups: readonly TaskHostGroup[];
  readonly hosts: readonly TaskHostRow[];
  readonly startHostId: string;
  readonly startPrincipalFallback: TaskHostPrincipal;
}): string | null {
  const principals = new Map(
    input.hosts.map((row) => [row.hostId, row.principal] as const),
  );
  const startPrincipal =
    principals.get(input.startHostId) ?? input.startPrincipalFallback;
  for (const group of input.groups) {
    for (const row of group.rows) {
      if (row.hostId === input.startHostId) continue;
      const principal = principals.get(row.hostId);
      if (principal === undefined) continue;
      if (samePrincipal(principal, startPrincipal)) continue;
      return mirrorHostName(group, row.label);
    }
  }
  return null;
}

export interface ComposerMirrorLine {
  /** The line, or `null` when no host here has another owner, or it was seen. */
  readonly notice: ComposerHostNoticeState | null;
  /** Record the line as seen in this task: on dismiss, and on start. */
  readonly markSeen: () => void;
}

/**
 * The composer's one notice slot: a refusal outranks the mirror line, and
 * dismissing the mirror line marks it seen.
 */
export function composerTopNotice(
  refused: ComposerHostNoticeState | null,
  dismissRefused: () => void,
  mirror: ComposerMirrorLine,
): {
  readonly notice: ComposerHostNoticeState | null;
  readonly dismiss: () => void;
} {
  if (refused !== null) return { notice: refused, dismiss: dismissRefused };
  return { notice: mirror.notice, dismiss: mirror.markSeen };
}
