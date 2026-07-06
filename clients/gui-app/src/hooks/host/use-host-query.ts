import {
  queryOptions,
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { queryKeys } from "@/lib/query-keys";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";

export interface UseHostQueryOptions<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> {
  readonly client: HostClient<Registry> | null;
  readonly method: Method;
  readonly params: RequestOfMethod<Registry, Method>;
  /**
   * Extra cache identity that is not sent to the host. Use this when the RPC
   * request addresses a stable resource id but the cached representation must
   * vary by a newer content identity, such as a blob hash or revision.
   */
  readonly cacheKeyIdentity?: ReadonlyArray<unknown>;
  /**
   * Pass-through TanStack options (`enabled`, `staleTime`, etc.). Query key
   * and queryFn are owned by this hook so the invalidation contract holds.
   */
  readonly options: Omit<
    UseQueryOptions<
      ResponseOfMethod<Registry, Method>,
      HostRpcError,
      ResponseOfMethod<Registry, Method>
    >,
    "queryKey" | "queryFn"
  > | null;
}

/**
 * Thin typed wrapper over TanStack `useQuery`.
 *
 * Emits a request through the bound `HostClient` every time the active
 * host id changes - `["host", hostId, method, params]` is what
 * `HostClient` invalidates, so the query refetches automatically when the
 * client announces a host/auth/availability transition. When no client is
 * bound (or readiness has not yet settled) the query is disabled to avoid a
 * `HostRpcError` blast.
 */
export function useHostQuery<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
>(
  args: UseHostQueryOptions<Registry, Method>,
): UseQueryResult<ResponseOfMethod<Registry, Method>, HostRpcError> {
  const { client, method, params } = args;
  const readiness = useReactiveHostReadiness(client);
  const enabledFromOptions =
    args.options === null || args.options.enabled === undefined
      ? true
      : Boolean(args.options.enabled);
  const baseOptions = args.options ?? {};

  const request = (): Promise<ResponseOfMethod<Registry, Method>> => {
    if (client === null) {
      return Promise.reject<ResponseOfMethod<Registry, Method>>(
        hostClientUnavailableError(method),
      );
    }
    return client.request(method, params);
  };

  return useQuery<
    ResponseOfMethod<Registry, Method>,
    HostRpcError,
    ResponseOfMethod<Registry, Method>
  >(
    hostQueryOptions<Registry, Method>({
      hostId: readiness.hostId,
      method,
      params,
      request,
      cacheKeyIdentity: args.cacheKeyIdentity ?? [],
      enabled: enabledFromOptions && client !== null && readiness.isReady,
      baseOptions,
    }),
  );
}

export interface UseHostMutationOptions<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
  TContext = unknown,
  TVariables = RequestOfMethod<Registry, Method>,
> {
  readonly client: HostClient<Registry> | null;
  readonly method: Method;
  readonly options: Omit<
    UseMutationOptions<
      ResponseOfMethod<Registry, Method>,
      HostRpcError,
      TVariables,
      TContext
    >,
    "mutationFn"
  > | null;
  readonly mapVariables: (
    variables: TVariables,
  ) => RequestOfMethod<Registry, Method>;
}

/**
 * Thin typed wrapper over TanStack `useMutation` that dispatches the
 * caller's params straight into `HostClient.request`.
 */
export function useHostMutation<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
  TContext = unknown,
  TVariables = RequestOfMethod<Registry, Method>,
>(
  args: UseHostMutationOptions<Registry, Method, TContext, TVariables>,
): UseMutationResult<
  ResponseOfMethod<Registry, Method>,
  HostRpcError,
  TVariables,
  TContext
> {
  const baseOptions = args.options ?? {};
  return useMutation<
    ResponseOfMethod<Registry, Method>,
    HostRpcError,
    TVariables,
    TContext
  >({
    ...baseOptions,
    mutationFn: (variables) => {
      if (args.client === null) {
        return Promise.reject<ResponseOfMethod<Registry, Method>>(
          hostClientUnavailableError(args.method),
        );
      }
      return args.client.request(args.method, args.mapVariables(variables));
    },
  });
}

export function hostClientUnavailableError(method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    requestId: "client-unavailable",
    method,
    message: "Host client unavailable",
    fatalDetails: null,
  });
}

interface HostQueryOptionsArgs<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> {
  readonly hostId: string | null;
  readonly method: Method;
  readonly params: RequestOfMethod<Registry, Method>;
  readonly request: () => Promise<ResponseOfMethod<Registry, Method>>;
  readonly cacheKeyIdentity: ReadonlyArray<unknown>;
  readonly enabled: boolean;
  readonly baseOptions: Omit<
    UseQueryOptions<
      ResponseOfMethod<Registry, Method>,
      HostRpcError,
      ResponseOfMethod<Registry, Method>
    >,
    "queryKey" | "queryFn"
  >;
}

function hostQueryOptions<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
>(args: HostQueryOptionsArgs<Registry, Method>) {
  const {
    hostId,
    method,
    params,
    request,
    cacheKeyIdentity,
    enabled,
    baseOptions,
  } = args;
  return queryOptions<
    ResponseOfMethod<Registry, Method>,
    HostRpcError,
    ResponseOfMethod<Registry, Method>
  >({
    ...baseOptions,
    queryKey: [
      ...queryKeys.hostMethod<Registry, Method>(hostId, method, params),
      ...cacheKeyIdentity,
    ],
    queryFn: request,
    enabled: enabled && hostId !== null,
  });
}
