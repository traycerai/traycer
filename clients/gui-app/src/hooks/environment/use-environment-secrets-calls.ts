import {
  useMutation,
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
  useEnvironmentCloudSender,
} from "@/hooks/environment/use-environment-cloud";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { EnvironmentCloudMethod } from "@/lib/environment/environment-cloud-calls";
import type { HostRpcRegistry } from "@/lib/host";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";

/**
 * A secrets call names the environment it is about, or none: a named one (a
 * team's, or Personal's) is the app's own call to authn on the person's
 * sign-in; none means the host's own secrets, and stays the host's call.
 */
type SecretsMethod = Extract<
  EnvironmentCloudMethod,
  `environment.secrets.${string}`
>;

function namedEnvironmentOf(request: object): string | null {
  return "environmentId" in request && typeof request.environmentId === "string"
    ? request.environmentId
    : null;
}

/** A secrets read: authn's for a named environment, the host's own otherwise. */
export function useSecretsRead<Method extends SecretsMethod>(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly method: Method;
  readonly params: RequestOfMethod<HostRpcRegistry, Method>;
  readonly enabled: boolean;
  readonly poll: boolean;
}): UseQueryResult<ResponseOfMethod<HostRpcRegistry, Method>, HostRpcError> {
  const named = namedEnvironmentOf(args.params) !== null;
  const cloud = useEnvironmentCloudQuery({
    method: args.method,
    params: args.params,
    cacheKeyIdentity: [],
    mapResponse: (response) => response,
    enabled: args.enabled && named,
    poll: args.poll,
  });
  const hostOwn = useHostQuery<HostRpcRegistry, Method>({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: args.method,
    params: args.params,
    options: { enabled: args.enabled && !named, poll: args.poll },
  });
  return named ? cloud : hostOwn;
}

/** A secrets write: authn's for a named environment, the host's own otherwise. */
export function useSecretsWrite<
  Method extends SecretsMethod,
  TContext = unknown,
>(args: {
  readonly client: HostClient<HostRpcRegistry>;
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
  const send = useEnvironmentCloudSender();
  const { client, method } = args;
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, Method>,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, Method>,
    TContext
  >({
    mutationKey: args.mutationKey,
    mutationFn: (request) =>
      namedEnvironmentOf(request) === null
        ? withHostQueryErrorBoundary(method, () =>
            client.request(method, request),
          )
        : send(method, request),
    onMutate: args.onMutate,
    onSuccess: args.onSuccess,
  });
}
