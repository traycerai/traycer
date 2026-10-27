import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type {
  HostStatusAgentSession,
  HostStatusSessions,
} from "@traycer/protocol/host/status/contracts";
import {
  sandboxSupportReference,
  type SandboxCost,
  type SandboxMember,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";
import { frozenDestroyAt } from "@/lib/sandboxes/sandbox-balance";
import { formatMemory } from "@/lib/sandboxes/sandbox-pricing";
import {
  AGENT_SANDBOX,
  KEPT_UNTIL_YOU_DESTROY_IT,
  LESS_THAN_A_CENT_SO_FAR,
  configurationLabel,
  costLine,
  formatSandboxCost,
  formatSandboxDollars,
  keptByLine,
  paidByLine,
  startedByLine,
  type SandboxConfigurationCopy,
} from "@/lib/sandboxes/sandbox-strings";

/**
 * Settings › Sandboxes, as data: which rows one configuration lists, what each
 * row says, which actions it offers, and how the filter narrows the list. Free
 * of React so the page, the dialogs and the hover card read one table.
 */

/** The idle period the control plane applies when a row sets none. */
export const SANDBOX_DEFAULT_IDLE_MINUTES = 30;
/** The resting period a configuration's defaults start at: 7 days. */
export const SANDBOX_DEFAULT_RESTING_MINUTES = 7 * 24 * 60;
/** The disclosed idle floor: a shorter period is refused, never clamped. */
export const SANDBOX_MIN_IDLE_MINUTES = 2;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** One cent in millicredits (a credit is a dollar, 1000 millicredits). */
const MC_PER_CENT = 10;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * The configuration a Sandboxes page lists: Personal, or one team with the
 * environment its rows carry (`null` until the team's environment id is read,
 * which lists nothing rather than guessing).
 */
export type SandboxPageConfiguration =
  | { readonly kind: "personal" }
  | {
      readonly kind: "team";
      readonly teamId: string;
      readonly teamName: string;
      readonly environmentId: string | null;
    };

export function configurationCopy(
  configuration: SandboxPageConfiguration,
): SandboxConfigurationCopy {
  return configuration.kind === "personal"
    ? { kind: "personal" }
    : { kind: "team", teamName: configuration.teamName };
}

/**
 * Whether a row belongs to the configuration. A team's rows carry its
 * environment id; Personal's are every other row, which needs every team's
 * environment id to tell apart (`teamEnvironmentIds` complete), so a team pod
 * (no creator) is never listed as the person's own while a team is unread.
 */
export function rowInConfiguration(
  summary: SandboxSummary,
  configuration: SandboxPageConfiguration,
  teamEnvironmentIds: ReadonlySet<string>,
): boolean {
  if (configuration.kind === "team") {
    return (
      configuration.environmentId !== null &&
      summary.environmentId === configuration.environmentId
    );
  }
  if (summary.createdBy !== null) return false;
  return (
    summary.environmentId === null ||
    !teamEnvironmentIds.has(summary.environmentId)
  );
}

// ── Kind, public state, filter ──────────────────────────────────────────────

export type SandboxRowKind = "sandbox" | "agent" | "automation";

export function sandboxRowKind(summary: SandboxSummary): SandboxRowKind {
  if (summary.kind === "automation") return "automation";
  return summary.burst ? "agent" : "sandbox";
}

/** The seven public states, without Destroyed: a destroyed row is not listed. */
export type SandboxPublicState =
  | "creating"
  | "awake"
  | "suspended"
  | "stopped"
  | "frozen"
  | "failed";

/**
 * The public state a row reads as. A move in flight reads as where it is
 * going, since the page offers nothing until it lands; the Automations row's
 * `released` is its rest.
 */
export function sandboxPublicState(
  summary: SandboxSummary,
): SandboxPublicState {
  if (summary.frozen) return "frozen";
  return PUBLIC_STATE[summary.state];
}

const PUBLIC_STATE: Record<HostSandboxState, SandboxPublicState> = {
  creating: "creating",
  awake: "awake",
  resuming: "awake",
  starting: "awake",
  suspending: "suspended",
  suspended: "suspended",
  released: "suspended",
  stopping: "stopped",
  stopped: "stopped",
  destroying: "stopped",
  destroyed: "stopped",
  failed: "failed",
};

export const SANDBOX_PUBLIC_STATE_LABEL: Record<SandboxPublicState, string> = {
  creating: "Creating",
  awake: "Awake",
  suspended: "Suspended",
  stopped: "Stopped",
  frozen: "Frozen",
  failed: "Failed",
};

/** Whether the row is between two states, which offers no action but Details. */
export function sandboxRowMoving(summary: SandboxSummary): boolean {
  switch (summary.state) {
    case "creating":
    case "resuming":
    case "starting":
    case "suspending":
    case "stopping":
    case "destroying":
      return true;
    default:
      return false;
  }
}

export type SandboxKindFilter = "all" | SandboxRowKind;
export type SandboxStateFilter =
  | "all"
  | "awake"
  | "suspended"
  | "stopped"
  | "frozen"
  | "failed";
export type SandboxStarterFilter = "anyone" | "you" | "agent" | "others";

export interface SandboxRowFilter {
  readonly kind: SandboxKindFilter;
  readonly state: SandboxStateFilter;
  readonly startedBy: SandboxStarterFilter;
  readonly search: string;
}

export const SANDBOX_ROW_FILTER_NONE: SandboxRowFilter = {
  kind: "all",
  state: "all",
  startedBy: "anyone",
  search: "",
};

export const SANDBOX_KIND_FILTER_LABEL: Record<SandboxKindFilter, string> = {
  all: "All",
  sandbox: "Sandboxes",
  agent: "Agent sandboxes",
  automation: "Automations",
};

export const SANDBOX_STATE_FILTER_LABEL: Record<SandboxStateFilter, string> = {
  all: "All",
  awake: "Awake",
  suspended: "Suspended",
  stopped: "Stopped",
  frozen: "Frozen",
  failed: "Failed",
};

export const SANDBOX_STARTER_FILTER_LABEL: Record<
  SandboxStarterFilter,
  string
> = {
  anyone: "Anyone",
  you: "You",
  agent: "An agent",
  others: "Other members",
};

/** How many of the three radio groups are off their default: the badge. */
export function sandboxFilterCount(filter: SandboxRowFilter): number {
  return (
    (filter.kind === "all" ? 0 : 1) +
    (filter.state === "all" ? 0 : 1) +
    (filter.startedBy === "anyone" ? 0 : 1)
  );
}

/** Who started the row, as the Started by filter reads it. */
function rowStarter(
  summary: SandboxSummary,
  viewerUserId: string | null,
): "you" | "agent" | "others" | null {
  if (summary.kind === "automation") return null;
  // A kept row is no longer burst, but an agent still started it.
  if (summary.burst || summary.createdByAgentId !== null) return "agent";
  if (summary.createdBy === null) return "you";
  return viewerUserId !== null && summary.createdBy.userId === viewerUserId
    ? "you"
    : "others";
}

export function sandboxRowMatches(
  summary: SandboxSummary,
  filter: SandboxRowFilter,
  viewerUserId: string | null,
): boolean {
  if (filter.kind !== "all" && sandboxRowKind(summary) !== filter.kind) {
    return false;
  }
  if (filter.state !== "all" && sandboxPublicState(summary) !== filter.state) {
    return false;
  }
  if (
    filter.startedBy !== "anyone" &&
    rowStarter(summary, viewerUserId) !== filter.startedBy
  ) {
    return false;
  }
  const term = filter.search.trim().toLowerCase();
  if (term.length === 0) return true;
  // The task is matched by id: the summary carries no task title.
  return (
    summary.displayName.toLowerCase().includes(term) ||
    (summary.createdByTaskId?.toLowerCase().includes(term) ?? false)
  );
}

/** Awake first, then by last activity, newest first, with id breaking ties. */
export function sortSandboxRows(
  rows: readonly SandboxSummary[],
): readonly SandboxSummary[] {
  const activity = (row: SandboxSummary): number =>
    row.lastActivityAt ?? row.lastTransitionAt;
  return [...rows].sort((a, b) => {
    const awakeA = sandboxPublicState(a) === "awake" ? 0 : 1;
    const awakeB = sandboxPublicState(b) === "awake" ? 0 : 1;
    if (awakeA !== awakeB) return awakeA - awakeB;
    return activity(b) - activity(a) || a.id.localeCompare(b.id);
  });
}

/** `Destroy all idle` shows only while the filter is exactly this pair. */
export function sandboxDestroyAllIdleOffered(
  filter: SandboxRowFilter,
): boolean {
  return filter.kind === "agent" && filter.state === "suspended";
}

// ── Who ─────────────────────────────────────────────────────────────────────

/** `you`, the member's name, or `a member` when they have none to show. */
export function sandboxMemberName(
  member: SandboxMember,
  viewerUserId: string | null,
): string {
  if (viewerUserId !== null && member.userId === viewerUserId) return "you";
  return member.displayName ?? "a member";
}

/**
 * `Started by you` / `Started by Priya` / `Agent sandbox` / `Automations`.
 * A row an agent created and someone kept reads `Started by <agent>`, or
 * `Started by an agent` where the server does not name it to this viewer:
 * Keep changes who keeps it, never who started it.
 */
export function sandboxStartedByLabel(
  summary: SandboxSummary,
  viewerUserId: string | null,
): string {
  if (summary.kind === "automation") return "Automations";
  if (summary.burst) return AGENT_SANDBOX;
  if (summary.createdByAgentId !== null) {
    return startedByLine(summary.createdByAgentName ?? "an agent");
  }
  if (summary.createdBy === null) return startedByLine("you");
  return startedByLine(sandboxMemberName(summary.createdBy, viewerUserId));
}

/** `Paid by Priya`, on an awake team row only. */
export function sandboxPaidByLabel(
  summary: SandboxSummary,
  configuration: SandboxPageConfiguration,
  viewerUserId: string | null,
): string | null {
  if (configuration.kind !== "team") return null;
  if (sandboxPublicState(summary) !== "awake" || summary.wakePayer === null) {
    return null;
  }
  return paidByLine(sandboxMemberName(summary.wakePayer, viewerUserId));
}

export function sandboxKeptByLabel(
  summary: SandboxSummary,
  viewerUserId: string | null,
): string | null {
  return summary.keptBy === null
    ? null
    : keptByLine(sandboxMemberName(summary.keptBy, viewerUserId));
}

// ── The shape and cost line ─────────────────────────────────────────────────

/** `Linux · 2 vCPU · 4 GB`. */
export function sandboxShapeLine(summary: SandboxSummary): string {
  const os = summary.os === "windows" ? "Windows" : "Linux";
  return `${os} · ${summary.cpus} vCPU · ${formatMemory(summary.memoryMb)}`;
}

/**
 * The row's second line: the shape, then the cost line, or for the
 * Automations row what it runs and who pays for it. An agent sandbox names
 * the agent that created it and its task in place of whose credits, where
 * the server names them to this viewer.
 */
export function sandboxShapeAndCostLine(
  summary: SandboxSummary,
  configuration: SandboxPageConfiguration,
): string {
  if (summary.kind === "automation") return automationsShapeLine(configuration);
  const shape = sandboxShapeLine(summary);
  if (summary.priceMcPerHour === null) return shape;
  const creator = agentCreatorClause(summary);
  if (creator !== null) {
    return `${shape} · ${formatSandboxDollars(summary.priceMcPerHour.awakeMc)} an hour while awake · ${creator}`;
  }
  return `${shape} · ${costLine(summary.priceMcPerHour.awakeMc, configurationCopy(configuration))}`;
}

/** `created by Planner for Sandbox setup`, on an agent sandbox. */
function agentCreatorClause(summary: SandboxSummary): string | null {
  const agent = summary.createdByAgentName;
  if (!summary.burst || agent === null) return null;
  const task = summary.createdByTaskTitle;
  return task === null
    ? `created by ${agent}`
    : `created by ${agent} for ${task}`;
}

/** What the configuration's Automations host is for, and what it costs. */
export function automationsShapeLine(
  configuration: SandboxPageConfiguration,
): string {
  return configuration.kind === "team"
    ? `Runs ${configuration.teamName}'s long-running shells · agents can't run here · uses ${configuration.teamName}'s shared credits, not a member's allowance`
    : "Runs your long-running shells · agents can't run here · no charge";
}

/**
 * The Automations host at rest, or not created yet: the next shell starts it.
 * Its badge reads Suspended, and so does the line.
 */
export const AUTOMATIONS_RELEASED_LINE =
  "Suspended · files kept · the next shell starts it";

/**
 * Whether the filter keeps the Automations row of a host not created yet:
 * it reads as released, by no one, named `Automations`.
 */
export function unstartedAutomationsMatches(filter: SandboxRowFilter): boolean {
  if (filter.kind !== "all" && filter.kind !== "automation") return false;
  if (filter.state !== "all" && filter.state !== "suspended") return false;
  if (filter.startedBy !== "anyone") return false;
  const term = filter.search.trim().toLowerCase();
  return term.length === 0 || "automations".includes(term);
}

// ── The clock line ──────────────────────────────────────────────────────────

/** Whether the host answers while the control plane says awake. */
export interface SandboxReachability {
  readonly unreachable: boolean;
  /** When the host was last heard from, for the unreachable line. */
  readonly lastContactAt: number | null;
}

export interface SandboxClockInput {
  readonly summary: SandboxSummary;
  readonly configuration: SandboxPageConfiguration;
  readonly cost: SandboxCost | null;
  /** The class's wake string, or `null` when the catalogue does not say. */
  readonly wakeString: string | null;
  readonly viewerUserId: string | null;
  readonly reachability: SandboxReachability;
  readonly now: number;
}

/** Start of the UTC day `now` falls in: the billing day the header names. */
export function utcDayStart(now: number): number {
  return now - (now % MS_PER_DAY);
}

/** `1 h 20 min`, `24 min`, `0 min`. */
export function formatSandboxDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MS_PER_MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** `Oct 31`, `Oct 31 at 23:40` with a time. */
export function formatSandboxDate(at: number, withTime: boolean): string {
  const date = new Date(at);
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  if (!withTime) return day;
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day} at ${time}`;
}

/** `23:40`. */
export function formatSandboxTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * What a chat on a destroyed sandbox says: `e2e-sbx-win2 was destroyed by you
 * at 11:01.`, or the member's name for another member's destroy.
 */
export function sandboxDestroyedLine(
  ended: {
    readonly name: string;
    readonly at: number;
    readonly actor: SandboxMember;
  },
  viewerUserId: string | null,
): string {
  return `${ended.name} was destroyed by ${sandboxMemberName(ended.actor, viewerUserId)} at ${formatSandboxTime(ended.at)}.`;
}

/** `23:40` today, `Mon` this week, `Oct 20` before. */
export function formatSandboxSince(at: number, now: number): string {
  if (
    now - at < MS_PER_DAY &&
    new Date(at).getDate() === new Date(now).getDate()
  ) {
    return formatSandboxTime(at);
  }
  if (now - at < 6 * MS_PER_DAY) {
    return new Date(at).toLocaleDateString(undefined, { weekday: "short" });
  }
  return formatSandboxDate(at, false);
}

/**
 * A report time, or `null` when it is unset: `null`, or `0`, which a read
 * that never answered carries and which would print as an age since 1970.
 */
export function sandboxReportedAt(at: number | null): number | null {
  return at === null || at <= 0 ? null : at;
}

/** `6 min ago`, `2 h ago`, `3 days ago`. */
export function formatSandboxAge(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < MS_PER_HOUR) return `${Math.floor(ms / MS_PER_MINUTE)} min ago`;
  if (ms < MS_PER_DAY) return `${Math.floor(ms / MS_PER_HOUR)} h ago`;
  const days = Math.floor(ms / MS_PER_DAY);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * Today's cost: `$0.16 today`, or while nothing has posted yet the accrual
 * of this wake, `$0.09 so far`, never a rounded zero: under a cent it reads
 * `Less than $0.01 so far`.
 */
export function sandboxTodayCost(
  summary: SandboxSummary,
  cost: SandboxCost | null,
  awakeTodayMs: number,
): string | null {
  if (cost !== null && cost.todayMillicredits >= MC_PER_CENT) {
    return `${formatSandboxDollars(cost.todayMillicredits)} today`;
  }
  // Below a cent posted is still accruing: `under $0.01 so far`.
  if (cost !== null && cost.todayMillicredits > 0) {
    return LESS_THAN_A_CENT_SO_FAR;
  }
  if (
    sandboxPublicState(summary) !== "awake" ||
    summary.priceMcPerHour === null
  ) {
    return null;
  }
  const accrued = (summary.priceMcPerHour.awakeMc * awakeTodayMs) / MS_PER_HOUR;
  if (accrued < MC_PER_CENT) return LESS_THAN_A_CENT_SO_FAR;
  return `${formatSandboxDollars(accrued)} so far`;
}

function idleMinutesOf(summary: SandboxSummary): number {
  return summary.idleMinutes ?? SANDBOX_DEFAULT_IDLE_MINUTES;
}

/**
 * The three frozen causes, each its own sentence (Flow 5). The payer whose
 * credits ran out is the row's last payer; the third cause (the payer left
 * the team) is not on the summary, so it reads as the second.
 */
export function sandboxFrozenCause(
  summary: SandboxSummary,
  configuration: SandboxPageConfiguration,
  viewerUserId: string | null,
): string {
  if (configuration.kind === "personal") {
    return "Frozen: your credits ran out.";
  }
  const team = configuration.teamName;
  const payer = summary.wakePayer;
  if (
    payer === null ||
    (viewerUserId !== null && payer.userId === viewerUserId)
  ) {
    return `Frozen: your ${team} credits ran out.`;
  }
  return `Frozen: ${payer.displayName ?? "a member"}'s ${team} credits ran out.`;
}

