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
  useEnvironmentCloudOperation,
} from "@/hooks/environment/use-environment-cloud";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import {
  useHostOwnEnvironment,
  type HostOwnEnvironment,
} from "@/hooks/environment/use-host-own-environment";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import type { EnvironmentCloudMethod } from "@/lib/environment/environment-cloud-calls";
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

/**
 * A secrets write, to authn. Its operation begins when the mutation runs,
 * which is the press: these writes take no `scope`, and a mutation never
 * pauses (`networkMode: "always"`, `lib/query-client.ts`).
 */
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
  const begin = useEnvironmentCloudOperation();
  const { method } = args;
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, Method>,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, Method>,
    TContext
  >({
    mutationKey: args.mutationKey,
    mutationFn: (request) => begin()(method, request),
    onMutate: args.onMutate,
    onSuccess: args.onSuccess,
  });
}
