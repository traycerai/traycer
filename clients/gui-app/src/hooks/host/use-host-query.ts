import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  toHostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  HOST_METHOD_POLL_TABLE,
  stampHostRpcMethod,
} from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  getConditionPollEpisodeCoordinator,
  type ConditionPollRefetchInterval,
} from "@/lib/query/condition-poll-episode-coordinator";

type ConditionHostRpcMethod = {
  [
    Method in keyof typeof HOST_METHOD_POLL_TABLE
  ]: (typeof HOST_METHOD_POLL_TABLE)[Method]["poll"] extends {
    readonly kind: "condition";
  }
    ? Method
    : never;
}[keyof typeof HOST_METHOD_POLL_TABLE];

type BaseHostQueryTanstackOptions<TData> = Omit<
  UseQueryOptions<TData, HostRpcError, TData>,
  "queryKey" | "queryFn" | "refetchInterval"
> & {
  /**
   * Condition queries participate in table-owned polling by default. Fixed
   * queries opt in to their table-owned cadence with `poll: true`.
   */
  readonly poll?: boolean;
};

export type HostQueryTanstackOptions<
  Method extends keyof HostRpcRegistry & string,
  TData,
> = Method extends ConditionHostRpcMethod
  ? Omit<BaseHostQueryTanstackOptions<TData>, "retry">
  : BaseHostQueryTanstackOptions<TData>;

export interface UseHostQueryWithResponseMapOptions<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
  TData,
> {
  readonly client: HostRequester<Registry> | null;
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
  readonly options: HostQueryTanstackOptions<Method, TData> | null;
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
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
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
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
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
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
  TData,
>(
  args: UseHostQueryWithResponseMapOptions<Registry, Method, TData>,
): UseQueryResult<TData, HostRpcError> {
  const { client, method, params, mapResponse } = args;
  const queryClient = useQueryClient();
  const conditionPollCoordinator =
    getConditionPollEpisodeCoordinator(queryClient);
  const readiness = useReactiveHostReadiness(client);
  const baseOptions = args.options ?? {};
  const { meta, poll, select, ...queryOptionsWithoutReservedFields } =
    baseOptions;
  const pollPolicy = HOST_METHOD_POLL_TABLE[method].poll;
  let tablePollingOptions:
    | {
        readonly refetchInterval: ConditionPollRefetchInterval | false;
        readonly retry: false;
      }
    | {
        readonly refetchInterval: number | false;
        readonly refetchIntervalInBackground: false;
      }
    | Record<never, never> = {};
  if (pollPolicy !== null && pollPolicy.kind === "condition") {
    tablePollingOptions = {
      refetchInterval:
        poll === false
          ? false
          : conditionPollCoordinator.refetchIntervalFor(method),
      retry: false,
    };
  } else if (pollPolicy !== null) {
    tablePollingOptions = {
      refetchInterval: poll === true ? pollPolicy.intervalMs : false,
      refetchIntervalInBackground: false,
    };
  }
  const queryKey: QueryKey = [
    ...queryKeys.hostMethod<Registry, Method>(readiness.hostId, method, params),
    ...(args.cacheKeyIdentity ?? []),
  ];

  // The boundary normalizes every non-control-flow failure into the declared
  // `HostRpcError`, including throws from caller-supplied `mapResponse`.
  // Coordinator control flow deliberately remains TanStack cancellation.
  const request = ({ signal }: QueryFunctionContext): Promise<TData> =>
    withHostQueryErrorBoundary(method, async () => {
      if (client === null) {
        return Promise.reject<TData>(hostClientUnavailableError(method));
      }
      const response = await client.requestWithSignal(method, params, signal);
      return mapResponse({ response, queryClient, queryKey });
    });

  return useQuery<TData, HostRpcError, TData>(
    queryOptions<TData, HostRpcError, TData>({
      ...queryOptionsWithoutReservedFields,
      ...tablePollingOptions,
      // A throw inside a caller-supplied `select` is stored by the observer
      // as `result.error` - the same `HostRpcError`-typed channel the queryFn
      // boundary protects - so it must be normalized too.
      select:
        select === undefined
          ? undefined
          : (data) => {
              try {
                return select(data);
              } catch (error) {
                throw toHostRpcError(error, method);
              }
            },
      queryKey,
      queryFn: request,
      // The builder's stamp is an identity input to the coordinator. It must
      // be written after caller meta so no observer can replace the method.
      meta: stampHostRpcMethod(meta, method),
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
  readonly client: HostRequester<Registry> | null;
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
    ...withHostMutationLifecycleBoundary(args.method, baseOptions),
    // Boundary-wrapped so a throw inside the caller-supplied `mapVariables`
    // (pre-flight validation) surfaces as the declared `HostRpcError`.
    mutationFn: (variables) =>
      withHostQueryErrorBoundary(args.method, () => {
        if (args.client === null) {
          return Promise.reject<ResponseOfMethod<Registry, Method>>(
            hostClientUnavailableError(args.method),
          );
        }
        return args.client.request(args.method, args.mapVariables(variables));
      }),
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
    ...withHostMutationLifecycleBoundary(args.method, baseOptions),
    mutationFn: (variables) =>
      withHostQueryErrorBoundary(args.method, () => {
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
      }),
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

/**
 * Wraps a mutation's lifecycle callbacks (`onMutate` / `onSuccess` /
 * `onSettled`) so a throw inside them is normalized to `HostRpcError`.
 * TanStack stores a lifecycle throw in `mutation.state.error`, hands it to
 * `onError`, and rejects `mutateAsync` with it - all surfaces the declared
 * `HostRpcError` generic covers but the mutationFn boundary cannot reach.
 * TanStack awaits every mutation lifecycle callback, so the async wrappers
 * do not change observable ordering. Used by `useHostMutation` and by the
 * bespoke `useMutation` producers that declare a `HostRpcError` generic.
 */
export function withHostMutationLifecycleBoundary<TData, TVariables, TContext>(
  method: string,
  options: UseMutationOptions<TData, HostRpcError, TVariables, TContext>,
): UseMutationOptions<TData, HostRpcError, TVariables, TContext> {
  const { onMutate, onSuccess, onSettled } = options;
  return {
    ...options,
    onMutate:
      onMutate === undefined
        ? undefined
        : async (...args) => {
            try {
              return await onMutate(...args);
            } catch (error) {
              throw toHostRpcError(error, method);
            }
          },
    onSuccess:
      onSuccess === undefined
        ? undefined
        : async (...args) => {
            try {
              return await onSuccess(...args);
            } catch (error) {
              throw toHostRpcError(error, method);
            }
          },
    onSettled:
      onSettled === undefined
        ? undefined
        : async (...args) => {
            try {
              return await onSettled(...args);
            } catch (error) {
              throw toHostRpcError(error, method);
            }
          },
  };
}
