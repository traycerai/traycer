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
  type RequiredHostMethodVersion,
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
  TRequestContext = undefined,
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
   * The wire payload for THIS dispatch, derived from `params` at the moment
   * the request goes out. Omitted (the default) sends `params` itself.
   *
   * `params` is both the query KEY and the payload everywhere else, and for
   * almost every method that identity is the right one: what you asked for is
   * what identifies the answer. The seam exists for a field that is neither -
   * a REVISION THE CLIENT ALREADY HOLDS, which says nothing about which
   * resource is being read and everything about how much of it needs to come
   * back. The revision-gated record lists (`epic.listChatRecords@1.3`,
   * `epic.listTuiAgents@1.3`) send their last answer's list stamp this way:
   * putting it in `params` would mint a new cache entry on every poll tick -
   * so the 20s cadence would refetch from scratch forever and the gating would
   * never fire - while a stamp frozen into the key at mount would be stale by
   * the second tick.
   *
   * Called once per dispatch, inside the queryFn, AFTER `preflight` and before
   * `captureRequestContext` - so the ordering fence stays the last thing read
   * before the request leaves. A throw is normalized by the same boundary the
   * dispatch is.
   *
   * What must NOT go through here: anything that changes which answer is
   * correct for this key. The cache slot is shared by every dispatch that
   * agrees on `params`, so a payload difference this seam introduces has to be
   * one the cached representation is indifferent to.
   */
  readonly buildRequest?: (
    params: RequestOfMethod<Registry, Method>,
  ) => RequestOfMethod<Registry, Method>;
  /**
   * Pass-through TanStack options (`enabled`, `staleTime`, etc.). Query key
   * and queryFn are owned by this hook so the invalidation contract holds.
   */
  readonly options: HostQueryTanstackOptions<Method, TData> | null;
  /** Captures cache-side ordering state immediately before request dispatch. */
  readonly captureRequestContext?: () => TRequestContext;
  /**
   * Runs inside the queryFn immediately before the request goes out, and a
   * throw refuses THIS dispatch as a `HostRpcError` (normalized by the
   * boundary) with no request sent. For a condition `enabled` cannot enforce:
   * `enabled` stops the NEXT fetch, not a `refetch()` override nor the retry
   * episode already running when the condition changed - so a verdict
   * withdrawn mid-retry must be re-read here or the retries keep dispatching
   * on the retained host credential.
   */
  readonly preflight?: () => void;
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
    readonly requestContext: TRequestContext | undefined;
    readonly signal: AbortSignal;
  }) => TData | Promise<TData>;
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
  TRequestContext = undefined,
