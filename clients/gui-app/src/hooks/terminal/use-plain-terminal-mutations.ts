import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  ClosePlainTerminalRequest,
  CreatePlainTerminalRequest,
  EnsurePlainTerminalRunningRequest,
  ImportLegacyPlainTerminalRequest,
  PlainTerminalScope,
  RenamePlainTerminalRequest,
} from "@traycer/protocol/host/terminal/plain-schemas";
import {
  useHostMutation,
  withHostMutationLifecycleBoundary,
} from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import type { PlainTerminalAuthorityResult } from "@/hooks/terminal/use-plain-terminal-authority";
import { toastFromHostError } from "@/lib/host-error-toast";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { terminalMutationKeys } from "@/lib/query-keys/terminal-mutation-keys";
import {
  adoptPlainTerminalUnary,
  capturePlainTerminalProjectionBarrier,
  getPlainTerminal,
  type PlainTerminalCollection,
  type PlainTerminalProjectionBarrier,
} from "@/lib/terminals/plain-terminal-authority";
import { commitPlainTerminalDeletion } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import { useResolvePlainTerminalOwnerHostClient } from "@/lib/terminals/resolve-plain-terminal-owner-client";

interface PlainTerminalMutationContext {
  readonly hostId: string;
  readonly ownerHostId: string;
  readonly scope: PlainTerminalScope;
  readonly barrier: PlainTerminalProjectionBarrier;
}

export type OwnerHostEnsureRunningRequest =
  EnsurePlainTerminalRunningRequest & {
    readonly hostId: string;
  };

export type OwnerHostRenameRequest = RenamePlainTerminalRequest & {
  readonly hostId: string;
};

export type OwnerHostCloseRequest = ClosePlainTerminalRequest & {
  readonly hostId: string;
};

export interface PlainTerminalMutations {
  readonly create: UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, "terminal.plain.create">,
    HostRpcError,
    CreatePlainTerminalRequest,
    PlainTerminalMutationContext
  >;
  readonly ensureRunning: UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, "terminal.plain.ensureRunning">,
    HostRpcError,
    OwnerHostEnsureRunningRequest,
    PlainTerminalMutationContext
  >;
  readonly rename: UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, "terminal.plain.rename">,
    HostRpcError,
    OwnerHostRenameRequest,
    PlainTerminalMutationContext
  >;
  readonly close: UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, "terminal.plain.close">,
    HostRpcError,
    OwnerHostCloseRequest,
    PlainTerminalMutationContext
  >;
  readonly importLegacy: UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, "terminal.plain.importLegacy">,
    HostRpcError,
    ImportLegacyPlainTerminalRequest,
    PlainTerminalMutationContext
  >;
}

export interface PlainTerminalMutationAuthority {
  readonly hostId: string;
  readonly scope: PlainTerminalScope;
  readonly canMutate: boolean;
  readonly collection: PlainTerminalCollection | undefined;
}

/**
 * Shared host-authority mutations. Collection writes stay on the serving-host
 * cache slot captured at mutate start. Owner-host RPCs resolve through the
 * authenticated directory and never fall back to the serving host.
 */
