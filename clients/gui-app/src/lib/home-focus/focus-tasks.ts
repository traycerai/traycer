import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import {
  agentActivityTiers,
  type EpicAgentActivity,
} from "@/lib/agent-activity";
import {
  compareAscending,
  shallowEqualRow,
  stabilizeRows,
} from "@/lib/home-focus/focus-identity";
import type { FocusAgentRow, FocusTaskRow } from "@/lib/home-focus/focus-model";

/**
 * What this window's live projection knows about one working agent. `null`
 * everywhere for an agent in a task no tile in this window has open - the
 * activity stream carries ids and tiers for every task on the host, and names
 * for none of them.
 */
export interface FocusAgentIdentity {
  readonly title: string | null;
  readonly surface: "chat" | "terminal-agent";
  readonly parentId: string | null;
  /** The projection's recorded host. `null` for a legacy chat that predates
   * the field. */
  readonly hostId: string | null;
}

export interface FocusTasksInput {
  /** The activity store's per-user union: every task on the host, opened here
   * or not. */
  readonly byEpic: ReadonlyMap<string, EpicAgentActivity>;
  /** Epic id → best-available task title. Absent means "no title known", which
   * is not the same as an untitled task. */
  readonly taskTitles: ReadonlyMap<string, string>;
  /** Epics with a live projection in this window. */
  readonly mountedEpicIds: ReadonlySet<string>;
  /** `${epicId}\0${agentId}` → identity, for mounted epics only. */
  readonly agentIdentities: ReadonlyMap<string, FocusAgentIdentity>;
  /**
   * {@link focusAgentKey} → the host that reported the agent, from
   * LOCAL-PLANE slices only.
   *
   * The restriction is the whole point. A slice's key is the host its STREAM
   * was opened against, not where the agent runs - and a `cloud`-served slice
   * is that host's view of the whole FLEET, so host A's cloud slice carries
   * host B's agents verbatim. Reading the key as attribution there names the
   * wrong machine confidently. A `local`-served slice is one host answering
   * about itself, so its key IS the agent's host.
   *
   * Consulted only after the cloud index, and an agent in neither is left
   * unattributed rather than guessed.
   */
  readonly activityHostIds: ReadonlyMap<string, string>;
  /** The host's per-epic indicator flags, as returned by
   * `host.notifications.indicatorState`. Epics the batch did not cover are
   * simply absent. */
  readonly indicatorEpics: HostNotificationsIndicatorStateResponse["epics"];
  /** Epics with at least one unresolved prompt row. */
  readonly promptEpicIds: ReadonlySet<string>;
  /**
   * Epic id → the single host that owns this task's chats, for COLD epics.
   *
   * Populated only when the cloud index names EXACTLY ONE host: with two or
   * more there is no way to say which of them a given agent id belongs to, and
   * guessing would send a stop to the wrong machine. Absent is `null`, which is
   * how an unmounted agent's `hostId` honestly reads.
   */
  readonly coldEpicHostIds: ReadonlyMap<string, string>;
  /** The host this window addresses, which is where a `null`-host agent's stop
   * would be sent. */
  readonly activeHostId: string | null;
  /** Hosts this client can dial right now (`useConnectableHostIds`). */
  readonly reachableHostIds: ReadonlySet<string>;
}

const AGENT_TIER_ORDER: Readonly<Record<"turn" | "background", number>> = {
  turn: 0,
  background: 1,
};

/**
 * The "Running" section: one row per task with at least one working agent.
 *
 * A task with no working agent is not here at all - Home is about what is
 * happening now, and "Finished recently" was kept out of the first version. That also
 * means the list is driven entirely by the activity union, so a task whose
 * prompt is waiting but whose agents have all stopped appears in "Needs you"
 * and nowhere else, which is the correct reading of both sections.
 *
 * ORDERING - tasks needing the user first, then the task with the most agents
 * mid-turn, then the most agents overall, then epic id ascending. The last term
 * is not cosmetic: without a total order the list re-shuffles between two
 * equally-ranked tasks on every unrelated frame.
 *
 * `mountedHere` is the honest caption for a row's own gaps rather than a filter:
 * an unmounted task's agents are rendered by id, and its background work is not
 * rendered at all.
 */
export function buildFocusTasks(
  input: FocusTasksInput,
  previous: ReadonlyArray<FocusTaskRow>,
): ReadonlyArray<FocusTaskRow> {
  const previousAgentsByEpicId = new Map(
    previous.map((task) => [task.epicId, task.agents]),
  );
  const rows = Array.from(input.byEpic.entries()).flatMap(
    ([epicId, activity]): FocusTaskRow[] => {
      if (activity.working.size === 0) return [];
      const agents = buildFocusAgents(
        epicId,
        activity,
        input,
        previousAgentsByEpicId.get(epicId) ?? [],
      );
      return [
        {
          epicId,
          taskTitle: input.taskTitles.get(epicId) ?? null,
          mountedHere: input.mountedEpicIds.has(epicId),
          agents,
          needsYou: taskNeedsYou(epicId, input),
          // The fold of the agents' own answers rather than a second
          // computation over the same inputs: a per-host row shows a SUBSET of
          // these agents and has to answer for that subset alone, so the
          // per-agent flag is the primitive and this is derived from it.
          stoppable: agents.every((agent) => agent.stoppable),
        },
      ];
    },
  );
  rows.sort(compareFocusTasks);
  return stabilizeRows(rows, previous, shallowEqualRow);
}

/**
 * A task needs the user when the host's own indicator flags say a prompt is
 * pending on it, OR when a prompt row in this client's feed points at it.
 *
 * Both, because neither alone covers the page. The indicator RPC answers about
 * ONE host's SQLite and only for the epics the batch covered; the feed answers
 * for whatever the client has actually loaded. A task outside the indicator
 * batch with a loaded prompt row still reads correctly, and so does a task
 * whose prompt row has not been paged in.
 */
