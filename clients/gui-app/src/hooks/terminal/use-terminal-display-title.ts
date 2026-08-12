import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  CanonicalTerminalSessionInfoWithCurrentCwd,
  TerminalScope,
} from "@traycer/protocol/host/terminal/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useTerminalListFor } from "@/hooks/terminal/use-terminal-list-for-query";
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";

/** The identity a caller has for a terminal it is rendering. */
export interface TerminalSessionIdentity {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string | null;
  readonly sessionId: string | null;
}

/**
 * The HOST's `terminal.list` row for an epic-scoped session - the single
 * source of truth for everything about a live terminal that the session store
 * does not carry (title, directories, foreground process).
 *
 * `client` is the session's BOUND-host client (session ids are only unique
 * per host, and a tab's bound host may not be the app-wide default host).
 * The caller resolves it once - e.g. `TabItem` shares one
 * `useHostClientForHostId(tab.hostId)` between this hook and the rename
 * mutation - so reading the row adds no extra directory subscription.
 *
 * Mounting this hook keeps a query observer on that host, so a backgrounded
 * tab whose tile (and PTY stream) is unmounted still tracks renames and
 * process changes; the stream metadata subscription in
 * `terminal-session-registry.ts` patches the same cached rows in place while
 * a tile is live.
 *
 * Returns `null` while the host has no row for the session (host restarted /
 * unreachable, list not yet hydrated). Callers rendering a non-terminal node
 * pass all-null identity; the hook is then inert (no query).
 */
export function useTerminalFindSessionRow(
  args: TerminalSessionIdentity,
): CanonicalTerminalSessionInfoWithCurrentCwd | null {
  const enabled =
    args.client !== null && args.epicId !== null && args.sessionId !== null;
  const epicId = args.epicId;
  // `epicId` is only null while the hook is disabled (the list client below
  // is gated to null), so the empty placeholder never reaches a live query.
  const scope = useMemo<TerminalScope>(
    () => ({ kind: "epic", epicId: epicId ?? "" }),
    [epicId],
  );
  const list = useTerminalListFor(enabled ? args.client : null, scope);
  if (!enabled) return null;
  return (
    list.data?.sessions.find((s) => s.sessionId === args.sessionId) ?? null
  );
}

/**
 * Live display title for a terminal session: the host's explicit title, else
 * the live directory plus active process/default. `null` while there is no
 * row yet - the caller then falls back to the persisted tile-name snapshot.
 */
export function useTerminalDisplayTitle(
  args: TerminalSessionIdentity,
): string | null {
  const session = useTerminalFindSessionRow(args);
  if (session === null) return null;
  return terminalSessionTitle({
    title: session.title,
    activeProcessName: session.activeProcessName,
    currentCwd: session.currentCwd,
  });
}