/** Whether a frozen row's remedy is the viewer's own top-up. */
export function sandboxFrozenNeedsOwnCredits(
  summary: SandboxSummary,
  configuration: SandboxPageConfiguration,
  viewerUserId: string | null,
): boolean {
  if (configuration.kind === "personal") return true;
  const payer = summary.wakePayer;
  return (
    payer === null || (viewerUserId !== null && payer.userId === viewerUserId)
  );
}

/** The frozen clock's sentence; the frozen date governs even a `never` period. */
export function sandboxFrozenClock(frozenAt: number | null): string | null {
  if (frozenAt === null) return null;
  return `Frozen sandboxes aren't destroyed on their idle schedule; this one is destroyed on ${formatSandboxDate(frozenDestroyAt(frozenAt), true)}.`;
}

/**
 * `destroyed Nov 1 at 09:49 unless used`, or `kept until you destroy it` on
 * a row that rests forever. `null` while a period is set but its date has not
 * arrived yet: a default drawn before the value would flash the wrong claim.
 */
function restingDestroyClause(
  summary: SandboxSummary,
  verb: string,
): string | null {
  if (summary.destroyAt !== null) {
    return `destroyed ${formatSandboxDate(summary.destroyAt, true)} unless ${verb}`;
  }
  const period = summary.destroyAfterRestingMinutes;
  // `0` is never, as the server spells it.
  return period === null || period === 0 ? KEPT_UNTIL_YOU_DESTROY_IT : null;
}

