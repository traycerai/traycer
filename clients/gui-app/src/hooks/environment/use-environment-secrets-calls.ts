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

type SecretsMethod = Extract<
  EnvironmentCloudMethod,
  `environment.secrets.${string}`
>;

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
