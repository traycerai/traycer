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

/** Bound-host terminal.list row. Session ids are per host. null while the host has no row. */
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

/** Live display title for a terminal session: the host's explicit title, else the live directory plus active process/default. */
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
