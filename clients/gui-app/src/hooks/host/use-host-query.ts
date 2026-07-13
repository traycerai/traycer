import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
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

export interface UseHostQueryWithResponseMapOptions<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
  TData,
> {
  readonly client: HostClient<Registry> | null;
  readonly method: Method;
  readonly params: RequestOfMethod<Registry, Method>;
  /**
   * Extra cache identity that is not sent to the host. Use this when the RPC
   * request addresses a stable resource id but the cached representation must
   * vary by a newer content identity, such as a blob hash or revision.
   */
  readonly cacheKeyIdentity: ReadonlyArray<unknown> | undefined;
  /**
   * Pass-through TanStack options (`enabled`, `staleTime`, etc.). Query key
   * and queryFn are owned by this hook so the invalidation contract holds.
   */
  readonly options: Omit<
    UseQueryOptions<TData, HostRpcError, TData>,
    "queryKey" | "queryFn"
  > | null;
  /**
   * Transforms the raw RPC response into what TanStack caches/returns for
   * this query. Runs inside the queryFn, so its return value - not the raw
   * response - is what ends up in the cache. `queryClient`/`queryKey` are
   * handed in (the exact key this hook computed for this call) so a caller
   * can fold the fresh response into an accumulator that also reads this
   * same slot's previous value via `queryClient.getQueryData(queryKey)` -
   * e.g. the `host.getRateLimitUsage` provider-pull envelope
   * (`mapResponseToProviderRateLimitEnvelope`), which needs every lane that
   * writes that key family to agree on the cached shape. `useHostQuery` is
   * this function with `mapResponse` fixed to the identity; reach for this
   * only when the cached shape must differ from the raw wire response.
   */
  readonly mapResponse: (args: {
    readonly response: ResponseOfMethod<Registry, Method>;
    readonly queryClient: QueryClient;
    readonly queryKey: QueryKey;
  }) => TData;
}

/**
 * `useHostQuery`'s options, derived from `UseHostQueryWithResponseMapOptions`
 * (dropping `mapResponse`, which `useHostQuery` fixes to the identity) so the
 * two option shapes can't drift out of sync.
 */
export type UseHostQueryOptions<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> = Omit<
  UseHostQueryWithResponseMapOptions<
    Registry,
    Method,
    ResponseOfMethod<Registry, Method>
  >,
  "mapResponse"
>;

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
  return useHostQueryWithResponseMap<
    Registry,
    Method,
    ResponseOfMethod<Registry, Method>
  >({
    ...args,
    mapResponse: (mapArgs) => mapArgs.response,
  });
}

/**
 * `useHostQuery` generalized with a caller-supplied response-to-cache
 * transform. See `UseHostQueryWithResponseMapOptions.mapResponse` for why
 * this exists instead of a plain `select` (which never persists back into
 * the shared cache entry other observers of the same key read).
 */
export function useHostQueryWithResponseMap<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
  TData,
>(
  args: UseHostQueryWithResponseMapOptions<Registry, Method, TData>,
): UseQueryResult<TData, HostRpcError> {
  const { client, method, params, mapResponse } = args;
  const queryClient = useQueryClient();
  const readiness = useReactiveHostReadiness(client);
  const baseOptions = args.options ?? {};
  const queryKey: QueryKey = [
    ...queryKeys.hostMethod<Registry, Method>(readiness.hostId, method, params),
    ...(args.cacheKeyIdentity ?? []),
  ];

  const request = async (): Promise<TData> => {
    if (client === null) {
      return Promise.reject<TData>(hostClientUnavailableError(method));
    }
    const response = await client.request(method, params);
    return mapResponse({ response, queryClient, queryKey });
  };

  return useQuery<TData, HostRpcError, TData>(
    queryOptions<TData, HostRpcError, TData>({
      ...baseOptions,
      queryKey,
      queryFn: request,
      // A function-form `enabled` must still be evaluated per-query - not
      // collapsed to a boolean up front - or a caller's dynamic condition is
      // silently replaced by "always true" the moment a client is bound.
      enabled: (query) => {
        if (client === null || !readiness.isReady) return false;
        const callerEnabled = args.options?.enabled;
        return typeof callerEnabled === "function"
          ? callerEnabled(query)
          : (callerEnabled ?? true);
      },
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

/**
 * `useHostMutation` for long-poll methods whose response is contractually
 * silent until a domain event fires (e.g. `providers.awaitLogin` blocks until
 * the OAuth child terminates): the request runs with the caller's extended
 * response-frame budget instead of the transport's default frame timeout,
 * which would misread that silence as a dead host. Dial and handshake keep
 * the transport defaults, so an unreachable host still fails fast.
 */
export function useHostMutationWithResponseTimeout<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
  TContext = unknown,
  TVariables = RequestOfMethod<Registry, Method>,
>(
  args: UseHostMutationOptions<Registry, Method, TContext, TVariables> & {
    readonly responseTimeoutMs: number;
  },
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
      return args.client.requestWithResponseTimeout(
        args.method,
        args.mapVariables(variables),
        args.responseTimeoutMs,
      );
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
