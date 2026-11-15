import {
  useMutation,
  useQueryClient,
  type MutateOptions,
  type UseMutateFunction,
  type UseMutateAsyncFunction,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  useEnvironmentCloudQuery,
  useEnvironmentCloudOperation,
} from "@/hooks/environment/use-environment-cloud";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import {
  useHostOwnEnvironment,
  type HostOwnEnvironment,
} from "@/hooks/environment/use-host-own-environment";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import type {
  EnvironmentCloudMethod,
  EnvironmentCloudSend,
} from "@/lib/environment/environment-cloud-calls";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Every secrets call is the app's own call to authn on the person's sign-in,
 * naming the environment it is about: a team's, Personal's, or, where a page
 * names none, the one the host it reads through runs.
 */
type SecretsMethod = Extract<
  EnvironmentCloudMethod,
  `environment.secrets.${string}`
>;

/**
 * The environment a Settings page's secrets calls name: the page's own (a
 * team's, or Personal's), else the one `client`'s host runs, which the host
 * filled in when it was asked for its own. `retry` re-asks what that lookup
 * could not read.
 */
export function useSecretsEnvironment(
  client: HostClient<HostRpcRegistry> | null,
): HostOwnEnvironment {
  const addressed = useAddressedEnvironment();
  const hostOwn = addressed.resolved && addressed.environmentId === null;
  const own = useHostOwnEnvironment(
    client,
    useRequesterHostId(client),
    hostOwn,
  );
  return hostOwn ? own : { ...addressed, retry: own.retry };
}

/** A secrets read, from authn. */
export function useSecretsRead<Method extends SecretsMethod>(args: {
  readonly method: Method;
  readonly params: RequestOfMethod<HostRpcRegistry, Method>;
  readonly enabled: boolean;
  readonly poll: boolean;
}): UseQueryResult<ResponseOfMethod<HostRpcRegistry, Method>, HostRpcError> {
  return useEnvironmentCloudQuery({
    method: args.method,
    params: args.params,
    cacheKeyIdentity: [],
    mapResponse: (response) => response,
    enabled: args.enabled,
    poll: args.poll,
  });
}

type SecretsPress<TVariables> = { readonly variables: TVariables } & (
  | { readonly kind: "ready"; readonly send: EnvironmentCloudSend }
  | { readonly kind: "failed"; readonly error: unknown }
);

/**
 * Captures the sign-in synchronously with each Secrets press, before TanStack
 * awaits its mutation hooks. Each invocation owns a separate envelope even
 * for void or reused variables; values supplied by a reader stay at dispatch.
 */
export function useSecretsOperationMutation<
  TData,
  TVariables,
  TContext = unknown,
>(
  args: Omit<
    UseMutationOptions<TData, HostRpcError, TVariables, TContext>,
    "mutationFn"
  > & {
    readonly mutationFn: (
      variables: TVariables,
      send: EnvironmentCloudSend,
    ) => Promise<TData>;
  },
): UseMutationResult<TData, HostRpcError, TVariables, TContext> {
  const begin = useEnvironmentCloudOperation();
  const queryClient = useQueryClient();
  const { mutationFn, ...provided } = args;
  const { onMutate, onSuccess, onError, onSettled, ...options } =
    queryClient.defaultMutationOptions(provided);
  const mutation = useMutation<
    TData,
    HostRpcError,
    SecretsPress<TVariables>,
    TContext
  >({
    ...options,
    mutationFn: (press) =>
      press.kind === "failed"
        ? Promise.reject<TData>(press.error)
        : mutationFn(press.variables, press.send),
    onMutate:
      onMutate === undefined
        ? undefined
        : (press, context) => onMutate(press.variables, context),
    onSuccess:
      onSuccess === undefined
        ? undefined
        : (data, press, result, context) =>
            onSuccess(data, press.variables, result, context),
    onError:
      onError === undefined
        ? undefined
        : (error, press, result, context) =>
            onError(error, press.variables, result, context),
    onSettled:
      onSettled === undefined
        ? undefined
        : (data, error, press, result, context) =>
            onSettled(data, error, press.variables, result, context),
  });
  const capture = (variables: TVariables): SecretsPress<TVariables> => {
    try {
      return { kind: "ready", variables, send: begin() };
    } catch (error) {
      // Capture failures still go through the mutation's error callbacks.
      return { kind: "failed", variables, error };
    }
  };
  const callbacks = (
    perCall: MutateOptions<TData, HostRpcError, TVariables, TContext> | undefined,
  ):
    | MutateOptions<TData, HostRpcError, SecretsPress<TVariables>, TContext>
    | undefined =>
    perCall === undefined
      ? undefined
      : {
          ...perCall,
          onSuccess: (data, press, result, context) =>
            perCall.onSuccess?.(data, press.variables, result, context),
          onError: (error, press, result, context) =>
            perCall.onError?.(error, press.variables, result, context),
          onSettled: (data, error, press, result, context) =>
            perCall.onSettled?.(data, error, press.variables, result, context),
        };
  const mutate: UseMutateFunction<TData, HostRpcError, TVariables, TContext> = (
    variables,
    perCall,
  ) => mutation.mutate(capture(variables), callbacks(perCall));
  const mutateAsync: UseMutateAsyncFunction<
    TData,
    HostRpcError,
    TVariables,
    TContext
  > = (variables, perCall) =>
    mutation.mutateAsync(capture(variables), callbacks(perCall));
  if (mutation.isIdle) {
    return { ...mutation, variables: undefined, mutate, mutateAsync };
  }
  return {
    ...mutation,
    variables: mutation.variables.variables,
    mutate,
    mutateAsync,
  };
}

/** A secrets write to authn, bound to the sign-in current at the press. */
export function useSecretsWrite<
  Method extends SecretsMethod,
  TContext = unknown,
>(args: {
  readonly method: Method;
  readonly mutationKey: ReadonlyArray<unknown>;
  readonly onMutate?: (() => TContext) | undefined;
  readonly onSuccess?:
    | ((
        data: ResponseOfMethod<HostRpcRegistry, Method>,
        variables: RequestOfMethod<HostRpcRegistry, Method>,
        context: TContext,
      ) => Promise<void> | void)
    | undefined;
}): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, Method>,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, Method>,
  TContext
> {
  const { method } = args;
  return useSecretsOperationMutation<
    ResponseOfMethod<HostRpcRegistry, Method>,
    RequestOfMethod<HostRpcRegistry, Method>,
    TContext
  >({
    mutationKey: args.mutationKey,
    mutationFn: (request, send) => send(method, request),
    onMutate: args.onMutate,
    onSuccess: args.onSuccess,
  });
}