export function usePlainTerminalMutations(args: {
  readonly authority: PlainTerminalMutationAuthority;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly resolveOwnerClient: (
    hostId: string,
  ) => HostClient<HostRpcRegistry> | null;
}): PlainTerminalMutations {
  const queryClient = useQueryClient();
  const servingContext = (
    ownerHostId: string,
  ): PlainTerminalMutationContext => {
    const hostId = args.authority.hostId;
    const scope = args.authority.scope;
    return {
      hostId,
      ownerHostId,
      scope,
      barrier: capturePlainTerminalProjectionBarrier(
        queryClient.getQueryData<PlainTerminalCollection>(
          hostQueryKeys.plainTerminals(hostId, scope),
        ),
      ),
    };
  };
  const requireAuthority = <Request>(request: Request): Request => {
    if (!args.authority.canMutate) {
      throw unavailableAuthorityError();
    }
    return request;
  };
  const requireOwnerRow = (
    method: string,
    hostId: string,
    terminalId: string,
  ): void => {
    requireAuthority(undefined);
    if (
      getPlainTerminal(args.authority.collection, hostId, terminalId) ===
      undefined
    ) {
      throw missingFleetRowError(method, terminalId);
    }
  };
  const ownerClientOrThrow = (
    hostId: string,
    method: string,
  ): HostClient<HostRpcRegistry> => {
    const client = args.resolveOwnerClient(hostId);
    if (client === null) {
      throw unavailableOwnerError(method);
    }
    return client;
  };

  const create = useHostMutation<
    HostRpcRegistry,
    "terminal.plain.create",
    PlainTerminalMutationContext,
    CreatePlainTerminalRequest
  >({
    client: args.client,
    method: "terminal.plain.create",
    mapVariables: requireAuthority,
    options: {
      mutationKey: terminalMutationKeys.plainCreate(args.authority.hostId),
      onMutate: () => servingContext(args.authority.hostId),
      onSuccess: (response, _request, captured) => {
        writeCanonicalTerminal(queryClient, {
          hostId: captured.hostId,
          scope: captured.scope,
          terminal: response.terminal,
          barrier: captured.barrier,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't create the terminal."),
    },
  });

  const ensureRunning = useMutation<
    ResponseOfMethod<HostRpcRegistry, "terminal.plain.ensureRunning">,
    HostRpcError,
    OwnerHostEnsureRunningRequest,
    PlainTerminalMutationContext
  >(
    withHostMutationLifecycleBoundary("terminal.plain.ensureRunning", {
      mutationKey: terminalMutationKeys.plainEnsureRunning(
        args.authority.hostId,
      ),
      mutationFn: (request) =>
        withHostQueryErrorBoundary("terminal.plain.ensureRunning", () => {
          requireOwnerRow(
            "terminal.plain.ensureRunning",
            request.hostId,
            request.terminalId,
          );
          const client = ownerClientOrThrow(
            request.hostId,
            "terminal.plain.ensureRunning",
          );
          return client.request("terminal.plain.ensureRunning", {
            terminalId: request.terminalId,
            cols: request.cols,
            rows: request.rows,
          });
        }),
      onMutate: (request) => servingContext(request.hostId),
      onSuccess: (response, _request, captured) => {
        writeCanonicalTerminal(queryClient, {
          hostId: captured.hostId,
          scope: captured.scope,
          terminal: response.terminal,
          barrier: captured.barrier,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't start the terminal."),
    }),
  );

  const rename = useMutation<
    ResponseOfMethod<HostRpcRegistry, "terminal.plain.rename">,
    HostRpcError,
    OwnerHostRenameRequest,
    PlainTerminalMutationContext
  >(
    withHostMutationLifecycleBoundary("terminal.plain.rename", {
      mutationKey: terminalMutationKeys.plainRename(args.authority.hostId),
      mutationFn: (request) =>
        withHostQueryErrorBoundary("terminal.plain.rename", () => {
          requireOwnerRow(
            "terminal.plain.rename",
            request.hostId,
            request.terminalId,
          );
          const client = ownerClientOrThrow(
            request.hostId,
            "terminal.plain.rename",
          );
          return client.request("terminal.plain.rename", {
            terminalId: request.terminalId,
            manualTitle: request.manualTitle,
          });
        }),
      onMutate: (request) => servingContext(request.hostId),
      onSuccess: (response, _request, captured) => {
        writeCanonicalTerminal(queryClient, {
          hostId: captured.hostId,
          scope: captured.scope,
          terminal: response.terminal,
          barrier: captured.barrier,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't rename the terminal."),
    }),
  );

  const close = useMutation<
    ResponseOfMethod<HostRpcRegistry, "terminal.plain.close">,
    HostRpcError,
    OwnerHostCloseRequest,
    PlainTerminalMutationContext
  >(
    withHostMutationLifecycleBoundary("terminal.plain.close", {
      mutationKey: terminalMutationKeys.plainClose(args.authority.hostId),
      mutationFn: (request) =>
        withHostQueryErrorBoundary("terminal.plain.close", () => {
          requireOwnerRow(
            "terminal.plain.close",
            request.hostId,
            request.terminalId,
          );
          const client = ownerClientOrThrow(
            request.hostId,
            "terminal.plain.close",
          );
          return client.request("terminal.plain.close", {
            terminalId: request.terminalId,
          });
        }),
      onMutate: (request) => servingContext(request.hostId),
      onSuccess: (response, _request, captured) => {
        commitPlainTerminalDeletion({
          queryClient,
          queryKey: hostQueryKeys.plainTerminals(
            captured.hostId,
            captured.scope,
          ),
          hostId: captured.ownerHostId,
          terminalId: response.terminalId,
          evidence: {
            kind: "unary",
            revision: response.revision,
            barrier: captured.barrier,
          },
          deferPresentation: false,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't close the terminal."),
    }),
  );

  const importLegacy = useHostMutation<
    HostRpcRegistry,
    "terminal.plain.importLegacy",
    PlainTerminalMutationContext,
    ImportLegacyPlainTerminalRequest
  >({
    client: args.client,
    method: "terminal.plain.importLegacy",
    mapVariables: requireAuthority,
    options: {
      mutationKey: terminalMutationKeys.plainImportLegacy(
        args.authority.hostId,
      ),
      onMutate: (request) => servingContext(request.hostId),
      onSuccess: (response, _request, captured) => {
        if (response.status === "deleted") {
          commitPlainTerminalDeletion({
            queryClient,
            queryKey: hostQueryKeys.plainTerminals(
              captured.hostId,
              captured.scope,
            ),
            hostId: captured.ownerHostId,
            terminalId: response.terminalId,
            evidence: {
              kind: "unary",
              revision: response.revision,
              barrier: captured.barrier,
            },
            deferPresentation: false,
          });
          return;
        }
        writeCanonicalTerminal(queryClient, {
          hostId: captured.hostId,
          scope: captured.scope,
          terminal: response.terminal,
          barrier: captured.barrier,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't import the legacy terminal."),
    },
  });

  return { create, ensureRunning, rename, close, importLegacy };
}

export function useTabPlainTerminalMutations(
  authority: PlainTerminalAuthorityResult,
): PlainTerminalMutations {
  return usePlainTerminalMutations({
    authority,
    client: useTabHostClient(),
    resolveOwnerClient: useResolvePlainTerminalOwnerHostClient(),
  });
}

/** Explicit-host adapter for non-tab surfaces such as the epic sidebar. */
export function useHostPlainTerminalMutations(
  authority: PlainTerminalAuthorityResult,
): PlainTerminalMutations {
  return usePlainTerminalMutations({
    authority,
    client: useHostClientForHostId(authority.hostId),
    resolveOwnerClient: useResolvePlainTerminalOwnerHostClient(),
  });
}

/**
 * The scope must be the one `onMutate` captured, because the barrier was
 * captured from that cache slot. Writing a response scope instead would apply
 * an ordering barrier belonging to a different slot and lose the guarantee for
 * both. The deletion paths capture the same way.
 */
function writeCanonicalTerminal(
  queryClient: QueryClient,
  args: {
    readonly hostId: string;
    readonly scope: PlainTerminalScope;
    readonly terminal: ResponseOfMethod<
      HostRpcRegistry,
      "terminal.plain.rename"
    >["terminal"];
    readonly barrier: PlainTerminalProjectionBarrier;
  },
): void {
  queryClient.setQueryData<PlainTerminalCollection>(
    hostQueryKeys.plainTerminals(args.hostId, args.scope),
    (current) => adoptPlainTerminalUnary(current, args.terminal, args.barrier),
  );
}

function unavailableAuthorityError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    requestId: "plain-terminal-authority-stale",
    method: "terminal.plain",
    message:
      "Terminal host authority is unavailable. Cached data is view-only until a fresh host snapshot arrives.",
    fatalDetails: null,
  });
}

function missingFleetRowError(
  method: string,
  terminalId: string,
): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    requestId: "plain-terminal-not-found",
    method,
    message:
      method === "terminal.plain.ensureRunning"
        ? "Cannot bootstrap an unknown terminal. Create is only valid for a new logical terminal."
        : `Cannot mutate terminal ${terminalId}; it is not in the current fleet authority.`,
    fatalDetails: null,
  });
}

function unavailableOwnerError(method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    requestId: "plain-terminal-owner-unreachable",
    method,
    message:
      "The terminal's owner host is unreachable. The request was not sent.",
    fatalDetails: null,
  });
}
