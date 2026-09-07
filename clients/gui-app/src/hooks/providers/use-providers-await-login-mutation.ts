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

// The provider state a login echo carries. Named rather than inlined so the
// capability-stripping helper below states its own contract.
type AwaitLoginProviderState = NonNullable<AwaitLoginResponse["state"]>;

/** Drops `loginCapability` from a mutation state echo so an overlay cannot narrow the cached capability. */
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
 * Host blocks until the auth child closes, then returns fresh state. Merge into the tab host's `providers.list`; `null` means nothing was in flight.
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

/** It follows the selected host via `HostRuntimeContext`, not a tab-bound host. */
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

/** the picker's tab-scoped "Create new profile" flow) target an explicit host instead of the app-wide default. */
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
    // Long-poll: the host holds the response until the OAuth child terminates (bounded by its own 3-minute login timeout).
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
                  ? // Overlay the echo; do not replace. loginCapability must stay from providers.list (echo lacks terminalLogin).
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
        // Overlay is narrower than providers.list. Invalidate providers.list here (commitAuthoritativeProvidersList withholds it). Sign-in does not enable.
        await queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(context.hostId, "providers.list"),
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't confirm sign-in."),
    },
  });
}