function taskNeedsYou(epicId: string, input: FocusTasksInput): boolean {
  if (input.promptEpicIds.has(epicId)) return true;
  if (!Object.hasOwn(input.indicatorEpics, epicId)) return false;
  const flags = input.indicatorEpics[epicId];
  return flags.pendingApproval || flags.pendingInterview;
}

/**
 * Running agents for one task, turn tier first.
 *
 * Within a tier the order is title-then-id, both byte-ascending, so a task's
 * agent list is stable frame to frame and identical between two windows. An
 * agent with no known name sorts after every named one rather than under an
 * empty string, because "the epic is not mounted here" is a property of this
 * window, not of the agent.
 */
function buildFocusAgents(
  epicId: string,
  activity: EpicAgentActivity,
  input: FocusTasksInput,
  previous: ReadonlyArray<FocusAgentRow>,
): ReadonlyArray<FocusAgentRow> {
  const tiers = agentActivityTiers(activity);
  const coldHostId = input.coldEpicHostIds.get(epicId) ?? null;
  const rows = Array.from(tiers.entries()).map(
    ([agentId, tier]): FocusAgentRow => {
      const key = focusAgentKey(epicId, agentId);
      const identity = input.agentIdentities.get(key);
      // A resolved identity is the authority even when its own host is `null`
      // (a legacy chat that predates the field): the projection has SEEN this
      // agent, so falling through would overwrite a known absence with an
      // inference.
      //
      // Unresolved, the CLOUD INDEX answers next - it records where an epic's
      // chats actually live. Only then the reporting slice, and only when that
      // slice was served LOCALLY: a cloud-served slice is one host's view of
      // the whole fleet, so its key is the machine the stream was opened
      // against rather than the machine the agent runs on.
      //
      // Nothing left means nothing KNOWN. The row says so rather than falling
      // back to the active host, which is how a task worked from two remote
      // machines ended up filed under the user's laptop.
      const attributed =
        identity !== undefined
          ? identity.hostId
          : (coldHostId ?? input.activityHostIds.get(key) ?? null);
      return {
        agentId,
        title: identity?.title ?? null,
        surface: identity?.surface ?? null,
        tier,
        parentId: identity?.parentId ?? null,
        hostId: attributed,
        hostUnattributed: identity === undefined && attributed === null,
        stoppable: agentIsStoppable(attributed, identity !== undefined, input),
      };
    },
  );
  rows.sort(compareFocusAgents);
  return stabilizeRows(rows, previous, shallowEqualRow);
}

/**
 * Whether a stop aimed at this agent would reach the machine it is running on.
 *
 * A NAMED host has to be one this client can currently dial - a task on a
 * machine that is asleep or unreachable is honestly not stoppable from here,
 * and the row says so instead of failing after the click.
 *
 * A `null` host splits in two, and the split is the whole point. `null` means
 * the stop goes to the ACTIVE host, so it is only honest when the active host
 * is in fact where the agent lives:
 *
 * - The projection RESOLVED this agent and recorded no host - a legacy chat
 *   predating the field. This window is already talking to that epic's host, so
 *   the active host is right and the row stays actionable rather than being
 *   greyed out on a technicality.
 * - Nothing resolved it: the epic is cold and {@link FocusTasksInput.coldEpicHostIds}
 *   declined to name a host, because the cloud index listed two of them (or
 *   none). That refusal is deliberate - nothing in `chatHostIds` says WHICH
 *   host a given agent id belongs to - and it must not be undone here by
 *   quietly aiming at the active host instead. A Stop that promises to reach a
 *   machine the model could not name is worse than a disabled one: `agent.stop`
 *   resolves the subtree from shared cloud storage, so the wrong host finds the
 *   agent and then tears down through ITS OWN session managers, reporting an
 *   empty `stoppedAgentIds` while the real agent keeps running.
 */
function agentIsStoppable(
  hostId: string | null,
  resolvedByProjection: boolean,
  input: FocusTasksInput,
): boolean {
  if (hostId !== null) {
    return hostId === input.activeHostId || input.reachableHostIds.has(hostId);
  }
  return resolvedByProjection;
}

/** The `agentIdentities` key. An epic id and an agent id are both opaque
 * strings, so they are joined on a NUL - the same separator `workspaceKey`
 * uses, and the one byte neither id can carry. Written as an escape so the
 * source stays plain ASCII. */
export function focusAgentKey(epicId: string, agentId: string): string {
  return `${epicId}\u0000${agentId}`;
}

function compareFocusTasks(a: FocusTaskRow, b: FocusTaskRow): number {
  if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
  const turnDelta = countTurnAgents(b) - countTurnAgents(a);
  if (turnDelta !== 0) return turnDelta;
  const agentDelta = b.agents.length - a.agents.length;
  if (agentDelta !== 0) return agentDelta;
  return compareAscending(a.epicId, b.epicId);
}

function countTurnAgents(task: FocusTaskRow): number {
  return task.agents.filter((agent) => agent.tier === "turn").length;
}

function compareFocusAgents(a: FocusAgentRow, b: FocusAgentRow): number {
  const tierDelta = AGENT_TIER_ORDER[a.tier] - AGENT_TIER_ORDER[b.tier];
  if (tierDelta !== 0) return tierDelta;
  const aUnnamed = a.title === null;
  const bUnnamed = b.title === null;
  if (aUnnamed !== bUnnamed) return aUnnamed ? 1 : -1;
  const titleDelta = compareAscending(a.title ?? "", b.title ?? "");
  if (titleDelta !== 0) return titleDelta;
  return compareAscending(a.agentId, b.agentId);
}
