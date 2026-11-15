import type {
  UseMutationOptions,
  UseMutationResult,
  UseQueryResult,
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
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { usePressCapturedMutation } from "@/hooks/use-press-captured-mutation";
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
  const source = useConfigurationSource();
  const pick = useEnvironmentPick();
  const onPersonal = source.kind === "host" && pick.kind === "personal";
  const personal = usePersonalEnvironment(onPersonal);
  const own = useHostOwnEnvironment(
    client,
    useRequesterHostId(client),
    source.kind === "host" && pick.kind === "local",
  );
  if (source.kind === "pool") {
    return {
      environmentId: source.environmentId,
      resolved: true,
      retry: own.retry,
    };
  }
  if (onPersonal) {
    return {
      ...personal,
      resolved: personal.resolved && personal.environmentId !== null,
    };
  }
  return own;
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

/** A Secrets press keeps its own sender; typed values remain dispatch-time reads. */
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
  return usePressCapturedMutation(begin, args);
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
