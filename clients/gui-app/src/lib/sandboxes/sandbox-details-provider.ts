import type {
  SandboxCost,
  SandboxCostSegment,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
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
  formatSandboxDollars,
} from "@/lib/sandboxes/sandbox-strings";

/**
 * The sandbox provider of the Details drawer: Status, History and a
 * sanitized Export for ONE sandbox, read from the control plane's row and
 * its cost ledger, never from the host. Reading it never wakes or spends.
 *
 * Shaped as the environments design's `DetailsEntry` (`kind: "sandbox"`), so
 * its drawer can take this provider once it lands; until then
 * `sandbox-details-drawer.tsx` renders the same three sections.
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
  readonly now: number;
}

const SEGMENT_LABEL: Record<SandboxCostSegment["state"], string> = {
  awake: "Awake",
  suspended: "Suspended",
  stopped: "Stopped",
};

function memberOr(
  member: SandboxSummary["createdBy"],
  viewerUserId: string | null,
  fallback: string,
): string {
  return member === null ? fallback : sandboxMemberName(member, viewerUserId);
}

function starter(summary: SandboxSummary, viewerUserId: string | null): string {
  if (summary.kind === "automation") return "Automations";
  if (summary.burst) return "An agent";
  return memberOr(summary.createdBy, viewerUserId, "you");
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
  rows.push({ label: "Started by", value: starter(summary, viewerUserId) });
  if (summary.keptBy !== null) {
    rows.push({
      label: "Kept by",
      value: sandboxMemberName(summary.keptBy, viewerUserId),
    });
  }
  const idle = summary.idleMinutes ?? SANDBOX_DEFAULT_IDLE_MINUTES;
  rows.push({
    label: "Idle",
    value: summary.burst
      ? `destroys itself after ${idle} idle min`
      : `suspends after ${idle} idle min`,
  });
  rows.push({
    label: "Resting",
    value:
      summary.destroyAfterRestingMinutes === null ||
      summary.destroyAfterRestingMinutes === 0
        ? KEPT_UNTIL_YOU_DESTROY_IT
        : `destroyed after ${sandboxPeriodLabel(summary.destroyAfterRestingMinutes)}`,
  });
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
  const events: SandboxDetailsEvent[] = [
    {
      at: summary.createdAt,
      label: "Created",
      value: summary.burst
        ? "by an agent"
        : `by ${memberOr(summary.createdBy, viewerUserId, "you")}`,
    },
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