/** The suspended row's promise: what a suspended sandbox does next. */
const RESUMES_ON_YOUR_NEXT_ACTION = "resumes on your next action";

/**
 * The current wake's age within the UTC day, for a local cost estimate
 * before the ledger answers. The day's total duration comes from the cost view.
 */
export function sandboxAwakeTodayMs(
  summary: SandboxSummary,
  now: number,
): number {
  if (sandboxPublicState(summary) !== "awake") return 0;
  return Math.max(
    0,
    now - Math.max(summary.lastTransitionAt, utcDayStart(now)),
  );
}

function joinParts(...items: ReadonlyArray<string | null>): string {
  return items.filter((item): item is string => item !== null).join(" · ");
}

/**
 * The row's clock line, per state (Flow 6 › The page). A destroy in flight
 * reads `Destroying…` alone: the row's clock and its keep promise no longer
 * hold.
 */
export function sandboxClockLine(input: SandboxClockInput): string {
  const { summary } = input;
  if (summary.state === "destroying") return "Destroying…";
  const state = sandboxPublicState(summary);
  switch (state) {
    case "frozen":
      return [
        sandboxFrozenCause(summary, input.configuration, input.viewerUserId),
        sandboxFrozenClock(summary.frozenAt),
      ]
        .filter((item): item is string => item !== null)
        .join(" ");
    case "failed":
      return `${sandboxFailedToStart(summary.failureCode)} at ${formatSandboxTime(summary.lastTransitionAt)} · Nothing is billed for a sandbox that never woke · support reference in Details`;
    case "creating":
      return "Starting";
    case "awake":
      return summary.kind === "automation"
        ? `stops after ${idleMinutesOf(summary)} idle min · files kept · the next shell starts it`
        : awakeClockLine(input);
    case "suspended":
    case "stopped":
      return summary.kind === "automation"
        ? AUTOMATIONS_RELEASED_LINE
        : restingClockLine(input, state);
  }
}

