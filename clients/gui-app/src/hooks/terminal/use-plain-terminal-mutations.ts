import {
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
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import type { PlainTerminalAuthorityResult } from "@/hooks/terminal/use-plain-terminal-authority";
import { toastFromHostError } from "@/lib/host-error-toast";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { terminalMutationKeys } from "@/lib/query-keys/terminal-mutation-keys";
import {
  adoptPlainTerminalUnary,
  capturePlainTerminalProjectionBarrier,
  type PlainTerminalCollection,
  type PlainTerminalProjectionBarrier,
} from "@/lib/terminals/plain-terminal-authority";
import { commitPlainTerminalDeletion } from "@/lib/terminals/plain-terminal-presentation-invalidation";

interface PlainTerminalMutationContext {
  readonly hostId: string;
  readonly scope: PlainTerminalScope;
  readonly barrier: PlainTerminalProjectionBarrier;
}

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
    EnsurePlainTerminalRunningRequest,
    PlainTerminalMutationContext
  >;
  readonly rename: UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, "terminal.plain.rename">,
    HostRpcError,
    RenamePlainTerminalRequest,
    PlainTerminalMutationContext
  >;
  readonly close: UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, "terminal.plain.close">,
    HostRpcError,
    ClosePlainTerminalRequest,
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
 * Shared host-authority mutations. Every lifecycle captures host + scope in
 * `onMutate`, so an active/default-host swap cannot redirect response writes.
 */
export function usePlainTerminalMutations(args: {
  readonly authority: PlainTerminalMutationAuthority;
  readonly client: HostClient<HostRpcRegistry> | null;
}): PlainTerminalMutations {
  const queryClient = useQueryClient();
  const context = (): PlainTerminalMutationContext => {
    const hostId = args.authority.hostId;
    const scope = args.authority.scope;
    return {
      hostId,
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
      onMutate: context,
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

  const ensureRunning = useHostMutation<
    HostRpcRegistry,
    "terminal.plain.ensureRunning",
    PlainTerminalMutationContext,
    EnsurePlainTerminalRunningRequest
  >({
    client: args.client,
    method: "terminal.plain.ensureRunning",
    mapVariables: (request) => {
      requireAuthority(request);
      if (
        args.authority.collection?.terminalsById[request.terminalId] ===
        undefined
      ) {
        throw new HostRpcError({
          code: "RPC_ERROR",
          requestId: "plain-terminal-not-found",
          method: "terminal.plain.ensureRunning",
          message:
            "Cannot bootstrap an unknown terminal. Create is only valid for a new logical terminal.",
          fatalDetails: null,
        });
      }
      return request;
    },
    options: {
      mutationKey: terminalMutationKeys.plainEnsureRunning(
        args.authority.hostId,
      ),
      onMutate: context,
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
    },
  });

  const rename = useHostMutation<
    HostRpcRegistry,
    "terminal.plain.rename",
    PlainTerminalMutationContext,
    RenamePlainTerminalRequest
  >({
    client: args.client,
    method: "terminal.plain.rename",
    mapVariables: requireAuthority,
    options: {
      mutationKey: terminalMutationKeys.plainRename(args.authority.hostId),
      onMutate: context,
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
    },
  });

  const close = useHostMutation<
    HostRpcRegistry,
    "terminal.plain.close",
    PlainTerminalMutationContext,
    ClosePlainTerminalRequest
  >({
    client: args.client,
    method: "terminal.plain.close",
    mapVariables: requireAuthority,
    options: {
      mutationKey: terminalMutationKeys.plainClose(args.authority.hostId),
      onMutate: context,
      onSuccess: (response, _request, captured) => {
        commitPlainTerminalDeletion({
          queryClient,
          queryKey: hostQueryKeys.plainTerminals(
            captured.hostId,
            captured.scope,
          ),
          hostId: captured.hostId,
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
    },
  });

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
      onMutate: context,
      onSuccess: (response, _request, captured) => {
        if (response.status === "deleted") {
          commitPlainTerminalDeletion({
            queryClient,
            queryKey: hostQueryKeys.plainTerminals(
              captured.hostId,
              captured.scope,
            ),
            hostId: captured.hostId,
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
  });
}

/** Explicit-host adapter for non-tab surfaces such as the epic sidebar. */
export function useHostPlainTerminalMutations(
  authority: PlainTerminalAuthorityResult,
): PlainTerminalMutations {
  return usePlainTerminalMutations({
    authority,
    client: useHostClientForHostId(authority.hostId),
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
