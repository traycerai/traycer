import type {
  SandboxCost,
  SandboxCostSegment,
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
  sandboxMemberName,
  sandboxPeriodLabel,
  sandboxPublicState,
  sandboxShapeLine,
} from "@/lib/sandboxes/sandbox-row-lines";
import {
  KEPT_UNTIL_YOU_DESTROY_IT,
  SANDBOX_LIST_FAILED,
  formatSandboxDollars,
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

function starter(input: SandboxDetailsInput): string | null {
  if (input.summary.kind === "automation") return "Automations";
  if (input.summary.burst) return "An agent";
  return creatorName(input);
}

/** Idle, then Resting; an agent's sandbox never rests, it destroys itself. */
function idleRows(summary: SandboxSummary): SandboxDetailsRow[] {
  const idle = summary.idleMinutes ?? SANDBOX_DEFAULT_IDLE_MINUTES;
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
  const rows: SandboxDetailsRow[] = [
    {
      label: "State",
      value: SANDBOX_PUBLIC_STATE_LABEL[sandboxPublicState(summary)],
    },
    {
      label: "Last report",
      value:
        summary.lastActivityAt === null
          ? "No report yet"
          : formatSandboxAge(summary.lastActivityAt, now),
    },
    { label: "Shape", value: sandboxShapeLine(summary) },
    { label: "Region", value: summary.region },
  ];
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
      value: `out of credits since ${formatSandboxDate(summary.frozenAt, true)}; destroyed on ${formatSandboxDate(frozenDestroyAt(summary.frozenAt), false)}`,
    });
  }
  if (summary.state === "failed") {
    rows.push({
      label: "Failed",
      value: `Failed to start (${summary.failureCode ?? "unknown"}) · Nothing is billed for a sandbox that never woke`,
    });
  }
  if (summary.guestConfigured === false) {
    rows.push({ label: "Settings", value: "didn't apply" });
  }
  rows.push({ label: "Support reference", value: summary.id });
  return rows;
}

function historyEvents(input: SandboxDetailsInput): SandboxDetailsEvent[] {
  const { summary, cost, viewerUserId } = input;
  const creator = creatorName(input);
  let created = "";
  if (summary.burst) created = "by an agent";
  else if (creator !== null) created = `by ${creator}`;
  const events: SandboxDetailsEvent[] = [
    { at: summary.createdAt, label: "Created", value: created },
  ];
  for (const segment of cost?.segments ?? []) {
    events.push({
      at: segment.fromAt,
      label: SEGMENT_LABEL[segment.state],
      value: `until ${formatSandboxDate(segment.toAt, true)} · ${formatSandboxDollars(segment.millicredits)}`,
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
      status: Object.fromEntries(status.map((row) => [row.label, row.value])),
      history: history.map((event) => ({
        at: event.at === null ? null : new Date(event.at).toISOString(),
        event: event.label,
        detail: event.value,
      })),
    }),
  };
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
    return `Failed to start (${summary.failureCode ?? "unknown"})`;
  }
  if (summary.frozen) return "Out of credits";
  if (summary.guestConfigured === false) return "Settings didn't apply";
  return null;
}

function detailsStatus(summary: SandboxSummary): DetailsStatus {
  const state = SANDBOX_PUBLIC_STATE_LABEL[sandboxPublicState(summary)];
  const reason = sandboxReason(summary);
  return {
    summary: `${state} · ${sandboxShapeLine(summary)} · ${summary.region}`,
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
