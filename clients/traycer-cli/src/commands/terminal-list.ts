import { listTerminalsResponseSchemaV22 } from "@traycer/protocol/host/terminal/unary-schemas";
import type { CanonicalTerminalSessionInfoWithCurrentCwd } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  callHostRpc,
  parseHostResponse,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer terminal list` - the interactive terminals in this Task you can
 * read, including ones whose process has exited but the host still remembers
 * (so a finished command's output stays reachable for as long as the tab is).
 *
 * `terminal-agent` sessions are filtered out: those back another Traycer
 * agent, whose conversation is `traycer agent transcript`'s job. Their PTY
 * grid is a rendering of a TUI, not a transcript.
 */
export function buildTerminalListCommand(opts: {
  readonly epicId: string | null;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const result = await toAgentCliError(
      callHostRpc("terminal.list", {
        scope: { kind: "epic", epicId },
      }),
    );
    const { sessions } = parseHostResponse(
      listTerminalsResponseSchemaV22,
      result,
    );
    const terminals = sessions
      .filter((session) => session.sessionKind === "terminal")
      .map(summarizeTerminal);
    return {
      data: { terminals },
      human: formatTerminalListTable(terminals),
      exitCode: 0,
    };
  };
}

export type TerminalListRow = {
  readonly terminalId: string;
  readonly title: string;
  readonly cwd: string;
  readonly currentCwd: string;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly createdAt: number;
  readonly activeProcessName: string | null;
};

function summarizeTerminal(
  session: CanonicalTerminalSessionInfoWithCurrentCwd,
): TerminalListRow {
  return {
    terminalId: session.sessionId,
    title: terminalTitle(session),
    cwd: session.cwd,
    currentCwd: session.currentCwd,
    status: session.status,
    exitCode: session.exitCode,
    createdAt: session.createdAt,
    activeProcessName: session.activeProcessName ?? null,
  };
}

/**
 * A `null` title means the tab was never renamed, so the GUI derives a label
 * from the working directory; do the same here rather than printing the id
 * twice. The shell's live directory wins over the one it launched in, so the
 * TITLE names the same directory the row's DIRECTORY column shows.
 */
function terminalTitle(
  session: CanonicalTerminalSessionInfoWithCurrentCwd,
): string {
  if (session.title !== null && session.title.length > 0) return session.title;
  const directory =
    session.currentCwd.length > 0 ? session.currentCwd : session.cwd;
  const directoryName = directory.split(/[\\/]/u).filter(Boolean).pop();
  return directoryName === undefined ? session.shellCommand : directoryName;
}

const COLUMNS = [
  "ID",
  "TITLE",
  "STATUS",
  "PROCESS",
  "CREATED",
  "DIRECTORY",
] as const;

/**
 * Fixed-width column table, pure so the layout is testable without a host.
 * DIRECTORY shows the shell's live directory, which is the one that answers
 * "where would a command I read here have run".
 */
export function formatTerminalListTable(
  terminals: ReadonlyArray<TerminalListRow>,
): string {
  if (terminals.length === 0) {
    return "No terminals open in this Task.";
  }
  const rows = terminals.map((terminal) => [
    terminal.terminalId,
    terminal.title,
    formatStatus(terminal),
    terminal.activeProcessName ?? "-",
    new Date(terminal.createdAt).toISOString(),
    terminal.currentCwd.length > 0 ? terminal.currentCwd : terminal.cwd,
  ]);
  const widths = COLUMNS.map((header, column) =>
    rows.reduce((max, row) => Math.max(max, row[column].length), header.length),
  );
  const renderRow = (cells: ReadonlyArray<string>): string =>
    cells
      .map((cell, column) =>
        // The final column (DIRECTORY) stays unpadded so a long path never
        // trails a wall of spaces.
        column === COLUMNS.length - 1 ? cell : cell.padEnd(widths[column]),
      )
      .join("  ")
      .trimEnd();
  return [
    renderRow(COLUMNS),
    ...rows.map(renderRow),
    "",
    "Read one with `traycer terminal output <terminal-id>`.",
  ].join("\n");
}

function formatStatus(terminal: TerminalListRow): string {
  if (terminal.status === "running") return "running";
  if (terminal.exitCode === null) return "exited";
  return `exited(${terminal.exitCode})`;
}
