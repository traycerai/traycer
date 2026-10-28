import type {
  SandboxCost,
  SandboxCostSegment,
  SandboxHistoryEntry,
  SandboxListResponse,
  SandboxSummary,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxQueryKeys } from "@/lib/query-keys";
import type {
  DetailsEntry,
  DetailsHistory,
  DetailsProviderContext,
  DetailsStatus,
  DetailsSubject,
} from "@/lib/settings-details-entry";
import { frozenDestroyAt } from "@/lib/sandboxes/sandbox-balance";
import {
  SANDBOX_DEFAULT_IDLE_MINUTES,
  SANDBOX_PUBLIC_STATE_LABEL,
  formatSandboxAge,
  formatSandboxDate,
  sandboxFailedToStart,
  sandboxMemberName,
  sandboxPeriodLabel,
  sandboxPublicState,
  sandboxRegionLabel,
  sandboxReportedAt,
  sandboxShapeLine,
  sandboxSupportReferenceLine,
} from "@/lib/sandboxes/sandbox-row-lines";
import {
  KEPT_UNTIL_YOU_DESTROY_IT,
  SANDBOX_LIST_FAILED,
  formatSandboxCost,
} from "@/lib/sandboxes/sandbox-strings";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The sandbox provider of the Details drawer: Status, History and a
 * sanitized Export for ONE sandbox, read from the control plane's row and
 * its cost ledger, never from the host. Reading it never wakes or spends.
 *
 * `sandbox-details-drawer.tsx` renders it wherever a sandbox's Details opens
 * (a row, the setup line, the hover card, a notification);
 * `sandboxDetailsProvider` hands the same entry to the Settings Details
 * drawer as its `sandbox` kind.
 */

/** One line of a section: what it is, and what it says. */
export interface SandboxDetailsRow {
  readonly label: string;
  readonly value: string;
}

/** One History event, oldest first; untimed events after the timed ones. */
export interface SandboxDetailsEvent {
  /** `null` when the summary carries no time for it (Kept). */
  readonly at: number | null;
  readonly label: string;
  readonly value: string;
}

/**
 * The export: the two sections as typed data. No values, credentials,
 * sessions or paths: guest-authored failure text and the host's routes are
 * left out, since either can carry a path or a value.
 */
export interface SandboxDetailsExport {
  readonly kind: "sandbox";
  readonly sandboxId: string;
  readonly exportedAt: number;
  readonly status: Readonly<Record<string, string>>;
  readonly history: readonly {
    readonly at: string | null;
    readonly event: string;
    readonly detail: string;
  }[];
}

export interface SandboxDetailsEntry {
  readonly kind: "sandbox";
  readonly status: readonly SandboxDetailsRow[];
  readonly history: readonly SandboxDetailsEvent[];
  export(): SandboxDetailsExport;
}

export interface SandboxDetailsInput {
  readonly summary: SandboxSummary;
  readonly cost: SandboxCost | null;
  readonly wakeString: string | null;
  readonly viewerUserId: string | null;
  /**
   * The sandbox is the viewer's Personal one, so a row naming no creator was
   * started by them. Otherwise an unnamed creator is left unsaid.
   */
  readonly personal: boolean;
  readonly now: number;
}

const SEGMENT_LABEL: Record<SandboxCostSegment["state"], string> = {
  awake: "Awake",
  suspended: "Suspended",
  stopped: "Stopped",
};

/** Who created the sandbox, or `null` when the row does not say. */
function creatorName(input: SandboxDetailsInput): string | null {
  const { summary } = input;
  if (summary.createdBy !== null) {
    return sandboxMemberName(summary.createdBy, input.viewerUserId);
  }
  return input.personal ? "you" : null;
}

/** What starts Automations: its row is made by the first shell opened on it. */
const AUTOMATIONS_STARTER = "the first shell";

const NOTHING_BILLED_NEVER_WOKE =
  "Nothing is billed for a sandbox that never woke";

