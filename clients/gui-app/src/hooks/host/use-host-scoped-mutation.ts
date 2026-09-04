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
  /**
   * Method prefixes to invalidate on success. Each entry expands to
   * `["host", hostId, method]`, dropping every cached query for that
   * method regardless of params. Pass the full set of read methods this
   * mutation affects; an empty list means "no automatic invalidation."
   */
  readonly invalidateMethods: ReadonlyArray<keyof HostRpcRegistry & string>;
  /**
   * Success work that must land even if the caller unmounted mid-flight.
   *
   * TanStack skips the per-`mutate` callbacks once the observer has no
   * listeners, while the mutation's own options still run from
   * `Mutation.execute`. Anything whose omission would leave the HOST and the
   * UI disagreeing - a resource the host created that nothing else will ever
   * surface - belongs here, not in a `mutate(vars, { onSuccess })` at the call
   * site.
   */
  /**
   * `hostId` is the one captured in `onMutate` - the host this request was
   * SENT on, which is not necessarily the one the client addresses by the time
   * it answers (a surface whose target host moved mid-flight re-points the
   * client underneath). A caller that files the response against a host must
   * use this one, per the host-swap rule in gui-app AGENTS.md.
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
   * Per-request state to hand `onSuccess` alongside the host id. Runs inside
   * `onMutate` - before the request is dispatched, once per `mutate()`, in
   * the order the `mutate()`s were called - and its answer travels with THAT
   * mutation to its own `onSuccess`. A caller that stashes per-press state in
   * a ref and reads it back in `onSuccess` gets the LAST press's value
   * instead: the mutation-level callback closes over the ref, not over the
   * call, and nothing serializes two `mutate()`s on one observer.
   *
   * `onMutate` is not synchronous with `mutate()` (TanStack awaits the
   * cache-level hook first), so a caller pairing state to a press must hand
   * it over in press ORDER - a queue - not by reading "the current" value.
   */
  readonly captureContext?:
    | ((variables: RequestOfMethod<HostRpcRegistry, Method>) => Captured)
    | undefined;
  /**
   * Codes the caller handles inline (a confirm dialog). The default toast is
   * skipped so the user is not told to "stop the run" AND asked to confirm.
   */
  readonly silentCodes?: readonly HostRpcError["code"][];
}

/**
 * Standard host-mutation shape: capture `hostId` in `onMutate` to
 * survive a host swap mid-flight, invalidate the listed read methods
 * for that host on success, surface a host-error toast on failure.
 */
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
