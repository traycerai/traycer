import {
  queryOptions,
  useQueries,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { queryKeys } from "@/lib/query-keys";
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
  readonly options: Pick<
    UseQueryOptions<
      ResponseOfMethod<Registry, Method>,
      HostRpcError,
      ResponseOfMethod<Registry, Method>
    >,
    "staleTime" | "enabled" | "gcTime" | "refetchInterval" | "placeholderData"
  > | null;
}

export function useHostQueries<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
>(
  args: UseHostQueriesOptions<Registry, Method>,
): Array<UseQueryResult<ResponseOfMethod<Registry, Method>, HostRpcError>> {
  const { client, requests, options } = args;
  const readiness = useReactiveHostReadiness(client);
  const enabledFromOptions =
    options === null || options.enabled === undefined
      ? true
      : Boolean(options.enabled);
  const enabled = enabledFromOptions && client !== null && readiness.isReady;

  return useQueries({
    queries: requests.map((request) => {
      const fetcher = (): Promise<ResponseOfMethod<Registry, Method>> => {
        if (client === null) {
          return Promise.reject<ResponseOfMethod<Registry, Method>>(
            new Error("Host client unavailable"),
          );
        }
        return client.request(request.method, request.params);
      };
      return queryOptions<
        ResponseOfMethod<Registry, Method>,
        HostRpcError,
        ResponseOfMethod<Registry, Method>
      >({
        ...(options ?? {}),
        queryKey: queryKeys.hostMethod<Registry, Method>(
          readiness.hostId,
          request.method,
          request.params,
        ),
        queryFn: fetcher,
        enabled,
      });
    }),
  });
}
