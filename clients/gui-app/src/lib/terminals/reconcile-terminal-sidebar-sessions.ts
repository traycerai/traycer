import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import type {
  PlainTerminalListCoverage,
  PlainTerminalProjection,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { isVisibleEpicTerminalSession } from "@/lib/terminals/terminal-session-filters";
import {
  getPlainTerminal,
  plainTerminalCollectionIdentityKey,
  plainTerminalCollectionValues,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";

const DORMANT_GRID_COLS = 80;
const DORMANT_GRID_ROWS = 24;

export type TerminalListLifecycleOwner = "registry" | "manager";

/**
 * A `terminal.list` row as consumed by sidebar reconciliation. Updated hosts
 * always send `lifecycleOwner`. A missing value is fail-closed as a registry
 * shadow on a capable host and ignored on a positively known legacy host.
 */
export type ListedTerminalSidebarSession = CanonicalTerminalSessionInfo & {
  readonly lifecycleOwner?: TerminalListLifecycleOwner;
};

export interface TerminalSidebarSessionRow {
  readonly session: ListedTerminalSidebarSession;
  readonly hostId: string;
  readonly durable: boolean;
  readonly runtimeStatus: "running" | "dormant" | "unknown";
}

export interface ReconcileTerminalSidebarSessionsArgs {
  readonly epicId: string;
  readonly servingHostId: string;
  readonly capability: "unknown" | "legacy" | "capable";
  readonly topology: "local" | "fleet";
  readonly coverage: PlainTerminalListCoverage | null;
  readonly listed: readonly ListedTerminalSidebarSession[];
  readonly durableCollection: PlainTerminalCollection | undefined;
}

export interface ReconcileTerminalSidebarSessionsResult {
  readonly rows: readonly TerminalSidebarSessionRow[];
  readonly incompleteFleet: boolean;
}

function listedIsManagerOwned(session: ListedTerminalSidebarSession): boolean {
  return session.lifecycleOwner === "manager";
}

function sessionFromDurableProjection(
  terminal: PlainTerminalProjection,
): CanonicalTerminalSessionInfo {
  const running =
    terminal.runtime.status === "running" ? terminal.runtime : null;
  return {
    sessionId: terminal.record.terminalId,
    scope: terminal.record.scope,
    sessionKind: "terminal",
    cwd: running?.currentCwd ?? terminal.record.launch.cwd,
    shellCommand: terminal.record.launch.shellCommand,
    shellArgs: [...terminal.record.launch.shellArgs],
    cols: running?.cols ?? DORMANT_GRID_COLS,
    rows: running?.rows ?? DORMANT_GRID_ROWS,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: Date.parse(terminal.record.createdAt),
    title: terminal.record.manualTitle,
    activeProcessName: running?.activeProcessName ?? null,
  };
}

function durableEpicTerminals(
  collection: PlainTerminalCollection | undefined,
  epicId: string,
  coverage: PlainTerminalListCoverage | null,
  servingHostId: string,
): readonly PlainTerminalProjection[] {
  const servingSliceHostId = collection?.servingHostId ?? servingHostId;
  return plainTerminalCollectionValues(collection).filter((terminal) => {
    if (terminal.record.scope.kind !== "epic") return false;
    if (terminal.record.scope.epicId !== epicId) return false;
    if (
      coverage === "partial-serving-host" &&
      terminal.record.hostId !== servingSliceHostId
    ) {
      return false;
    }
    return true;
  });
}

/**
 * One non-duplicated sidebar list from three classified authorities:
 * v2 durable fleet rows, manager-owned `terminal.list` rows on a capable
 * host, and the full `terminal.list` compatibility view on a genuinely
 * older connected host. Capability `unknown` is a no-row state.
 */
export function reconcileTerminalSidebarSessions(
  args: ReconcileTerminalSidebarSessionsArgs,
): ReconcileTerminalSidebarSessionsResult {
  if (args.capability === "unknown") {
    return { incompleteFleet: false, rows: [] };
  }
  const incompleteFleet =
    args.capability === "capable" &&
    args.topology === "fleet" &&
    args.coverage === "partial-serving-host";
  const listed = args.listed.filter((session) =>
    isVisibleEpicTerminalSession(session, args.epicId),
  );
  if (args.capability === "legacy") {
    return {
      incompleteFleet: false,
      rows: listed.map((session) => ({
        session,
        hostId: args.servingHostId,
        durable: false,
        runtimeStatus: "running" as const,
      })),
    };
  }

  const durable = durableEpicTerminals(
    args.durableCollection,
    args.epicId,
    args.coverage,
    args.servingHostId,
  );
  const durableIdentities = new Set(
    durable.map((terminal) =>
      plainTerminalCollectionIdentityKey(
        terminal.record.hostId,
        terminal.record.terminalId,
      ),
    ),
  );
  const deletedIdentities = new Set(
    Object.keys(args.durableCollection?.deletedRevisionByIdentity ?? {}),
  );
  const compatibility = listed.flatMap(
    (session): TerminalSidebarSessionRow[] => {
      const identityKey = plainTerminalCollectionIdentityKey(
        args.servingHostId,
        session.sessionId,
      );
      if (durableIdentities.has(identityKey)) return [];
      if (deletedIdentities.has(identityKey)) return [];
      if (
        getPlainTerminal(
          args.durableCollection,
          args.servingHostId,
          session.sessionId,
        ) !== undefined
      ) {
        return [];
      }
      if (!listedIsManagerOwned(session)) return [];
      return [
        {
          session,
          hostId: args.servingHostId,
          durable: false,
          runtimeStatus: "running",
        },
      ];
    },
  );
  return {
    incompleteFleet,
    rows: [
      ...compatibility,
      ...durable.map((terminal) => ({
        session: sessionFromDurableProjection(terminal),
        hostId: terminal.record.hostId,
        durable: true,
        runtimeStatus: terminal.runtime.status,
      })),
    ],
  };
}