function awakeClockLine(input: SandboxClockInput): string {
  const { summary, now } = input;
  if (input.reachability.unreachable) {
    const contact = sandboxReportedAt(input.reachability.lastContactAt);
    return contact === null
      ? "Running, but Traycer can't connect"
      : `Running, but Traycer can't connect · last contact ${formatSandboxAge(contact, now)}`;
  }
  if (summary.guestConfigured === false) {
    return joinParts(
      `Awake · ${configurationLabel(configurationCopy(input.configuration))}'s settings didn't apply`,
      sandboxSupportReference(summary.failureCode),
    );
  }
  const awakeMs = input.cost?.todayAwakeMs ?? null;
  const today = sandboxTodayCost(
    summary,
    input.cost,
    sandboxAwakeTodayMs(summary, now),
  );
  const awake =
    awakeMs === null
      ? "Awake"
      : `Awake ${formatSandboxDuration(awakeMs)} today`;
  if (summary.burst) {
    return joinParts(
      awake,
      today,
      `destroys itself after ${idleMinutesOf(summary)} idle min · files on it are lost then`,
    );
  }
  return joinParts(
    awake,
    today,
    `suspends after ${idleMinutesOf(summary)} idle min`,
    input.wakeString,
  );
}

function restingClockLine(
  input: SandboxClockInput,
  state: "suspended" | "stopped",
): string {
  const { summary, configuration, cost, now } = input;
  const since = summary.restingSince ?? summary.lastTransitionAt;
  const resting =
    state === "suspended"
      ? joinParts(
          `Suspended since ${formatSandboxSince(since, now)}`,
          input.wakeString,
          RESUMES_ON_YOUR_NEXT_ACTION,
          restingDestroyClause(summary, "used"),
        )
      : joinParts(
          `${stoppedLead(summary, input.viewerUserId)} since ${formatSandboxSince(since, now)}`,
          restingDestroyClause(summary, "started"),
        );
  if (configuration.kind !== "team") {
    return joinParts(
      resting,
      cost !== null && cost.todayMillicredits > 0
        ? `${formatSandboxCost(cost.todayMillicredits)} today`
        : null,
    );
  }
  // The storage payer is the last wake's; a server that drops it at rest
  // leaves the sentence out rather than naming the wrong member.
  const payer = summary.wakePayer;
  if (payer === null) return resting;
  return `${resting} · Storage uses ${possessive(sandboxMemberName(payer, input.viewerUserId))} ${configuration.teamName} credits. Resuming changes the payer to you.`;
}

