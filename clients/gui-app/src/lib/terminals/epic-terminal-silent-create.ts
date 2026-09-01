import type { QueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import type {
  CreatePlainTerminalRequest,
  PlainTerminalProjection,
  PlainTerminalScope,
} from "@traycer/protocol/host/terminal/plain-schemas";
import {
  adoptPlainTerminalUnary,
  capturePlainTerminalProjectionBarrier,
  type PlainTerminalCollection,
  type PlainTerminalProjectionBarrier,
} from "@/lib/terminals/plain-terminal-authority";
import {
  fetchIsolatedTerminalList,
  type CreatedTerminalSession,
} from "@/lib/terminals/refresh-host-terminal-list";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";

function unavailableClientError(method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "Cannot create terminal without a host client.",
    requestId: "client-preflight",
    method,
    fatalDetails: null,
  });
}

/**
 * Issues `terminal.plain.create` with no mutation cache write or toast.
 * The caller applies those effects only after the durable-create generation
 * fence accepts the attempt.
 */
export async function runSilentCapableEpicTerminalCreate(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly request: CreatePlainTerminalRequest;
}): Promise<PlainTerminalProjection> {
  const response = await withHostQueryErrorBoundary(
    "terminal.plain.create",
    () => {
      if (args.client === null) {
        return Promise.reject(unavailableClientError("terminal.plain.create"));
      }
      return args.client.request("terminal.plain.create", args.request);
    },
  );
  return response.terminal;
}

/**
 * Issues `terminal.create` with no list refresh, cache write, or toast.
 * The returned session is the ordinary-success authority; lost-response
 * discovery belongs in the coordinator's generation-fenced `commit`.
 */
export async function runSilentLegacyEpicTerminalCreate(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly request: RequestOfMethod<HostRpcRegistry, "terminal.create">;
}): Promise<CreatedTerminalSession> {
  const response: ResponseOfMethod<HostRpcRegistry, "terminal.create"> =
    await withHostQueryErrorBoundary("terminal.create", () => {
      if (args.client === null) {
        return Promise.reject(unavailableClientError("terminal.create"));
      }
      return args.client.request("terminal.create", args.request);
    });
  return response.session;
}

/**
 * Isolated `terminal.list` for uncertain/lost create responses. Does not
 * read or write shared QueryClient state.
 */
export async function fetchIsolatedLegacyTerminalList(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly scope: TerminalScope;
}): Promise<ResponseOfMethod<HostRpcRegistry, "terminal.list">> {
  return fetchIsolatedTerminalList(args);
}

export function captureCreatedPlainTerminalBarrier(
  queryClient: QueryClient,
  hostId: string,
  scope: PlainTerminalScope,
): PlainTerminalProjectionBarrier {
  return capturePlainTerminalProjectionBarrier(
    queryClient.getQueryData<PlainTerminalCollection>(
      hostQueryKeys.plainTerminals(hostId, scope),
    ),
  );
}

export function writeCreatedPlainTerminalCollection(
  queryClient: QueryClient,
  args: {
    readonly hostId: string;
    readonly scope: PlainTerminalScope;
    readonly terminal: PlainTerminalProjection;
    readonly barrier: PlainTerminalProjectionBarrier;
  },
): void {
  queryClient.setQueryData<PlainTerminalCollection>(
    hostQueryKeys.plainTerminals(args.hostId, args.scope),
    (current) => adoptPlainTerminalUnary(current, args.terminal, args.barrier),
  );
}
