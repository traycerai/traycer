import { useCallback, useMemo } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  EnvironmentCloud,
  EnvironmentCloudSource,
} from "@traycer-clients/shared/environment/environment-cloud";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import type { HostScopedMutationContext } from "@/hooks/host/use-host-scoped-mutation";
import {
  callEnvironmentCloud,
  environmentCloudHostError,
  type EnvironmentCloudMethod,
} from "@/lib/environment/environment-cloud-calls";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { toastFromHostError } from "@/lib/host-error-toast";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * The key scope the app's own environment calls are cached under, where a host
 * read puts its host id: `["host", "authn", method, params, ...]`. So the
 * configuration invalidations that match a method under any host scope
 * (`environment-host-list-key.ts`) reach these reads too.
 */
export const ENVIRONMENT_CLOUD_QUERY_SCOPE = "authn";

/**
 * The cache entry a moved read lands in: the one place its key is built, so a
 * caller that names the entry (a Details provider's `fetchQuery`) reads the
 * page's own.
 */
export function environmentCloudQueryKey<Method extends EnvironmentCloudMethod>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
  viewerId: string,
  cacheKeyIdentity: ReadonlyArray<unknown>,
): QueryKey {
  return [
    ...hostQueryKeys.method<HostRpcRegistry, Method>(
      ENVIRONMENT_CLOUD_QUERY_SCOPE,
      method,
      params,
    ),
    viewerId,
    ...cacheKeyIdentity,
  ];
}

/**
 * Makes the app's own client for authn's environment routes, one per
 * operation, bound to the sign-in it begins on; null with no session service.
 */
export function useEnvironmentCloud(): EnvironmentCloudSource | null {
  const auth = useHostBinding()?.auth ?? null;
  return useMemo(
    () => (auth === null ? null : () => auth.environmentCloud()),
    [auth],
  );
}

/** Marks every cached read of `methods`, under every scope, stale. */
export function invalidateEnvironmentReads(
  queryClient: QueryClient,
  methods: ReadonlyArray<keyof HostRpcRegistry & string>,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      methods.some((method) =>
        hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, method),
      ),
  });
}

/**
 * One moved method, sent now on the person's sign-in, outside React (a
 * Details provider) or from a hook. Failures are the `HostRpcError` a host
 * gave; with no session service it fails as a host with no client does.
 */
export function requestEnvironmentCloud<Method extends EnvironmentCloudMethod>(
  cloud: EnvironmentCloudSource | null,
  method: Method,
  request: RequestOfMethod<HostRpcRegistry, Method>,
): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  return withHostQueryErrorBoundary(method, async () => {
    cloudVerdictPreflight(method)();
    if (cloud === null) throw hostClientUnavailableError(method);
    return callEnvironmentCloud(cloud(), method, request);
  });
}

/**
 * Sends one moved method at the moment it is called, for a write that builds
 * its request at dispatch (a typed secret value read then, so it never becomes
 * a mutation's variables).
 */
export function useEnvironmentCloudSender(): <
  Method extends EnvironmentCloudMethod,
>(
  method: Method,
  request: RequestOfMethod<HostRpcRegistry, Method>,
) => Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
  const cloud = useEnvironmentCloud();
  return useCallback(
    (method, request) => requestEnvironmentCloud(cloud, method, request),
    [cloud],
  );
}

interface UseEnvironmentCloudQueryArgs<
  Method extends EnvironmentCloudMethod,
  TData,
> {
  readonly method: Method;
  readonly params: RequestOfMethod<HostRpcRegistry, Method>;
  /** Extra cache identity, not sent. */
  readonly cacheKeyIdentity: ReadonlyArray<unknown>;
  readonly mapResponse: (
    response: ResponseOfMethod<HostRpcRegistry, Method>,
  ) => TData;
  /** The caller's own gate, on top of a session, a viewer and a verdict. */
  readonly enabled: boolean;
  /** Takes the method's table-owned polling, as `useHostQuery`'s `poll` does. */
  readonly poll: boolean;
}

/**
 * A moved read, made by the app itself on the person's sign-in: no host in
 * the path. Its failures are the `HostRpcError` the host gave the same one, so
 * a screen reads them as before.
 */
export function useEnvironmentCloudQuery<
  Method extends EnvironmentCloudMethod,
  TData,