function starter(input: SandboxDetailsInput): string | null {
  if (input.summary.kind === "automation") return AUTOMATIONS_STARTER;
  if (input.summary.burst) return "An agent";
  return creatorName(input);
}

/**
 * Idle, then Resting; an agent's sandbox never rests, it destroys itself,
 * and Automations never rests either: it is released, its files kept.
 */
function idleRows(summary: SandboxSummary): SandboxDetailsRow[] {
  const idle = summary.idleMinutes ?? SANDBOX_DEFAULT_IDLE_MINUTES;
  if (summary.kind === "automation") {
    return [
      { label: "Idle", value: `released after ${idle} idle min · files kept` },
    ];
  }
  if (summary.burst) {
    return [{ label: "Idle", value: `destroys itself after ${idle} idle min` }];
  }
  return [
    { label: "Idle", value: `suspends after ${idle} idle min` },
    {
      label: "Resting",
      value:
        summary.destroyAfterRestingMinutes === null ||
        summary.destroyAfterRestingMinutes === 0
          ? KEPT_UNTIL_YOU_DESTROY_IT
          : `destroyed after ${sandboxPeriodLabel(summary.destroyAfterRestingMinutes)}`,
    },
  ];
}

function statusRows(input: SandboxDetailsInput): SandboxDetailsRow[] {
  const { summary, now, viewerUserId } = input;
  const reportedAt = sandboxReportedAt(summary.lastActivityAt);
  const rows: SandboxDetailsRow[] = [
    {
      label: "State",
      value: SANDBOX_PUBLIC_STATE_LABEL[sandboxPublicState(summary)],
    },
    {
      label: "Last report",
      value:
        reportedAt === null
          ? "No report yet"
          : formatSandboxAge(reportedAt, now),
    },
    { label: "Shape", value: sandboxShapeLine(summary) },
  ];
  const regionLabel = sandboxRegionLabel(summary);
  if (regionLabel !== null) {
    rows.push({ label: "Region", value: regionLabel });
  }
  if (input.wakeString !== null) {
    rows.push({ label: "Suspend", value: input.wakeString });
  }
  if (summary.wakePayer !== null) {
    rows.push({
      label: "Paid by",
      value: sandboxMemberName(summary.wakePayer, viewerUserId),
    });
  }
  const startedBy = starter(input);
  if (startedBy !== null) rows.push({ label: "Started by", value: startedBy });
  if (summary.keptBy !== null) {
    rows.push({
      label: "Kept by",
      value: sandboxMemberName(summary.keptBy, viewerUserId),
    });
  }
  rows.push(...idleRows(summary));
  if (summary.destroyAt !== null) {
    rows.push({
      label: "Destroyed on",
      value: `${formatSandboxDate(summary.destroyAt, true)} unless used`,
    });
  }
  if (summary.frozen && summary.frozenAt !== null) {
    rows.push({
      label: "Frozen",
      value: `out of credits since ${formatSandboxDate(summary.frozenAt, true)}; destroyed on ${formatSandboxDate(frozenDestroyAt(summary.frozenAt), true)}`,
    });
  }
  if (summary.state === "failed") {
    rows.push({
      label: "Failed",
      value: `${sandboxFailedToStart(summary.failureCode)} · ${NOTHING_BILLED_NEVER_WOKE}`,
    });
  }
  if (summary.guestConfigured === false) {
    rows.push({ label: "Settings", value: "didn't apply" });
  }
  rows.push({
    label: "Support reference",
    value: sandboxSupportReferenceLine(summary.failureCode, summary.id),
  });
  return rows;
}

const GESTURE_LABEL: Record<
  NonNullable<SandboxHistoryEntry["gesture"]>,
  string
> = {
  "open-terminal": "Open terminal",
  send: "Send",
  "open-files": "Open files",
};

