import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  providerProfileSchema,
  PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { type HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host";
import { useHostMutationWithResponseTimeout } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { commitAuthoritativeProvidersList } from "@/hooks/providers/commit-authoritative-providers-list";

type AwaitLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;
type AwaitLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;
type AwaitLoginContext = { readonly hostId: string | null };

/**
 * One wait for a login: the wire request, and the caller's way to stop
 * waiting for it.
 *
 * The request names a provider and a profile and nothing else, and the client
 * shares one in-flight `providers.awaitLogin` between identical requests
 * (`host-method-policy-table.ts`, mode `join`). That is right while both
 * waiters wait on the same login, and wrong once one of them has let its
 * login go: its request stays in flight for the seconds the host spends
 * re-probing auth after the child exits, and a sign-in started again inside
 * that window would take that request's "not signed in" for its own answer.
 * Aborting `signal` detaches this wait, so the next one is asked afresh.
 * `undefined` for a caller that only ever waits to the end.
 */
export type AwaitLoginVariables = {
  readonly request: AwaitLoginRequest;
  readonly signal: AbortSignal | undefined;
};

// The provider state a login echo carries. Named rather than inlined so the
// capability-stripping helper below states its own contract.
type AwaitLoginProviderState = NonNullable<AwaitLoginResponse["state"]>;

/**
 * Drops `loginCapability` from a mutation state echo so an overlay cannot
 * narrow the cached capability. See the call site for why this one field is
 * different from every other field on the echo.
 */
function withoutLoginCapability(
  state: AwaitLoginProviderState,
  cachedProfiles: readonly ProviderProfile[],
) {
  const { loginCapability: _dropped, ...rest } = state;
  return {
    ...rest,
    profiles: rest.profiles.map((profile) => {
      const parsed = providerProfileSchema.parse(profile);
      const cached = cachedProfiles.find(
        (candidate) => candidate.profileId === parsed.profileId,
      );
      return cached === undefined
        ? parsed
        : {
            ...parsed,
            enabled: cached.enabled,
            launchCommand: cached.launchCommand,
          };
    }),
  };
}

/**
 * Awaits the honest login-completion edge for a provider on the CURRENT tab's
 * host: the host blocks the response until the `<cli> auth login` child
 * closes, then re-probes and returns that provider's fresh state. This replaces
 * the old 2s `forceAuthRefresh` poll - one request, resolving exactly when the
 * browser flow finishes, so there is no flaky-probe flicker mid-sign-in.
 *
 * On success the returned state is merged into the tab host's `providers.list`
 * cache, so the re-auth gate flips (and unmounts the banner) without a second
 * probe. A `null` state means nothing about the provider changed - nothing was
 * in flight to await, or the host could not install an approved sign-in - and
 * leaves the cache untouched.
 */
export function useProvidersAwaitLogin(): UseMutationResult<
  AwaitLoginResponse,
  HostRpcError,
  AwaitLoginVariables,
  AwaitLoginContext
> {
  const client = useTabHostClient();
  const tabHostId = useTabHostId();
  return useProvidersAwaitLoginForClient({
    client,
    getCacheHostId: () => tabHostId,
  });
}

/**
 * Settings-panel variant. It follows the selected host via
 * `HostRuntimeContext`, not a tab-bound host.
 */
export function useHostScopedProvidersAwaitLogin(): UseMutationResult<
  AwaitLoginResponse,
  HostRpcError,
  AwaitLoginVariables,
  AwaitLoginContext
> {
  const client = useHostClient();
  return useProvidersAwaitLoginForClient({
    client,
    getCacheHostId: () => client.getActiveHostId(),
  });
}

/** Client-scoped variant, keyed by a caller-supplied cache host id - lets a
 *  caller outside `HostRuntimeContext` (e.g. the picker's tab-scoped
 *  "Create new profile" flow) target an explicit host instead of the
 *  app-wide default. `getCacheHostId` is a separate parameter (not derived
 *  from `client.getActiveHostId()`) so the cache write lands under the
 *  caller's KNOWN host id even while `client` itself is still resolving
 *  (mirrors `useProvidersAwaitLogin`'s tab-scoped `getCacheHostId`). */
export function useProvidersAwaitLoginForClient(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly getCacheHostId: () => string | null;
}): UseMutationResult<
  AwaitLoginResponse,
  HostRpcError,
  AwaitLoginVariables,
  AwaitLoginContext
