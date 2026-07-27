import {
  queryOptions,
  useQueries,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import {
  toHostRpcError,
  type HostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import {
  hostClientUnavailableError,
  type HostQueryTanstackOptions,
} from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  HOST_METHOD_POLL_TABLE,
  stampHostRpcMethod,
} from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  getConditionPollEpisodeCoordinator,
  type ConditionPollRefetchInterval,
} from "@/lib/query/condition-poll-episode-coordinator";

export interface HostRequestSpec<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
> {
  readonly method: Method;
  readonly params: RequestOfMethod<Registry, Method>;
}

export interface UseHostQueriesOptions<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
> {
  readonly client: HostRequester<Registry> | null;
  readonly requests: ReadonlyArray<HostRequestSpec<Registry, Method>>;
  /**
   * Extra cache identity which is not sent to the host. Batched callers use
   * this for renderer-local dimensions such as the authenticated user.
   */
  readonly cacheKeyIdentity: string | undefined;
  readonly options: HostQueryTanstackOptions<
    Method,
    ResponseOfMethod<Registry, Method>
  > | null;
}

export interface UseHostQueriesWithCombineOptions<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
  TCombinedResult,
> extends UseHostQueriesOptions<Registry, Method> {
  readonly combine: (
    results: Array<
      UseQueryResult<ResponseOfMethod<Registry, Method>, HostRpcError>
    >,
  ) => TCombinedResult;
}

export function useHostQueries<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
  TCombinedResult,
>(
  args: UseHostQueriesWithCombineOptions<Registry, Method, TCombinedResult>,
): TCombinedResult;

export function useHostQueries<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
>(
  args: UseHostQueriesOptions<Registry, Method>,
): Array<UseQueryResult<ResponseOfMethod<Registry, Method>, HostRpcError>>;

export function useHostQueries<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
>(args: UseHostQueriesOptions<Registry, Method>): unknown {
  return useHostQueriesWithResponseMap<
    Registry,
    Method,
    ResponseOfMethod<Registry, Method>
  >({
    ...args,
    mapResponse: (mapArgs) => mapArgs.response,
  });
}

export interface UseHostQueriesWithResponseMapOptions<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
  TData,
> {
  readonly client: HostRequester<Registry> | null;
  readonly requests: ReadonlyArray<HostRequestSpec<Registry, Method>>;
  readonly cacheKeyIdentity: string | undefined;
  readonly options: HostQueryTanstackOptions<Method, TData> | null;
  /**
   * Same role as `UseHostQueryWithResponseMapOptions.mapResponse` in
   * `use-host-query.ts` (see that doc comment), applied per-request here -
   * each request in the batch gets its own `queryKey` passed to this
   * function, so an accumulator reading `queryClient.getQueryData(queryKey)`
   * targets the right slot for that specific request.
   */
  readonly mapResponse: (args: {
    readonly response: ResponseOfMethod<Registry, Method>;
    readonly queryClient: QueryClient;
    readonly queryKey: QueryKey;
  }) => TData;
}

export interface UseHostQueriesWithResponseMapAndCombineOptions<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
  TData,
  TCombinedResult,
> extends UseHostQueriesWithResponseMapOptions<Registry, Method, TData> {
  readonly combine: (
    results: Array<UseQueryResult<TData, HostRpcError>>,
  ) => TCombinedResult;
}

/**
 * `useHostQueries` generalized with a caller-supplied response-to-cache
 * transform, mirroring `useHostQueryWithResponseMap`'s singular counterpart.
 */
export function useHostQueriesWithResponseMap<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
  TData,
  TCombinedResult,
>(
  args: UseHostQueriesWithResponseMapAndCombineOptions<
    Registry,
    Method,
    TData,
    TCombinedResult
  >,
): TCombinedResult;

export function useHostQueriesWithResponseMap<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
  TData,
>(
  args: UseHostQueriesWithResponseMapOptions<Registry, Method, TData>,
): Array<UseQueryResult<TData, HostRpcError>>;

export function useHostQueriesWithResponseMap<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
  TData,
>(
  args: UseHostQueriesWithResponseMapOptions<Registry, Method, TData>,
): unknown {
  const { client, requests, options, mapResponse } = args;
  const queryClient = useQueryClient();
  const conditionPollCoordinator =
    getConditionPollEpisodeCoordinator(queryClient);
  const readiness = useReactiveHostReadiness(client);
  const baseOptions = options ?? {};
  const { meta, poll, select, ...queryOptionsWithoutReservedFields } =
    baseOptions;

  const queries = requests.map((request) => {
    const queryKey: QueryKey = [
      ...queryKeys.hostMethod<Registry, Method>(
        readiness.hostId,
        request.method,
        request.params,
      ),
      ...(args.cacheKeyIdentity === undefined ? [] : [args.cacheKeyIdentity]),
    ];
    // Boundary-wrapped like `useHostQueryWithResponseMap`'s request:
    // non-control-flow throws from caller-supplied `mapResponse` are
    // `HostRpcError`, while coordinator control flow is cancellation.
    const fetcher = ({ signal }: QueryFunctionContext): Promise<TData> =>
      withHostQueryErrorBoundary(request.method, async () => {
        if (client === null) {
          return Promise.reject<TData>(
            hostClientUnavailableError(request.method),
          );
        }
        const response = await client.requestWithSignal(
          request.method,
          request.params,
          signal,
        );
        return mapResponse({ response, queryClient, queryKey });
      });
    const pollPolicy = HOST_METHOD_POLL_TABLE[request.method].poll;
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
            : conditionPollCoordinator.refetchIntervalFor(request.method),
        retry: false,
      };
    } else if (pollPolicy !== null) {
      tablePollingOptions = {
        refetchInterval: poll === true ? pollPolicy.intervalMs : false,
        refetchIntervalInBackground: false,
      };
    }
    return queryOptions<TData, HostRpcError, TData>({
      ...queryOptionsWithoutReservedFields,
      ...tablePollingOptions,
      // A throw inside a caller-supplied `select` is stored by the observer as
      // `result.error` - the same `HostRpcError`-typed channel the queryFn
      // boundary protects - so it must be normalized too. Mirrors
      // `useHostQueryWithResponseMap` in `use-host-query.ts`.
      select:
        select === undefined
          ? undefined
          : (data) => {
              try {
                return select(data);
              } catch (error) {
                throw toHostRpcError(error, request.method);
              }
            },
      queryKey,
      queryFn: fetcher,
      // Reserved key wins over caller meta; the coordinator latches it once.
      meta: stampHostRpcMethod(meta, request.method),
      // A function-form `enabled` must still be evaluated per-query - not
      // collapsed to a boolean up front - or a caller's dynamic condition is
      // silently replaced by "always true" the moment a client is bound.
      // Mirrors `useHostQueryWithResponseMap` in `use-host-query.ts`.
      enabled: (query) => {
        if (client === null || !readiness.isReady) return false;
        const callerEnabled = options?.enabled;
        return typeof callerEnabled === "function"
          ? callerEnabled(query)
          : (callerEnabled ?? true);
      },
    });
  });
  const useQueriesOptions = hasCombine(args)
    ? { queries, combine: args.combine }
    : { queries };
  return useQueries(useQueriesOptions);
}

function hasCombine<
  Registry extends HostRpcRegistry,
  Method extends keyof Registry & keyof HostRpcRegistry & string,
  TData,
>(
  args: UseHostQueriesWithResponseMapOptions<Registry, Method, TData>,
): args is UseHostQueriesWithResponseMapAndCombineOptions<
  Registry,
  Method,
  TData,
  unknown
> {
  return "combine" in args;
}
