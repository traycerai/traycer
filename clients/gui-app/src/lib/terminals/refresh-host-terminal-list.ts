import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";

export type TerminalListSnapshot = ResponseOfMethod<
  HostRpcRegistry,
  "terminal.list"
>;

export type CreatedTerminalSession = ResponseOfMethod<
  HostRpcRegistry,
  "terminal.create"
>["session"];

function unavailableClientError(method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "Cannot create terminal without a host client.",
    requestId: "client-preflight",
    method,
    fatalDetails: null,
  });
}

export function exactTerminalListQueryKey(
  hostId: string,
  scope: TerminalScope,
): QueryKey {
  return hostQueryKeys.method<HostRpcRegistry, "terminal.list">(
    hostId,
    "terminal.list",
    { scope },
  );
}

/**
 * Direct `terminal.list` RPC. Must not touch QueryClient: a shared-cache
 * refetch can resolve after a failed request and leave retained rows that
 * look like a successful create.
 */
export async function fetchIsolatedTerminalList(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly scope: TerminalScope;
}): Promise<TerminalListSnapshot> {
  return withHostQueryErrorBoundary("terminal.list", () => {
    if (args.client === null) {
      return Promise.reject(unavailableClientError("terminal.list"));
    }
    return args.client.request("terminal.list", { scope: args.scope });
  });
}

export function terminalListSnapshotHasSession(
  snapshot: {
    readonly sessions: ReadonlyArray<{ readonly sessionId: string }>;
  },
  sessionId: string,
): boolean {
  return snapshot.sessions.some((session) => session.sessionId === sessionId);
}

export function publishExactTerminalListSnapshot(
  queryClient: QueryClient,
  hostId: string,
  scope: TerminalScope,
  snapshot: {
    readonly sessions: ReadonlyArray<{ readonly sessionId: string }>;
  },
): void {
  const queryKey = exactTerminalListQueryKey(hostId, scope);
  void queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData(queryKey, snapshot);
}

function withListSessionFields(
  session: CreatedTerminalSession,
  existing: TerminalListSnapshot["sessions"][number] | undefined,
): TerminalListSnapshot["sessions"][number] {
  return {
    ...(existing ?? {
      sessionId: session.sessionId,
      scope: session.scope,
      sessionKind: session.sessionKind,
      cwd: session.cwd,
      shellCommand: session.shellCommand,
      shellArgs: session.shellArgs,
      cols: session.cols,
      rows: session.rows,
      status: session.status,
      exitCode: session.exitCode,
      createdAt: session.createdAt,
      title: session.title,
      lifecycleOwner: "manager",
    }),
    ...session,
    currentCwd: existing?.currentCwd ?? session.cwd,
  };
}

/**
 * Upserts the authoritative `terminal.create` session into the exact
 * host/scope list cache. Preserves top-level list metadata such as `homeCwd`.
 */
export function upsertCreatedSessionIntoExactTerminalList(
  queryClient: QueryClient,
  hostId: string,
  scope: TerminalScope,
  session: CreatedTerminalSession,
): void {
  const queryKey = exactTerminalListQueryKey(hostId, scope);
  void queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData<TerminalListSnapshot>(queryKey, (current) => {
    const sessions = current?.sessions ?? [];
    const index = sessions.findIndex(
      (row) => row.sessionId === session.sessionId,
    );
    const nextSession = withListSessionFields(
      session,
      index === -1 ? undefined : sessions[index],
    );
    const nextSessions =
      index === -1
        ? [...sessions, nextSession]
        : sessions.map((row, rowIndex) =>
            rowIndex === index ? nextSession : row,
          );
    if (current === undefined) {
      return { sessions: nextSessions, homeCwd: null };
    }
    return { ...current, sessions: nextSessions };
  });
}
