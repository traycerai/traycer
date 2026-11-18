import type { PlainTerminalRecord } from "@traycer/protocol/host/terminal/plain-schemas";
import {
  PLAIN_TERMINAL_STREAM_METHOD,
  plainTerminalCollectionIdentityKey,
} from "@/lib/terminals/plain-terminal-authority";
import type { TerminalSidebarSessionRow } from "@/lib/terminals/reconcile-terminal-sidebar-sessions";
import { defineComposedView } from "@/lib/view-composition/composed-view";

/**
 * A task's terminal list as the app composes it: what the viewer's own hosts
 * report (reconciled by `reconcileTerminalSidebarSessions`), and the catalog
 * rows each team environment the task is attached to owns, which only the
 * pool's environment arm serves to a member.
 */
export const EPIC_TERMINAL_LIST_COMPOSED_VIEW = defineComposedView(
  "epic-terminal-list",
  [
    {
      id: "viewer-plain",
      kind: "stream",
      method: PLAIN_TERMINAL_STREAM_METHOD,
    },
    {
      id: "environment-arm",
      kind: "stream",
      method: "environment.plainTerminals.subscribe",
    },
  ],
);

const DORMANT_GRID_COLS = 80;
const DORMANT_GRID_ROWS = 24;

/**
 * The reconciled rows plus each arm record no reconciled row already names,
 * by fleet identity `(hostId, terminalId)`. An arm row is a catalog record
 * only: the pool carries no live runtime for it, so its runtime is
 * `unknown`, and it is opened through its owning host like any durable row.
 */
export function withEnvironmentArmTerminals(
  rows: readonly TerminalSidebarSessionRow[],
  arm: readonly PlainTerminalRecord[],
): readonly TerminalSidebarSessionRow[] {
  if (arm.length === 0) return rows;
  const seen = new Set(
    rows.map((row) =>
      plainTerminalCollectionIdentityKey(row.hostId, row.session.sessionId),
    ),
  );
  const added: TerminalSidebarSessionRow[] = [];
  for (const record of arm) {
    const key = plainTerminalCollectionIdentityKey(
      record.hostId,
      record.terminalId,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({
      session: {
        sessionId: record.terminalId,
        scope: record.scope,
        sessionKind: "terminal",
        cwd: record.launch.cwd,
        shellCommand: record.launch.shellCommand,
        shellArgs: [...record.launch.shellArgs],
        cols: DORMANT_GRID_COLS,
        rows: DORMANT_GRID_ROWS,
        status: "running",
        exitCode: null,
        exitReason: null,
        createdAt: Date.parse(record.createdAt),
        title: record.manualTitle,
        activeProcessName: null,
      },
      hostId: record.hostId,
      durable: true,
      runtimeStatus: "unknown",
    });
  }
  return added.length === 0 ? rows : [...rows, ...added];
}
