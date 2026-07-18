import {
  queryOptions,
  useQueries,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { withHostRpcErrorBoundary } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { queryKeys } from "@/lib/query-keys";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";

export interface HostRequestSpec<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> {
  readonly method: Method;
  readonly params: RequestOfMethod<Registry, Method>;
}

export interface UseHostQueriesOptions<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> {
  readonly client: HostClient<Registry> | null;
  readonly requests: ReadonlyArray<HostRequestSpec<Registry, Method>>;
  /**
   * Extra cache identity which is not sent to the host. Batched callers use
   * this for renderer-local dimensions such as the authenticated user.
   */
  readonly cacheKeyIdentity: string | undefined;
  readonly options: Pick<
    UseQueryOptions<
      ResponseOfMethod<Registry, Method>,
      HostRpcError,
      ResponseOfMethod<Registry, Method>
    >,
    "staleTime" | "enabled" | "gcTime" | "refetchInterval" | "placeholderData"
  > | null;
}

export interface UseHostQueriesWithCombineOptions<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
  TCombinedResult,
> extends UseHostQueriesOptions<Registry, Method> {
  readonly combine: (
    results: Array<
      UseQueryResult<ResponseOfMethod<Registry, Method>, HostRpcError>
    >,
  ) => TCombinedResult;
}

export function useHostQueries<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
  TCombinedResult,
>(
  args: UseHostQueriesWithCombineOptions<Registry, Method, TCombinedResult>,
): TCombinedResult;

export function useHostQueries<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
>(
  args: UseHostQueriesOptions<Registry, Method>,
): Array<UseQueryResult<ResponseOfMethod<Registry, Method>, HostRpcError>>;

export function useHostQueries<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
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
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
  TData,
> {
  readonly client: HostClient<Registry> | null;
  readonly requests: ReadonlyArray<HostRequestSpec<Registry, Method>>;
  readonly cacheKeyIdentity: string | undefined;
  readonly options: Pick<
    UseQueryOptions<TData, HostRpcError, TData>,
    "staleTime" | "enabled" | "gcTime" | "refetchInterval" | "placeholderData"
  > | null;
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
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
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
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
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
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
  TData,
>(
  args: UseHostQueriesWithResponseMapOptions<Registry, Method, TData>,
): Array<UseQueryResult<TData, HostRpcError>>;

export function useHostQueriesWithResponseMap<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
  TData,
>(
  args: UseHostQueriesWithResponseMapOptions<Registry, Method, TData>,
): unknown {
  const { client, requests, options, mapResponse } = args;
  const queryClient = useQueryClient();
  const readiness = useReactiveHostReadiness(client);

  const queries = requests.map((request) => {
    const queryKey: QueryKey = [
      ...queryKeys.hostMethod<Registry, Method>(
        readiness.hostId,
        request.method,
        request.params,
      ),
      ...(args.cacheKeyIdentity === undefined ? [] : [args.cacheKeyIdentity]),
    ];
    // Boundary-wrapped like `useHostQueryWithResponseMap`'s request: the
    // declared `HostRpcError` generic must hold even when the caller's
    // `mapResponse` throws.
    const fetcher = (): Promise<TData> =>
      withHostRpcErrorBoundary(request.method, async () => {
        if (client === null) {
          return Promise.reject<TData>(
            hostClientUnavailableError(request.method),
          );
        }
        const response = await client.request(request.method, request.params);
        return mapResponse({ response, queryClient, queryKey });
      });
    return queryOptions<TData, HostRpcError, TData>({
      ...(options ?? {}),
      queryKey,
      queryFn: fetcher,
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
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
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
