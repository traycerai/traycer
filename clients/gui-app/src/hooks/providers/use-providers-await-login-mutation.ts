import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useQueryClient } from "@tanstack/react-query";
import { PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS } from "@traycer/protocol/host/provider-schemas";
import { type HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host";
import { useHostMutationWithResponseTimeout } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { providersMutationKeys } from "@/lib/query-keys";
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
 * Awaits the honest login-completion edge for a provider on the CURRENT tab's
 * host: the host blocks the response until the `<cli> auth login` child
 * closes, then re-probes and returns that provider's fresh state. This replaces
 * the old 2s `forceAuthRefresh` poll - one request, resolving exactly when the
 * browser flow finishes, so there is no flaky-probe flicker mid-sign-in.
 *
 * On success the returned state is merged into the tab host's `providers.list`
 * cache, so the re-auth gate flips (and unmounts the banner) without a second
 * probe. A `null` state means nothing was in flight to await - left untouched.
 */
export function useProvidersAwaitLogin(): UseMutationResult<
  AwaitLoginResponse,
  HostRpcError,
  AwaitLoginRequest,
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
  AwaitLoginRequest,
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
  AwaitLoginRequest,
  AwaitLoginContext
> {
  const queryClient = useQueryClient();
  return useHostMutationWithResponseTimeout<
    HostRpcRegistry,
    "providers.awaitLogin",
    AwaitLoginContext
  >({
    client: args.client,
    method: "providers.awaitLogin",
    mapVariables: (variables: AwaitLoginRequest) => variables,
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
                p.providerId === next.providerId ? next : p,
              ),
            };
          },
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't confirm sign-in."),
    },
  });
}