const RESTING_STATES: ReadonlySet<string> = new Set([
  "suspending",
  "suspended",
  "stopping",
  "stopped",
  "released",
]);

/**
 * What an operation did: `Created`, `Resumed`, `Suspended`, `Stopped`, or
 * `Failed to start (SBX-0412)` for a create or a start that failed, by its
 * support reference.
 */
function operationVerb(entry: SandboxHistoryEntry): string {
  if (entry.state === "failed") {
    return sandboxFailedToStart(entry.outcomeDetail);
  }
  if (entry.fromState === "creating") return "Created";
  if (entry.cause === "freeze") return "Frozen";
  switch (entry.state) {
    case "suspending":
    case "suspended":
      return "Suspended";
    case "stopping":
    case "stopped":
      return entry.outcomeCause === "failure"
        ? "Stopped after a failed wake"
        : "Stopped";
    case "released":
      return "Released";
    case "destroying":
    case "destroyed":
      return "Destroyed";
    default:
      return entry.fromState === "stopped" || entry.fromState === "stopping"
        ? "Started"
        : "Resumed";
  }
}

/**
 * Who or what started it: `by you (Open terminal)`, `after 30 idle minutes`,
 * or nothing for the control plane's own moves.
 */
function operationCause(
  entry: SandboxHistoryEntry,
  input: SandboxDetailsInput,
): string | null {
  const { summary, viewerUserId } = input;
  if (entry.actor !== null) {
    const who = `by ${sandboxMemberName(entry.actor, viewerUserId)}`;
    return entry.gesture === null
      ? who
      : `${who} (${GESTURE_LABEL[entry.gesture]})`;
  }
  if (entry.fromState === "creating") {
    if (summary.kind === "automation") return `by ${AUTOMATIONS_STARTER}`;
    if (summary.burst) return "by an agent";
    return null;
  }
  if (entry.cause === "idle" || entry.cause === "burst-idle") {
    const idle = summary.idleMinutes ?? SANDBOX_DEFAULT_IDLE_MINUTES;
    return `after ${idle} idle minutes`;
  }
  if (entry.cause === "freeze") return "out of credits";
  return null;
}

/**
 * One History line: `Suspended by you until Oct 25 at 09:55 · under $0.01`,
 * `Resumed by you (Open terminal) · awake until Oct 25 at 10:01 · $0.02`, or
 * on the current operation `· resting from then` / `· awake from then`.
 */
function historyEntryEvent(
  entry: SandboxHistoryEntry,
  input: SandboxDetailsInput,
): SandboxDetailsEvent {
  const cause = operationCause(entry, input);
  const resting = RESTING_STATES.has(entry.state);
  const ended = entry.state === "destroying" || entry.state === "destroyed";
  const cost = formatSandboxCost(entry.millicredits);
  let span: readonly (string | null)[];
  if (entry.state === "failed") {
    span = [cause, NOTHING_BILLED_NEVER_WOKE];
  } else if (ended) {
    span = [cause];
  } else if (entry.untilAt === null) {
    span = [cause, resting ? "resting from then" : "awake from then"];
  } else if (resting) {
    const until = `until ${formatSandboxDate(entry.untilAt, true)}`;
    span = [cause === null ? until : `${cause} ${until}`, cost];
  } else {
    span = [
      cause,
      `awake until ${formatSandboxDate(entry.untilAt, true)}`,
      cost,
    ];
  }
  return {
    at: entry.at,
    label: operationVerb(entry),
    value: span.filter((part): part is string => part !== null).join(" · "),
  };
}

