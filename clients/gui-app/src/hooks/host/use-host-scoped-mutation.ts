import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  agentMutationKeys,
  hostQueryKeys,
  providersMutationKeys,
  workspaceMutationKeys,
} from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsProviderOperation,
} from "@/lib/analytics";

interface HostScopedMutationContext<Captured> {
  readonly hostId: string | null;
  /** Whatever `captureContext` read at send time; `undefined` without one. */
  readonly captured: Captured;
}

interface UseHostScopedMutationArgs<
  Method extends keyof HostRpcRegistry & string,
  Captured,
> {
  readonly method: Method;
  readonly mutationKey: ReadonlyArray<unknown>;
  readonly errorMessage: string;
  /** Each entry expands to `["host", hostId, method]`, dropping every cached query for that method regardless of params. Method prefixes to invalidate on success. */
  readonly invalidateMethods: ReadonlyArray<keyof HostRpcRegistry & string>;
  /**
   * Success work that must run even if the observer unmounted. Per-`mutate` callbacks are skipped with no listeners; `Mutation.execute` options still run.
   */
  /**
   * `hostId` captured in `onMutate` (the host the request was sent on). The client may have re-pointed since.
   */
  readonly onSuccess?:
    | ((
        data: ResponseOfMethod<HostRpcRegistry, Method>,
        variables: RequestOfMethod<HostRpcRegistry, Method>,
        hostId: string | null,
        captured: Captured,
      ) => void)
    | undefined;
  /**
   * Per-request state from `onMutate` travels with that `mutate()` to its `onSuccess`. A shared ref would return the last press; `onMutate` is not synchronous with `mutate()`.
   */
  readonly captureContext?:
    | ((variables: RequestOfMethod<HostRpcRegistry, Method>) => Captured)
    | undefined;
  /** Codes the caller handles inline (a confirm dialog). */
  readonly silentCodes?: readonly HostRpcError["code"][];
}

/** Standard host-mutation shape: capture `hostId` in `onMutate` to survive a host swap mid-flight, invalidate the listed read methods for that host on success, surface a host-error toast on failure. */
export function useHostScopedMutation<
  Method extends keyof HostRpcRegistry & string,
  Captured = undefined,
>(
  args: UseHostScopedMutationArgs<Method, Captured>,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, Method>,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, Method>,
  HostScopedMutationContext<Captured>
> {
  const client = useHostClient();
  return useHostScopedMutationForClient(client, args);
}

export function useHostScopedMutationForClient<
  Method extends keyof HostRpcRegistry & string,
  Captured = undefined,
>(
  client: HostClient<HostRpcRegistry> | null,
  args: UseHostScopedMutationArgs<Method, Captured>,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, Method>,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, Method>,
  HostScopedMutationContext<Captured>
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    Method,
    HostScopedMutationContext<Captured>
  >({
    client,
    method: args.method,
    mapVariables: (variables) => variables,
    options: {
      mutationKey: args.mutationKey,
      onMutate: (variables) => ({
        hostId: client?.getActiveHostId() ?? null,
        // `undefined` is what `Captured` IS when no capture was asked for;
        // the cast only names that fact for the compiler.
        captured:
          args.captureContext === undefined
            ? (undefined as Captured)
            : args.captureContext(variables),
      }),
      onSuccess: (data, variables, ctx) => {
        trackScopedMutationSuccess(args.mutationKey, variables);
        // Before the host-id gate: this work is the caller's, and a null host
        // id is a reason to skip invalidation, not to skip the caller.
        args.onSuccess?.(data, variables, ctx.hostId, ctx.captured);
        if (ctx.hostId === null) return;
        for (const method of args.invalidateMethods) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(ctx.hostId, method),
          });
        }
      },
      onError: (error) => {
        if (args.silentCodes?.includes(error.code) === true) return;
        toastFromHostError(error, args.errorMessage);
      },
    },
  });
}

const PROVIDER_MUTATION_OPERATIONS: Readonly<
  Record<string, AnalyticsProviderOperation | undefined>
> = {
  [providersMutationKeys.setSelection()[0]]: "selection",
  [providersMutationKeys.addCustomPath()[0]]: "custom_path",
  [providersMutationKeys.removeCustomPath()[0]]: "custom_path",
  [providersMutationKeys.setEnabled()[0]]: "enabled",
  [providersMutationKeys.setApiKey()[0]]: "api_key",
  [providersMutationKeys.clearApiKey()[0]]: "api_key",
  [providersMutationKeys.setTerminalAgentArgs()[0]]: "terminal_args",
  [providersMutationKeys.setEnvOverride()[0]]: "env_override",
  [providersMutationKeys.deleteEnvOverride()[0]]: "env_override",
  [providersMutationKeys.renameProfile()[0]]: "profile",
  [providersMutationKeys.recolorProfile()[0]]: "profile",
  [providersMutationKeys.removeProfile()[0]]: "profile",
  [providersMutationKeys.acknowledgeAmbientDrift()[0]]: "ambient_drift",
};

function trackScopedMutationSuccess(
  mutationKey: ReadonlyArray<unknown>,
  variables: unknown,
): void {
  const action = mutationKey[0];
  if (typeof action !== "string") return;
  const providerOperation = PROVIDER_MUTATION_OPERATIONS[action];
  if (providerOperation !== undefined) {
    Analytics.getInstance().track(AnalyticsEvent.ProviderConfigurationChanged, {
      operation: providerOperation,
    });
    return;
  }
  if (action === workspaceMutationKeys.addBindingFolder()[0]) {
    Analytics.getInstance().track(AnalyticsEvent.WorkspaceFolderAdded, {
      source: "direct_ui",
      workspace_kind: "local",
    });
    return;
  }
  if (action === workspaceMutationKeys.removeBindingEntry()[0]) {
    Analytics.getInstance().track(AnalyticsEvent.WorkspaceFolderRemoved, {
      source: "direct_ui",
      workspace_kind: "unknown",
    });
    return;
  }
  if (action === agentMutationKeys.stop()[0]) {
    const cascade =
      variables !== null &&
      typeof variables === "object" &&
      "cascade" in variables &&
      variables.cascade === true;
    Analytics.getInstance().track(AnalyticsEvent.AgentStopped, {
      source: "direct_ui",
      cascade,
    });
  }
}