> {
  const queryClient = useQueryClient();
  return useHostMutationWithResponseTimeout<
    HostRpcRegistry,
    "providers.awaitLogin",
    AwaitLoginContext,
    AwaitLoginVariables
  >({
    client: args.client,
    method: "providers.awaitLogin",
    mapVariables: (variables) => variables.request,
    signalFor: (variables) => variables.signal,
    // Long-poll: the host holds the response until the OAuth child
    // terminates (bounded by its own 3-minute login timeout). The default
    // ~30 s frame timeout would abandon a healthy sign-in as soon as the
    // user takes longer than that in the browser.
    responseTimeoutMs: PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
    options: {
      mutationKey: providersMutationKeys.awaitLogin(),
      onMutate: () => ({ hostId: args.getCacheHostId() }),
      onSuccess: async (data: AwaitLoginResponse, _variables, context) => {
        const next = data.state;
        if (next === null || context.hostId === null) return;
        await commitAuthoritativeProvidersList({
          queryClient,
          hostId: context.hostId,
          update: (prev) => {
            if (prev === undefined) return prev;
            return {
              providers: prev.providers.map((p) =>
                p.providerId === next.providerId
                  ? // Overlay the echo onto the cached entry rather than
                    // replacing it. The echo is pinned to the frozen
                    // `providerMutationCliStateSchemaV21`, so it does not
                    // carry the provider-pack-registry fields
                    // (`managedInstallState`, `versionVisibility`,
                    // `advisory`) - only `providers.list@5.0` does. A
                    // straight replace would blank whatever the last list
                    // fetch established, since a login cannot change what is
                    // installed. The echo stays authoritative for every
                    // field it does model.
                    //
                    // `loginCapability` is the one field it must NOT be
                    // authoritative for. It is PRESENT on the echo but frozen
                    // at the v4.0 shape, so it lacks `terminalLogin` - and a
                    // present-but-narrower object overwrites wholesale. That
                    // would silently retract the terminal sign-in affordance
                    // the moment any login echo landed, which is exactly when
                    // the user is looking at it. Capability is a property of
                    // the installed CLI, not of a login attempt; only
                    // `providers.list` may set it.
                    {
                      ...p,
                      ...withoutLoginCapability(next, p.profiles),
                    }
                  : p,
              ),
              native: prev.native,
            };
          },
        });
        // The overlay above is optimistic-only, and deliberately cannot be
        // the last word. The echo is pinned to
        // `providerMutationCliStateSchemaV21`, whose field set is the
        // hand-frozen `providerCliStateBaseShapeV40` - strictly narrower than
        // the live `providers.list` row, and a login is exactly the moment the
        // rest of that row moves too (the profile list gains the new account,
        // its ambient identity resolves). Left at the overlay, the screens the
        // user is looking at would keep rendering pre-login values for every
        // field the echo does not model.
        //
        // `commitAuthoritativeProvidersList` invalidates every
        // `PROVIDER_INVALIDATIONS` entry EXCEPT `providers.list` (the one it
        // just wrote), which is right for the force-refresh callers - their
        // payload IS a full list response. It is wrong here, so this path adds
        // the one invalidation the helper withholds: without it the stale
        // fields stand for a full `staleTime` (15 minutes).
        //
        // Note what the refetch will NOT do: enable the provider. Signing in
        // never changes enablement - the row comes back with the same sticky
        // `enabled` it had. Onboarding, the one screen where a sign-in is
        // meant to enable, sends that toggle itself.
        await queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(context.hostId, "providers.list"),
        });
      },
      onError: (error, variables) => {
        // A wait the caller itself dropped is not a failure to confirm
        // anything: the caller already knows how its attempt ended.
        if (variables.signal?.aborted === true) return;
        toastFromHostError(error, "Couldn't confirm sign-in.");
      },
    },
  });
}