function historyEvents(input: SandboxDetailsInput): SandboxDetailsEvent[] {
  const { summary, cost, viewerUserId } = input;
  // The operations, where the server records them; a team row of the list
  // and a server before them leave the ledger's segments below.
  if (cost !== null && cost.history.length > 0) {
    const events = cost.history.map((entry) => historyEntryEvent(entry, input));
    if (summary.keptBy !== null) {
      events.push({
        at: summary.keptAt,
        label: "Kept",
        value: `by ${sandboxMemberName(summary.keptBy, viewerUserId)}`,
      });
    }
    return events.sort(byTime);
  }
  const creator = creatorName(input);
  let created = "";
  if (summary.kind === "automation") created = `by ${AUTOMATIONS_STARTER}`;
  else if (summary.burst) created = "by an agent";
  else if (creator !== null) created = `by ${creator}`;
  const events: SandboxDetailsEvent[] = [
    { at: summary.createdAt, label: "Created", value: created },
  ];
  for (const segment of cost?.segments ?? []) {
    events.push({
      at: segment.fromAt,
      label: SEGMENT_LABEL[segment.state],
      value: `until ${formatSandboxDate(segment.toAt, true)} · ${formatSandboxCost(segment.millicredits)}`,
    });
  }
  if (summary.restingSince !== null) {
    events.push({
      at: summary.restingSince,
      label: "Resting",
      value: "the resting clock started",
    });
  }
  if (summary.frozenAt !== null) {
    events.push({
      at: summary.frozenAt,
      label: "Frozen",
      value: "out of credits",
    });
  }
  if (summary.keptBy !== null) {
    // The summary carries no keep time, and `lastTransitionAt` moves on
    // every later transition.
    events.push({
      at: null,
      label: "Kept",
      value: `by ${sandboxMemberName(summary.keptBy, viewerUserId)}`,
    });
  }
  if (summary.destroyedAt !== null) {
    events.push({ at: summary.destroyedAt, label: "Destroyed", value: "" });
  }
  return events.sort(byTime);
}

function byTime(a: SandboxDetailsEvent, b: SandboxDetailsEvent): number {
  if (a.at === null || b.at === null) {
    return (a.at === null ? 1 : 0) - (b.at === null ? 1 : 0);
  }
  return a.at - b.at;
}

export function sandboxDetailsEntry(
  input: SandboxDetailsInput,
): SandboxDetailsEntry {
  const status = statusRows(input);
  const history = historyEvents(input);
  return {
    kind: "sandbox",
    status,
    history,
    export: () => ({
      kind: "sandbox",
      sandboxId: input.summary.id,
      exportedAt: input.now,
      status: Object.fromEntries(exportStatusEntries(status, input.summary)),
      history: history.map((event) => ({
        at: event.at === null ? null : new Date(event.at).toISOString(),
        event: event.label,
        detail: event.value,
      })),
    }),
  };
}

/**
 * The export's status: the rows, then the raw failure code, which the rows
 * show only as its support reference.
 */
function exportStatusEntries(
  status: readonly SandboxDetailsRow[],
  summary: SandboxSummary,
): [string, string][] {
  const entries = status.map((row): [string, string] => [row.label, row.value]);
  if (summary.failureCode !== null) {
    entries.push(["Failure code", summary.failureCode]);
  }
  return entries;
}

/**
 * Refetches the signed-in user's queries of one family and returns what they
 * answered: only answers newer than this read, so a failed refetch, or an
 * earlier account's entry, never stands in for the control plane's word.
 * `null` when the refetch failed or no query answered.
 */
async function freshAnswers<T>(
  context: DetailsProviderContext,
  family: readonly unknown[],
  userId: string | null,
): Promise<T[] | null> {
  const startedAt = Date.now();
  // The family's per-account keys end with the account service and the user.
  const filters = {
    queryKey: family,
    predicate: (query: { readonly queryKey: readonly unknown[] }) =>
      query.queryKey.length === family.length + 2 &&
      query.queryKey.at(-1) === userId,
  };
  try {
    await context.queryClient.refetchQueries(filters, { throwOnError: true });
  } catch {
    return null;
  }
  const answers = context.queryClient
    .getQueryCache()
    .findAll(filters)
    .flatMap((query) => {
      const data = context.queryClient.getQueryData<T | null>(query.queryKey);
      return query.state.dataUpdatedAt < startedAt ||
        data === undefined ||
        data === null
        ? []
        : [data];
    });
  return answers.length === 0 ? null : answers;
}