>(
  args: UseHostQueryWithResponseMapOptions<
    Registry,
    Method,
    TData,
    TRequestContext
  >,
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
      args.preflight?.();
      // The payload, which is `params` unless a caller derives one per
      // dispatch - see `buildRequest`. Read BEFORE the ordering fence below so
      // that fence remains the last thing captured before the request leaves.
      const buildRequest = args.buildRequest;
      const payload =
        buildRequest === undefined ? params : buildRequest(params);
      const requestContext = args.captureRequestContext?.();
      const response = await client.requestWithSignal(method, payload, signal);
      return mapResponse({
        response,
        queryClient,
        queryKey,
        requestContext,
        signal,
      });
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
        if (client === null || !readiness.canExecute) return false;
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
  /** Resolve per mutation when a batch contains targets on different hosts. */
  readonly client:
    | HostRequester<Registry>
    | null
    | ((variables: TVariables) => HostRequester<Registry> | null);
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
  /** Runs at the raw-response boundary, before TanStack lifecycle callbacks. */
  readonly onResponse?: (
    response: ResponseOfMethod<Registry, Method>,
    variables: TVariables,
  ) => void;
  /**
   * A version floor this mutation's DISPATCH must clear, evaluated at dispatch
   * so it can read live state (an auth verdict that only some sessions gate
   * on), and enforced against the handshake of the connection carrying the
   * frame - see `HostRequestOptions.requiredHostMethodVersion`.
   *
   * There used to be an async `preflight` option here, and this replaced its
   * only user rather than joining it. A pre-flight probe runs on its OWN
   * connection, so it establishes a fact about a host process that can be
   * replaced before the mutation is written - for a floor that exists to stop
   * a write from landing on an older resolver, that is the entire failure
   * mode, and an option shaped to invite it is worth not having. Returning
   * `null` dispatches with no floor.
   */
  readonly requiredHostMethodVersion?: (
    variables: TVariables,
  ) => RequiredHostMethodVersion | null;
  /**
   * A stable RETRY IDENTITY for this dispatch, evaluated per mutation so it can
   * read the ids the variables carry (`epic.create` keys on the `epicId` it is
   * minting). A non-null key routes the dispatch through
   * `HostRequester.requestWithOptions`, which is the only entry point that can
   * express a key AND the `requiredHostMethodVersion` floor above at once.
   * Returning `null` - and omitting the option - dispatches exactly as before.
   *
   * READ THE ALLOWLIST on `HostRequester.requestWithIdempotencyKey` before
   * adding a caller. A key promises that a SECOND arrival of these bytes is the
   * same intent, which for a create is only true because hash-only content
   * keeps the params byte-identical across a replay; for anything else it is a
   * way to have a command applied twice under one name.
   */
  readonly idempotencyKey?: (variables: TVariables) => string | null;
  /**
   * Substitutes the response the rest of the mutation sees, with the ability to
   * SEND AGAIN first.
   *
   * It exists for one shape: a 2xx body that is a refusal the client itself can
   * remedy. `epic.create`'s `missing-attachment-bytes` is that - the host could
   * not find bytes for a hash the message referenced, and the fix is to
   * re-upload and ask again - and it must be handled BELOW every refusal arm,
   * because all three of them (`onSuccess`, the create's own `.then`, the
   * landing submission's `.then`) fire on the first refusal they see and one of
   * them tears down state a retry still needs. Running inside `mutationFn` is
   * what makes "only the final outcome reaches them" true.
   *
   * `redispatch` is the mutation function's OWN dispatch closure, already
   * wrapped by {@link mapDispatchError} - same client, method, params, key and
   * version floor - because the caller of this seam holds none of those and a
   * hand-rolled second request would differ from the first in ways no type
   * would catch (a floor refusal reading differently, a key going missing and
   * turning the retry into a second create).
   *
   * Deliberately NOT the removed `preflight`: that probed on its own connection
   * before the write, so it established a fact about a host process that could
   * be replaced before the write landed. This acts on the write's own answer.
   */
  readonly resolveResponse?: (
    response: ResponseOfMethod<Registry, Method>,
    variables: TVariables,
    redispatch: () => Promise<ResponseOfMethod<Registry, Method>>,
  ) => Promise<ResponseOfMethod<Registry, Method>>;
  /**
   * Re-shapes an error thrown by the DISPATCH before the boundary normalizes
   * it. Scoped to the dispatch on purpose: a `mapVariables` throw is already
   * the caller's own error and needs no translation.
   *
   * The case it exists for is a refusal whose CONDITION a surface already has
   * copy for, decided one layer lower than that copy lives - a
   * `requiredHostMethodVersion` refusal is the same "this host cannot serve an
   * unverified create" the composer states inline, and the user should read
   * the same sentence wherever it is decided. Returning `cause` unchanged is
   * the identity, and omitting the option is the same thing.
   */
  readonly mapDispatchError?: (cause: unknown) => unknown;
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
      withHostQueryErrorBoundary(args.method, async () => {
        const client =
          typeof args.client === "function"
            ? args.client(variables)
            : args.client;
        if (client === null) {
          return Promise.reject<ResponseOfMethod<Registry, Method>>(
            hostClientUnavailableError(args.method),
          );
        }
        const params = args.mapVariables(variables);
        const requirement = args.requiredHostMethodVersion?.(variables) ?? null;
        const idempotencyKey = args.idempotencyKey?.(variables) ?? null;
        // THREE branches, and the third is the only one that can carry two
        // options at once. `requestWithOptions` is reached ONLY for a keyed
        // dispatch, which keeps every existing mutation on the byte-identical
        // path it has always taken - and keeps a cast-partial host-client stub
        // (`Object.assign({} as HostClient, { request, requestWithSignal })`,
        // which cannot fail at compile) working in the suites that never key a
        // mutation. A suite that DOES reach a keyed mutation has to stub the
        // member; there is no version of this that both applies the key and
        // asks nothing of those stubs.
        const dispatch = (): Promise<ResponseOfMethod<Registry, Method>> => {
          if (idempotencyKey !== null) {
            return client.requestWithOptions(args.method, params, {
              idempotencyKey,
              // The method's own scheduling budget. A keyed create is a small
              // INTERACTIVE request once its images travel by hash, so there is
              // nothing to extend - and the policy table REFUSES a budget it
              // does not declare for the method.
              responseTimeoutMs: null,
              requiredHostMethodVersion: requirement,
              // No caller cancellation, matching the two branches below. A
              // mutation's dispatch is not tied to an observer's lifetime here.
              signal: undefined,
            });
          }
          return requirement === null
            ? client.request(args.method, params)
            : client.requestWithSignalRequiringHostMethodVersion(
                args.method,
                params,
                undefined,
                requirement,
              );
        };
        const mapDispatchError = args.mapDispatchError;
        // `.catch` directly on the dispatch, never chained after a `.then`: a
        // catch downstream of a success arm also catches what that arm throws,
        // and here that would re-map a `resolveResponse` failure into a
        // dispatch error.
        const mappedDispatch =
          mapDispatchError === undefined
            ? dispatch
            : (): Promise<ResponseOfMethod<Registry, Method>> =>
                dispatch().catch((cause: unknown) => {
                  throw mapDispatchError(cause);
                });
        const dispatched = await mappedDispatch();
        // Between the dispatch and `onResponse`, so a substituted response is
        // what every arm below sees - including the caller's `onSuccess` and
        // whatever `mutateAsync` resolves with.
        const resolveResponse = args.resolveResponse;
        const response =
          resolveResponse === undefined
            ? dispatched
            : await resolveResponse(dispatched, variables, mappedDispatch);
        args.onResponse?.(response, variables);
        return response;
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
      withHostQueryErrorBoundary(args.method, async () => {
        const client =
          typeof args.client === "function"
            ? args.client(variables)
            : args.client;
        if (client === null) {
          return Promise.reject<ResponseOfMethod<Registry, Method>>(
            hostClientUnavailableError(args.method),
          );
        }
        const response = await client.requestWithResponseTimeout(
          args.method,
          args.mapVariables(variables),
          args.responseTimeoutMs,
        );
        args.onResponse?.(response, variables);
        return response;
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
