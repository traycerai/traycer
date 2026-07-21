import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useTerminalListFor } from "@/hooks/terminal/use-terminal-list-for-query";
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";

/**
 * Live display title for an epic-scoped terminal session, resolved from the
 * HOST's `terminal.list` rows - the single source of truth for terminal
 * titles (explicit `session.title`, else the active process name).
 *
 * `client` is the session's BOUND-host client (session ids are only unique
 * per host, and a tab's bound host may not be the app-wide default host).
 * The caller resolves it once - e.g. `TabItem` shares one
 * `useHostClientForHostId(tab.hostId)` between this hook and the rename
 * mutation - so title resolution adds no extra directory subscription.
 *
 * Mounting this hook keeps a query observer on that host, so a backgrounded
 * tab whose tile (and PTY stream) is unmounted still tracks renames and
 * process changes; the stream metadata subscription in
 * `terminal-session-registry.ts` patches the same cached rows in place while
 * a tile is live.
 *
 * Returns `null` while the host has no row for the session (host restarted /
 * unreachable, list not yet hydrated) - the caller then falls back to the
 * persisted tile-name snapshot. Callers rendering a non-terminal node pass
 * all-null identity; the hook is then inert (no query).
 */
export function useTerminalDisplayTitle(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string | null;
  readonly sessionId: string | null;
}): string | null {
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
  const session =
    list.data?.sessions.find((s) => s.sessionId === args.sessionId) ?? null;
  if (session === null) return null;
  return terminalSessionTitle({
    title: session.title,
    activeProcessName: session.activeProcessName,
  });
}