>(
  args: UseEnvironmentCloudQueryArgs<Method, TData>,
): UseQueryResult<TData, HostRpcError> {
  const { method, params, mapResponse } = args;
  const cloud = useEnvironmentCloud();
  const send = useEnvironmentCloudSender();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const queryClient = useQueryClient();
  const tablePolling = getConditionPollEpisodeCoordinator(
    queryClient,
  ).pollOptionsFor(method, args.poll);
  const queryKey = environmentCloudQueryKey(
    method,
    params,
    viewerId,
    args.cacheKeyIdentity,
  );
  return useQuery<TData, HostRpcError, TData>(
    queryOptions<TData, HostRpcError, TData>({
      ...tablePolling,
      queryKey,
      queryFn: async () => mapResponse(await send(method, params)),
      // Keyed where a host read of `method` would be, so the poll coordinator
      // reads its method from the same stamp `useHostQuery` writes.
      meta: stampHostRpcMethod(undefined, method),
      enabled:
        args.enabled && cloud !== null && viewerId.length > 0 && authorized,
    }),
  );
}

/**
 * A read the app makes itself whose answer is assembled here from authn's
 * routes rather than one moved method's (the review sheet, the notices). Its
 * key sits where a host read of `method` would, with `params` naming the
 * environment, so the configuration invalidations reach it.
 */
export function useEnvironmentCloudOwnRead<
  TData,
  Params extends { readonly environmentId: string },
>(args: {
  readonly method: keyof HostRpcRegistry & string;
  readonly params: Params;
  readonly read: (cloud: EnvironmentCloud) => Promise<TData>;
  readonly enabled: boolean;
}): UseQueryResult<TData, HostRpcError> {
  const { method, params, read } = args;
  const cloud = useEnvironmentCloud();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useQuery<TData, HostRpcError, TData>(
    // `cloud` is the sign-in of the viewer the key already names; adding it
    // would refetch on its identity alone.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryOptions<TData, HostRpcError, TData>({
      queryKey: [
        ...hostQueryKeys.scope(ENVIRONMENT_CLOUD_QUERY_SCOPE),
        method,
        params,
        viewerId,
      ],
      meta: stampHostRpcMethod(undefined, method),
      queryFn: () =>
        withHostQueryErrorBoundary(method, async () => {
          cloudVerdictPreflight(method)();
          if (cloud === null) throw hostClientUnavailableError(method);
          try {
            return await read(cloud());
          } catch (error) {
            throw environmentCloudHostError(method, error);
          }
        }),
      enabled:
        args.enabled && cloud !== null && viewerId.length > 0 && authorized,
    }),
  );
}

interface UseEnvironmentCloudMutationArgs<
  Method extends EnvironmentCloudMethod,
  Captured,
> {
  readonly method: Method;
  readonly mutationKey: ReadonlyArray<unknown>;
  /** The failure toast's words; null when the caller toasts its own. */
  readonly errorMessage: string | null;
  /**
   * Reads to mark stale once the write SETTLES, under every scope: a write
   * whose answer was lost may still have landed, so the page re-asks.
   */
  readonly invalidateMethods: ReadonlyArray<keyof HostRpcRegistry & string>;
  /** As `useHostScopedMutation`'s; `hostId` is always null here. */
  readonly onSuccess?:
    | ((
        data: ResponseOfMethod<HostRpcRegistry, Method>,
        variables: RequestOfMethod<HostRpcRegistry, Method>,
        hostId: string | null,
        captured: Captured,
      ) => void)
    | undefined;
  readonly captureContext?:
    | ((variables: RequestOfMethod<HostRpcRegistry, Method>) => Captured)
    | undefined;
  readonly silentCodes?: readonly HostRpcError["code"][];
}

/**
 * A moved write, made by the app itself on the person's sign-in. The same
 * result as `useHostScopedMutation`'s, so its callers are unchanged; no host
 * carried it, so the context's `hostId` is null.
 */
export function useEnvironmentCloudMutation<
  Method extends EnvironmentCloudMethod,
  Captured = undefined,
>(
  args: UseEnvironmentCloudMutationArgs<Method, Captured>,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, Method>,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, Method>,
  HostScopedMutationContext<Captured>
> {
  const { method } = args;
  const send = useEnvironmentCloudSender();
  const queryClient = useQueryClient();
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, Method>,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, Method>,
    HostScopedMutationContext<Captured>
  >({
    mutationKey: args.mutationKey,
    mutationFn: (request) => send(method, request),
    onMutate: (variables) => ({
      hostId: null,
      // `undefined` is what `Captured` IS when no capture was asked for; the
      // cast only names that fact for the compiler.
      captured:
        args.captureContext === undefined
          ? (undefined as Captured)
          : args.captureContext(variables),
    }),
    onSuccess: (data, variables, context) => {
      args.onSuccess?.(data, variables, null, context.captured);
    },
    onSettled: () => {
      void invalidateEnvironmentReads(queryClient, args.invalidateMethods);
    },
    onError: (error) => {
      if (args.silentCodes?.includes(error.code) === true) return;
      if (args.errorMessage === null) return;
      toastFromHostError(error, args.errorMessage);
    },
  });
}
