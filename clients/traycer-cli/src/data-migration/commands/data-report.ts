import {
  phaseHoldsStartupBarrier,
  phaseIsPostActivation,
  rollbackAllowedFrom,
  type MigrationJournal,
  type SessionImpact,
} from "@traycer/protocol/config/data-migration-contracts";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { SOURCE_CHANGED_CODES } from "../engine/content-inventory";
import type {
  EngineBlocker,
  EngineResult,
  SessionImpactPresentation,
} from "../engine/engine-types";
import { failed, type DataCommandOutcome } from "./data-command-types";

/**
 * Text shared by the `traycer data` commands: blockers, the session impact
 * report and, for a recorded phase, the recovery actions that are valid in
 * it. Paths appear only in the user's own terminal output, never in a log.
 */

const MAX_LISTED = 20;

export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${String(bytes)} bytes`
    : `${value.toFixed(1)} ${units[unit] ?? ""}`;
}

export function blockerLines(blockers: readonly EngineBlocker[]): string[] {
  const lines = blockers
    .slice(0, MAX_LISTED)
    .map(
      (blocker) =>
        `  - ${blocker.message}${blocker.object === null ? "" : ` (${blocker.object})`} [${blocker.code}]`,
    );
  if (blockers.length > MAX_LISTED) {
    lines.push(
      `  ...and ${String(blockers.length - MAX_LISTED)} more (--json lists all)`,
    );
  }
  return lines;
}

function routeLabel(session: SessionImpact): string {
  switch (session.route.primary) {
    case "native-resume":
    case "native-relocate":
      return session.route.onFailure === "fresh-context"
        ? "expected to continue; if that fails it continues in a new provider session"
        : "expected to continue";
    case "fresh-context":
      return "continues in a new provider session rebuilt from its visible history";
    case "unknown":
      return "held at first use until you start a new agent for it";
  }
}

/**
 * The per-session continuation report, grouped by outcome, with the affected
 * sessions listed. Predictions, not promises: a provider can still fail to
 * resume.
 */
export function impactLines(presentation: SessionImpactPresentation): string[] {
  const sessions = presentation.report.sessions;
  if (sessions.length === 0) return ["Sessions: none affected."];
  const continuing = sessions.filter(
    (session) =>
      session.route.primary === "native-resume" ||
      session.route.primary === "native-relocate",
  );
  const withFallback = continuing.filter(
    (session) => session.route.onFailure === "fresh-context",
  );
  const fresh = sessions.filter(
    (session) => session.route.primary === "fresh-context",
  );
  const unknown = sessions.filter(
    (session) => session.route.primary === "unknown",
  );
  const lines = [
    `Sessions whose working folder or provider files move: ${String(sessions.length)}`,
    `  ${String(continuing.length)} expected to continue (${String(withFallback.length)} of them fall back to a new provider session if continuing fails)`,
    `  ${String(fresh.length)} continue in a new provider session rebuilt from their visible history`,
    `  ${String(unknown.length)} are held at first use until you start a new agent for them`,
    "A new provider session keeps the chat history Traycer shows but loses provider-only state (todos, permissions, background tasks). Provider files are copied unchanged. Terminal agents keep their native transcript; Traycer cannot show it as chat history.",
  ];
  const affected = sessions.filter(
    (session) =>
      session.route.primary !== "native-resume" &&
      session.route.primary !== "native-relocate",
  );
  const listed = [...affected, ...withFallback].slice(0, MAX_LISTED);
  if (listed.length > 0) lines.push("Affected sessions:");
  for (const session of listed) {
    const kind = session.surface === "tui" ? "terminal agent" : "chat";
    const version =
      session.providerVersion === null ? "" : ` ${session.providerVersion}`;
    lines.push(
      `  - ${kind} ${session.sessionId} (${session.provider}${version}): ${routeLabel(session)}`,
    );
  }
  const unlisted = affected.length + withFallback.length - listed.length;
  if (unlisted > 0)
    lines.push(`  ...and ${String(unlisted)} more (--json lists all)`);
  return lines;
}

/**
 * The commands that are valid for `journal` in its recorded phase. Rollback
 * is offered only before activation; after it the old folder is a backup and
 * never becomes authoritative again.
 */
export function nextStepLines(journal: MigrationJournal): string[] {
  const id = journal.id;
  if (journal.phase === "planned") {
    return [
      "  traycer data recover              continue this move",
      "  traycer data recover --rollback   roll back the plan (nothing was copied yet; its empty destination folder and record may remain)",
    ];
  }
  if (journal.phase === "rollback-requested") {
    return [
      `  traycer data recover              finish putting everything back in ${journal.source.path}`,
    ];
  }
  if (
    phaseHoldsStartupBarrier(journal.phase) &&
    rollbackAllowedFrom(journal.phase)
  ) {
    return [
      `  traycer data recover              continue the move to ${journal.destination.path}`,
      `  traycer data recover --rollback   put everything back in ${journal.source.path}`,
    ];
  }
  if (journal.phase === "activated") {
    return [
      `  traycer data recover              finish the move (it can no longer be undone)`,
    ];
  }
  if (journal.phase === "cleaning") {
    return [
      `  traycer data cleanup ${id}   finish deleting the old folder ${journal.source.path}`,
    ];
  }
  if (
    journal.phase === "complete" &&
    journal.cleanupProgress?.finished !== true
  ) {
    return [
      `  traycer data cleanup ${id}   after checking Traycer works, permanently delete the old folder ${journal.source.path}`,
    ];
  }
  if (journal.phase === "rolled-back") {
    return [
      `  traycer data cleanup ${id}   delete the unused copy in ${journal.destination.path} (your data stays in ${journal.source.path})`,
    ];
  }
  return [];
}

/** What a stopped engine run means for the user, with the actions valid now. */
export function stoppedOutcome(
  result: Extract<EngineResult, { kind: "stopped" }>,
  prefix: readonly string[],
): DataCommandOutcome {
  const lines = [...prefix];
  if (result.blockers.length > 0) {
    lines.push("Stopped:");
    lines.push(...blockerLines(result.blockers));
  }
  const journal = result.journal;
  if (journal !== null) {
    // A changed source never matches the frozen inventory again, so
    // continuing would stop the same way: rollback is the only way out.
    const sourceChanged =
      rollbackAllowedFrom(journal.phase) &&
      result.blockers.some((blocker) => SOURCE_CHANGED_CODES.has(blocker.code));
    if (phaseHoldsStartupBarrier(journal.phase)) {
      lines.push(
        sourceChanged
          ? "Traycer stays stopped until this move is rolled back."
          : "Traycer stays stopped until this move is continued or rolled back.",
      );
    } else if (phaseIsPostActivation(journal.phase)) {
      lines.push(`Traycer uses ${journal.destination.path}.`);
    }
    const next = sourceChanged
      ? [
          `  traycer data recover --rollback   put everything back in ${journal.source.path}`,
        ]
      : nextStepLines(journal);
    if (next.length > 0) lines.push("Next:", ...next);
  }
  const message =
    result.reason === "damaged"
      ? "a Traycer data record is damaged; see `traycer data status`"
      : result.reason === "conflict"
        ? "something changed outside Traycer; nothing was overwritten"
        : result.reason === "failed"
          ? "the operation stopped before finishing; run `traycer data status`"
          : "the operation cannot continue yet";
  return failed(
    CLI_ERROR_CODES.DATA_MIGRATION_BLOCKED,
    message,
    {
      reason: result.reason,
      migrationId: journal?.id ?? null,
      phase: journal?.phase ?? null,
      blockers: result.blockers,
    },
    lines,
  );
}
