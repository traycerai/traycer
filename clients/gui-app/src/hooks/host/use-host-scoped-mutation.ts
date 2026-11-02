import {
  useQueryClient,
  type MutationScope,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  HostClient,
  HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
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

export interface HostScopedMutationContext<Captured> {
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
  /**
   * The failure toast's words. Null when they name what the call was for,
   * which the request does not carry: the caller toasts in its own
   * `mutate(…, { onError })`.
   */
  readonly errorMessage: string | null;
  /**
   * Method prefixes to invalidate once the mutation SETTLES. Each entry
   * expands to `["host", servingHostId, method]` (the pool for a pool-only
   * read, else the host the mutation went to), dropping every cached query for
   * that method regardless of params. Pass the full set of read methods this
   * mutation affects; an empty list means "no automatic invalidation."
   *
   * SETTLED, NOT SUCCEEDED, and that is the contract rather than a detail: a
   * write whose ANSWER was lost still changed the host. `config.simulator.set`
   * is the case that proved it - `protocol/src/config/store.ts`'s
   * `runCliConfigUpdateLocked` resolves only after an atomic tmp+rename under
   * the settings lock, so by the time anything can fail downstream the new
   * block is on disk - and the same holds for every host verb that commits
   * before it replies. Keeping the pre-write read on that path leaves the page
   * showing a value the host has already replaced, with nothing to move it
   * (`staleTime` is 60s and these reads do not poll), while the error toast is
   * telling the user the write "may or may not have gone through". So the
   * answer the cache must not keep is the stale one, and re-asking is how the
   * UI finds out which way it went. `useSimulatorOpenMutation` reached the
   * same conclusion for its own sweep ("a lost answer still leaves a host that
   * booted the device") - this is that argument applied where every other
   * host write shares it.
   *
   * A genuine refusal re-asks too. It costs one read and re-establishes what
   * the host actually holds, which is never wrong to know after a failed
   * write.
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
   *
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
  /**
   * TanStack mutation scope. Mutations sharing a scope id run one at a time,
   * in the order they were fired.
   *
   * For mutations whose ARRIVAL order at the host carries meaning, which the
   * host-side scheduling policy cannot supply: `HostRequestCoordinator` keys
   * its queues by `[hostId, userId, method, params]`, so it orders a method
   * against itself and never two different methods against each other. A
   * set/clear pair for the same resource is the shape that needs this.
   *
   * Omit it unless that ordering is load-bearing - a shared scope also
   * serializes unrelated calls that happen to use the same hook.
   */
  readonly scope?: MutationScope | undefined;
  /**
   * Completes the request at dispatch: the executable-write grant
   * (`useExecutableWriteGrant`) on a write that can reach an execution sink.
   * See `UseHostMutationOptions.prepareRequest`.
   */
  readonly prepareRequest?:
    | ((
        request: RequestOfMethod<HostRpcRegistry, Method>,
        client: HostRequester<HostRpcRegistry>,
      ) => Promise<RequestOfMethod<HostRpcRegistry, Method>>)
    | undefined;
}

/**
 * Standard host-mutation shape: capture `hostId` in `onMutate` to
 * survive a host swap mid-flight, invalidate the listed read methods
 * for that host once the write settles, surface a host-error toast on failure.
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
    prepareRequest: args.prepareRequest,
    options: {
      mutationKey: args.mutationKey,
      scope: args.scope,
      onMutate: (variables) => ({
        hostId: client?.getActiveHostId() ?? null,
        // `undefined` is what `Captured` IS when no capture was asked for;
        // the cast only names that fact for the compiler.
        captured:
          args.captureContext === undefined
            ? (undefined as Captured)
            : args.captureContext(variables),
      }),
      // The analytics event and the caller's own work are the SUCCESS half and
      // stay here: one reports a write that landed, the other files a response
      // this arm is the only one to receive.
      onSuccess: (data, variables, ctx) => {
        trackScopedMutationSuccess(args.mutationKey, variables);
        args.onSuccess?.(data, variables, ctx.hostId, ctx.captured);
      },
      // The sweep, on every settle - see `invalidateMethods`. `ctx` is
      // optional on this signature because `onMutate` need not have run (a
      // throw inside it settles the mutation too), and a null host id is a
      // reason to skip the invalidation rather than to guess a key for it.
      onSettled: (_data, _error, _variables, ctx) => {
        const sentOn = ctx?.hostId ?? null;
        if (sentOn === null) return;
        for (const method of args.invalidateMethods) {
          // Under the tier that answers the read, as `useHostQuery` keys it: a
          // pool-only read is filed under the pool whichever host carried this.
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              hostRpcServingTierHostId(
                method,
                sentOn,
                readProcessHostRpcTierPlan(),
                null,
              ),
              method,
            ),
          });
        }
      },
      onError: (error) => {
        if (args.silentCodes?.includes(error.code) === true) return;
        if (args.errorMessage === null) return;
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
  // The per-profile twins report the SAME operation as the provider-wide pair
  // above. `api_key` answers "did this user configure a key", and where the
  // credential is scoped does not change that - splitting them into a second
  // operation would break the metric's continuity for no analytical gain,
  // while leaving them out undercounts every provider whose key is per-account
  // (today: Antigravity, whose key has no provider-wide form at all).
  [providersMutationKeys.setProfileApiKey()[0]]: "api_key",
  [providersMutationKeys.clearProfileApiKey()[0]]: "api_key",
  [providersMutationKeys.setTerminalAgentArgs()[0]]: "terminal_args",
  [providersMutationKeys.setEnvOverride()[0]]: "env_override",
  [providersMutationKeys.deleteEnvOverride()[0]]: "env_override",
  [providersMutationKeys.renameProfile()[0]]: "profile",
  [providersMutationKeys.recolorProfile()[0]]: "profile",
  [providersMutationKeys.removeProfile()[0]]: "profile",
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