/**
 * Who or what stopped the row: `Stopped by you`, `Stopped after a failed
 * wake` for a wake rolled back to stopped, else `Stopped`.
 */
function stoppedLead(
  summary: SandboxSummary,
  viewerUserId: string | null,
): string {
  const operation = summary.operation;
  if (operation === null || operation.state !== "stopped") return "Stopped";
  if (operation.outcomeCause === "failure")
    return "Stopped after a failed wake";
  if (operation.actor === null) return "Stopped";
  return `Stopped by ${sandboxMemberName(operation.actor, viewerUserId)}`;
}

/**
 * `Failed to start (SBX-0412)`, by the failure's support reference; with no
 * reference, `Failed to start` alone. Never the raw code.
 */
export function sandboxFailedToStart(failureCode: string | null): string {
  const reference = sandboxSupportReference(failureCode);
  return reference === null
    ? "Failed to start"
    : `Failed to start (${reference})`;
}

/**
 * What "Copy support reference" copies: `SBX-0412 · <sandbox id>`, the id
 * letting support find the row; the id alone with no reference.
 */
export function sandboxSupportReferenceLine(
  failureCode: string | null,
  sandboxId: string | null,
): string {
  return [sandboxSupportReference(failureCode), sandboxId]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function possessive(name: string): string {
  return name === "you" ? "your" : `${name}'s`;
}

// ── Sessions ────────────────────────────────────────────────────────────────

/** How a host's list splits: agents (chat and terminal agents) and terminals. */
export interface SandboxSessionKinds {
  readonly agents: number;
  readonly terminals: number;
}

/**
 * What the host last reported about its running sessions: its list of
 * running agents and open terminals while live, the count of an old one, or
 * nothing. Never a zero without a report.
 */
export type SandboxSessionReport =
  | {
      readonly kind: "live";
      readonly count: number;
      readonly busy: boolean;
      readonly kinds: SandboxSessionKinds;
      readonly sessions: HostStatusSessions;
    }
  | { readonly kind: "stale"; readonly count: number; readonly at: number }
  | { readonly kind: "unknown" };

/**
 * `host.status`'s list split into agents and terminals; `null` from a host
 * that did not report one.
 */
export function sandboxSessionKinds(
  sessions: HostStatusSessions | null,
): SandboxSessionKinds | null {
  return sessions === null
    ? null
    : { agents: sessions.agents.length, terminals: sessions.terminals.length };
}

function countNoun(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

function sessionKindNames(kinds: SandboxSessionKinds): string[] {
  const names: string[] = [];
  if (kinds.agents > 0) names.push(countNoun(kinds.agents, "agent"));
  if (kinds.terminals > 0) names.push(countNoun(kinds.terminals, "terminal"));
  return names;
}

/** The live list's split in words: `1 agent`, `2 terminals`. */
export function sandboxSessionKindNames(
  report: SandboxSessionReport,
): readonly string[] {
  return report.kind === "live" ? sessionKindNames(report.kinds) : [];
}

/**
 * An agent's name in the list: its own, `Terminal agent` for a terminal agent
 * not renamed, `null` for a chat whose name the host does not send.
 */
export function sandboxAgentSessionName(
  agent: HostStatusAgentSession,
): string | null {
  if (agent.name !== null) return agent.name;
  return agent.kind === "terminal-agent" ? "Terminal agent" : null;
}

/** One running agent or open terminal beside the sessions line. */
export interface SandboxSessionPill {
  readonly key: string;
  /** Its name; `Agent` or `Terminal` for one the host sends no name for. */
  readonly label: string;
  /** An agent mid-turn now. */
  readonly working: boolean;
}

/**
 * The live list as pills, agents first: each session by its name, and one
 * in another member's task, whose name the host does not send, by its kind
 * alone. None without a live list.
 */
export function sandboxSessionPills(
  report: SandboxSessionReport,
): readonly SandboxSessionPill[] {
  if (report.kind !== "live") return [];
  return [
    ...report.sessions.agents.map((agent) => ({
      key: `agent:${agent.sessionId}`,
      label: sandboxAgentSessionName(agent) ?? "Agent",
      working: agent.working,
    })),
    ...report.sessions.terminals.map((terminal) => ({
      key: `terminal:${terminal.sessionId}`,
      label: terminal.name ?? "Terminal",
      working: false,
    })),
  ];
}

/**
 * The hover card's host-wide activity under the idle line: `1 agent and
 * 1 terminal on it`. `null` with nothing on it or no list, since the card
 * says nothing it does not know.
 */
export function sandboxHostActivityLine(
  kinds: SandboxSessionKinds | null,
): string | null {
  const names = kinds === null ? [] : sessionKindNames(kinds);
  return names.length === 0 ? null : `${names.join(" and ")} on it`;
}

const SESSIONS_UNKNOWN = "Sessions unknown · no report yet";

export function sandboxSessionsLine(
  report: SandboxSessionReport,
  now: number,
): string {
  switch (report.kind) {
    case "live":
      return report.count === 1
        ? "1 session running"
        : `${report.count} sessions running`;
    case "stale": {
      const at = sandboxReportedAt(report.at);
      return at === null
        ? SESSIONS_UNKNOWN
        : `Sessions as of ${formatSandboxAge(at, now)}`;
    }
    case "unknown":
      return SESSIONS_UNKNOWN;
  }
}

// ── Actions (Flow 6's matrix) ───────────────────────────────────────────────

export type SandboxRowAction =
  | "suspend"
  | "resume"
  | "start"
  | "stop"
  | "keep"
  | "retry"
  | "retry-applying"
  | "resume-paying"
  | "add-credits"
  | "open-tab"
  | "open-terminal"
  | "rename"
  | "idle-settings"
  | "destroy";

export interface SandboxRowActions {
  readonly primary: SandboxRowAction | null;
  readonly menu: readonly SandboxRowAction[];
}

const NO_ROW_ACTIONS: SandboxRowActions = { primary: null, menu: [] };

/**
 * One matrix; a cell not listed is hidden. `Details` is on every row and is
 * not part of it. A row between two states offers only Details (and Destroy
 * from a stuck suspend or stop, as the card always did). A failed agent's
 * sandbox offers no Retry: the row's create makes a kept sandbox, so
 * retrying it would turn the agent's into one that never destroys itself.
 */
export function sandboxRowActions(input: {
  readonly summary: SandboxSummary;
  readonly unreachable: boolean;
  /** A frozen row's remedy is the viewer's own top-up. */
  readonly frozenNeedsOwnCredits: boolean;
}): SandboxRowActions {
  const actions = matrixRowActions(input);
  if (!input.summary.burst || actions.primary !== "retry") return actions;
  return { primary: null, menu: actions.menu };
}

function matrixRowActions(input: {
  readonly summary: SandboxSummary;
  readonly unreachable: boolean;
  readonly frozenNeedsOwnCredits: boolean;
}): SandboxRowActions {
  const { summary } = input;
  // Open terminal starts a released Automations host first, in every state
  // but a failed start, whose primary is Retry; Rename is the only other
  // thing a person does to it.
  if (summary.kind === "automation") {
    return {
      primary: summary.state === "failed" ? "retry" : "open-terminal",
      menu: ["rename"],
    };
  }
  const state = sandboxPublicState(summary);
  if (state === "frozen") {
    return {
      primary: input.frozenNeedsOwnCredits ? "add-credits" : "resume-paying",
      menu: ["rename", "destroy"],
    };
  }
  if (sandboxRowMoving(summary)) {
    return summary.state === "suspending" || summary.state === "stopping"
      ? { primary: null, menu: ["destroy"] }
      : NO_ROW_ACTIONS;
  }
  switch (state) {
    case "failed":
      return { primary: "retry", menu: ["destroy"] };
    case "suspended":
      return {
        primary: "resume",
        menu: [
          "open-tab",
          "open-terminal",
          "rename",
          "idle-settings",
          "destroy",
        ],
      };
    case "stopped":
      return { primary: "start", menu: ["rename", "idle-settings", "destroy"] };
    case "awake":
      if (input.unreachable) {
        return { primary: "stop", menu: ["rename", "destroy"] };
      }
      if (summary.guestConfigured === false) {
        return {
          primary: "retry-applying",
          menu: ["open-terminal", "rename", "stop", "destroy"],
        };
      }
      return {
        primary: summary.burst ? "keep" : "suspend",
        menu: [
          "open-tab",
          "open-terminal",
          "rename",
          "idle-settings",
          "stop",
          "destroy",
        ],
      };
    case "creating":
      return NO_ROW_ACTIONS;
  }
}

export function sandboxRowActionLabel(
  action: SandboxRowAction,
  configuration: SandboxPageConfiguration,
): string {
  switch (action) {
    case "suspend":
      return "Suspend";
    case "resume":
      return "Resume";
    case "start":
      return "Start";
    case "stop":
      return "Stop";
    case "keep":
      return "Keep this sandbox";
    case "retry":
      return "Retry";
    case "retry-applying":
      return "Retry applying";
    case "resume-paying":
      return configuration.kind === "team"
        ? `Resume using my ${configuration.teamName} credits`
        : "Resume using my credits";
    case "add-credits":
      return "Add credits ↗";
    case "open-tab":
      return "Open a tab";
    case "open-terminal":
      return "Open terminal";
    case "rename":
      return "Rename";
    case "idle-settings":
      return "Idle settings…";
    case "destroy":
      return "Destroy";
  }
}

// ── Give it another <period> ────────────────────────────────────────────────

/** `7 days`, `12 hours`, `45 minutes`: a period in its own unit. */
export function sandboxPeriodLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * The warning's lead for a period: a day for one in days, an hour for one in
 * hours; a period shorter than its lead (minutes included) is warned from
 * the moment the clock starts.
 */
export function sandboxRestingWarningLeadMs(minutes: number): number {
  if (minutes % (24 * 60) === 0) return MS_PER_DAY;
  if (minutes % 60 === 0) return MS_PER_HOUR;
  return minutes * MS_PER_MINUTE;
}

/**
 * `Give it another 7 days` (the row's own period), offered on a resting row
 * with a period once it is inside its warning lead; `null` otherwise.
 */
export function sandboxGiveAnotherLabel(
  summary: SandboxSummary,
  now: number,
): string | null {
  const period = summary.destroyAfterRestingMinutes;
  if (period === null || period === 0 || summary.destroyAt === null)
    return null;
  if (summary.frozen) return null;
  const state = sandboxPublicState(summary);
  if (state !== "suspended" && state !== "stopped") return null;
  if (summary.destroyAt - now > sandboxRestingWarningLeadMs(period))
    return null;
  return `Give it another ${sandboxPeriodLabel(period)}`;
}

// ── Header ──────────────────────────────────────────────────────────────────

/**
 * `5 sandboxes and Automations · $0.34 today (UTC day), $0.16 of it yours.`
 * The count is of the rows shown, an Automations host not created yet
 * (`unstartedAutomations`) included.
 */
export function sandboxListHeader(input: {
  readonly rows: readonly SandboxSummary[];
  readonly unstartedAutomations: boolean;
  readonly todayMc: number | null;
  readonly todayYoursMc: number | null;
}): string {
  const automations =
    input.unstartedAutomations ||
    input.rows.some((row) => row.kind === "automation");
  const sandboxes = input.rows.filter(
    (row) => row.kind !== "automation",
  ).length;
  const noun = sandboxes === 1 ? "sandbox" : "sandboxes";
  const count = automations
    ? `${sandboxes} ${noun} and Automations`
    : `${sandboxes} ${noun}`;
  if (input.todayMc === null) return count;
  const today = `${formatSandboxCost(input.todayMc)} today (UTC day)`;
  if (input.todayYoursMc === null || input.todayYoursMc === input.todayMc) {
    return `${count} · ${today}`;
  }
  return `${count} · ${today}, ${formatSandboxCost(input.todayYoursMc)} of it yours`;
}

/** `Showing Suspended. 1 of 3.`: what a filter left of the list. */
export function sandboxFilterSummary(
  filter: SandboxRowFilter,
  shown: number,
  total: number,
): string | null {
  const narrowed = [
    filter.kind === "all" ? null : SANDBOX_KIND_FILTER_LABEL[filter.kind],
    filter.state === "all" ? null : SANDBOX_STATE_FILTER_LABEL[filter.state],
    filter.startedBy === "anyone"
      ? null
      : `Started by ${SANDBOX_STARTER_FILTER_LABEL[filter.startedBy].toLowerCase()}`,
  ].filter((item): item is string => item !== null);
  if (narrowed.length === 0 && filter.search.trim().length === 0) return null;
  const label = narrowed.length === 0 ? "matches" : narrowed.join(", ");
  return `Showing ${label}. ${shown} of ${total}.`;
}

// ── Period inputs ───────────────────────────────────────────────────────────

export type SandboxPeriodUnit = "minutes" | "hours" | "days";

export const SANDBOX_PERIOD_UNIT_MINUTES: Record<SandboxPeriodUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 24 * 60,
};

/** A period as the person typed it: a number and a unit. */
export interface SandboxPeriodDraft {
  readonly value: string;
  readonly unit: SandboxPeriodUnit;
}

/** A stored period in its largest whole unit, for the inputs. */
export function sandboxPeriodDraft(minutes: number | null): SandboxPeriodDraft {
  // Empty is never, which the server spells `0`.
  if (minutes === null || minutes === 0) return { value: "", unit: "days" };
  if (minutes % SANDBOX_PERIOD_UNIT_MINUTES.days === 0) {
    return {
      value: String(minutes / SANDBOX_PERIOD_UNIT_MINUTES.days),
      unit: "days",
    };
  }
  if (minutes % SANDBOX_PERIOD_UNIT_MINUTES.hours === 0) {
    return {
      value: String(minutes / SANDBOX_PERIOD_UNIT_MINUTES.hours),
      unit: "hours",
    };
  }
  return { value: String(minutes), unit: "minutes" };
}

/**
 * The draft in minutes: `null` for an empty draft, `NaN` for one that is not
 * a whole positive number (refused before save, never clamped).
 */
export function sandboxPeriodMinutes(draft: SandboxPeriodDraft): number | null {
  const text = draft.value.trim();
  if (text.length === 0) return null;
  if (!/^\d+$/.test(text)) return Number.NaN;
  const value = Number(text);
  if (value <= 0) return Number.NaN;
  return value * SANDBOX_PERIOD_UNIT_MINUTES[draft.unit];
}

/** Why an idle draft is refused, or `null` when it may be saved. */
export function sandboxIdleRefusal(minutes: number | null): string | null {
  if (minutes === null || Number.isNaN(minutes)) {
    return "Enter a whole number.";
  }
  return minutes < SANDBOX_MIN_IDLE_MINUTES ? "At least 2 minutes." : null;
}

/** Why a resting draft is refused (empty means never), or `null`. */
export function sandboxRestingRefusal(minutes: number | null): string | null {
  return minutes !== null && Number.isNaN(minutes)
    ? "Enter a whole number, or leave it empty for never."
    : null;
}

// ── Links out ───────────────────────────────────────────────────────────────

/** The credits top-up page: the team's billing for a team row, never Personal's. */
export function sandboxAddCreditsUrl(
  signInUrl: string,
  configuration: SandboxPageConfiguration,
): string {
  const base = resolvePlatformBaseUrl(signInUrl);
  return configuration.kind === "team"
    ? `${base}/team/${encodeURIComponent(configuration.teamName)}/billing`
    : `${base}/billing`;
}

/** `Team usage and credits ↗`: the dashboard's team usage page, under the team's environment. */
export function sandboxTeamUsageUrl(
  signInUrl: string,
  teamName: string,
): string {
  return `${resolvePlatformBaseUrl(signInUrl)}/team/${encodeURIComponent(teamName)}/environment/usage`;
}

/**
 * A row's region as the server labels it (`United States (West)`), never its
 * id: `null` from a server that sends no label, and the surface then says no
 * region at all.
 */
export function sandboxRegionLabel(summary: SandboxSummary): string | null {
  const label = summary.regionLabel;
  return label === null || label.length === 0 ? null : label;
}