/** Why the sandbox needs attention, or `null` when nothing does. */
function sandboxReason(summary: SandboxSummary): string | null {
  if (summary.state === "failed") {
    return sandboxFailedToStart(summary.failureCode);
  }
  if (summary.frozen) return "Out of credits";
  if (summary.guestConfigured === false) return "Settings didn't apply";
  return null;
}

function detailsStatus(summary: SandboxSummary): DetailsStatus {
  const state = SANDBOX_PUBLIC_STATE_LABEL[sandboxPublicState(summary)];
  const reason = sandboxReason(summary);
  return {
    summary: [state, sandboxShapeLine(summary), sandboxRegionLabel(summary)]
      .filter((part): part is string => part !== null)
      .join(" · "),
    currentVersion: null,
    changedBy: null,
    changedAt: summary.lastTransitionAt,
    reason,
    hosts: [
      {
        hostId: summary.hostId,
        name: summary.displayName,
        item: null,
        state,
        reason,
        at: summary.lastTransitionAt,
        lastReportedAt: summary.lastActivityAt,
        recovery: null,
      },
    ],
  };
}

function detailsHistory(entry: SandboxDetailsEntry): DetailsHistory {
  return {
    readerScope: "full",
    // The drawer's history is timed; Kept, which carries no time, stays in
    // the Status rows.
    entries: entry.history.flatMap((event) =>
      event.at === null
        ? []
        : [
            {
              at: event.at,
              actor: null,
              operation: event.label,
              outcome: event.value,
              hosts: [],
            },
          ],
    ),
  };
}

/**
 * The Settings Details drawer's `sandbox` provider, for the sandbox
 * `subject.key` names. Every load, an export's included, refetches the
 * signed-in user's list and cost ledger first and reads only those answers,
 * so a reader never sees a row the server no longer returns, or another
 * account's.
 */
export async function sandboxDetailsProvider(
  subject: DetailsSubject,
  context: DetailsProviderContext,
): Promise<DetailsEntry> {
  const viewerUserId = useAuthStore.getState().contextMetadata?.userId ?? null;
  const [lists, costs] = await Promise.all([
    freshAnswers<SandboxListResponse>(
      context,
      sandboxQueryKeys.listAll(),
      viewerUserId,
    ),
    freshAnswers<UserSandboxCost>(
      context,
      sandboxQueryKeys.costsAll(),
      viewerUserId,
    ),
  ]);
  if (lists === null) throw new Error(SANDBOX_LIST_FAILED);
  const summary = lists
    .flatMap((list) => list.sandboxes)
    .find((row) => row.id === subject.key);
  if (summary === undefined) {
    throw new Error("This sandbox is no longer listed: it was destroyed.");
  }
  const entry = sandboxDetailsEntry({
    summary,
    // A ledger that did not answer leaves the cost history out rather than
    // showing an earlier one.
    cost:
      (costs ?? [])
        .flatMap((answer) => answer.sandboxes)
        .find((cost) => cost.sandboxId === summary.id) ?? null,
    wakeString: null,
    viewerUserId,
    // The configuration is not known here: an unnamed creator is left
    // unsaid rather than called "you".
    personal: false,
    now: Date.now(),
  });
  const status = detailsStatus(summary);
  const history = detailsHistory(entry);
  return {
    subject,
    title: summary.displayName,
    status: () => status,
    history: () => history,
    exportDiagnostics: async () => {
      // Retrieval rechecks the list, even while the drawer stays open.
      const fresh = await sandboxDetailsProvider(subject, context);
      return {
        subject,
        title: fresh.title,
        exportedAt: Date.now(),
        status: fresh.status(),
        history: fresh.history(),
      };
    },
  };
}
