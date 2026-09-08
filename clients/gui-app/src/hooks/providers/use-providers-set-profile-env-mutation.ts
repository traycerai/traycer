import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProvidersGetProfileConfigResponse } from "@traycer/protocol/host/provider-profile-config-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { invalidateProviderFamily } from "@/hooks/providers/invalidations";

/** Upserts one entry (or an explicit unset, `value: null`) in a managed
 *  profile's own env (D16) - never the Default account's. */
export type SetProfileEnvVariables = {
  readonly providerId: ProviderId;
  readonly profileId: string;
  readonly key: string;
  readonly value: string | null;
  /**
   * The key this entry is REPLACING, when the user renamed it; `null` for a
   * plain add or value edit. Carried on the same write rather than deleted by
   * a follow-up mutation: D15 is last-write-wins with no revision token, so
   * two writes clobber a concurrent edit twice, and a failure between them
   * leaves the profile holding BOTH keys.
   */
  readonly previousKey: string | null;
};

interface ProfileEnvMutateContext {
  readonly hostId: string | null;
}

function profileConfigQueryKey(
  hostId: string | null,
  providerId: ProviderId,
  profileId: string,
) {
  return hostQueryKeys.method<HostRpcRegistry, "providers.getProfileConfig">(
    hostId,
    "providers.getProfileConfig",
    { providerId, profileId },
  );
}

/**
 * D01/D15/D16: `providers.setProfileConfig` takes the WHOLE config, never a
 * sparse patch, and carries no revision token (last-write-wins). Setting one
 * env entry therefore reads the current config fresh and writes it back with
 * only `env` changed - the sanctioned shape for a profile-config write, not a
 * workaround for a missing PATCH verb.
 */
export function useProvidersSetProfileEnvOverride(): UseMutationResult<
  ProvidersGetProfileConfigResponse,
  HostRpcError,
  SetProfileEnvVariables,
  ProfileEnvMutateContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    ProvidersGetProfileConfigResponse,
    HostRpcError,
    SetProfileEnvVariables,
    ProfileEnvMutateContext
  >({
    mutationKey: providersMutationKeys.setProfileEnv(),
    mutationFn: async (variables) => {
      const current = await client.request("providers.getProfileConfig", {
        providerId: variables.providerId,
        profileId: variables.profileId,
      });
      const nextEnv = [
        ...current.config.env.filter(
          (entry) =>
            entry.key !== variables.key && entry.key !== variables.previousKey,
        ),
        { key: variables.key, value: variables.value },
      ];
      return client.request("providers.setProfileConfig", {
        providerId: variables.providerId,
        profileId: variables.profileId,
        config: { ...current.config, env: nextEnv },
        credentialUpdate: { kind: "unchanged" },
      });
    },
    onMutate: () => ({ hostId: client.getActiveHostId() }),
    onSuccess: (data, variables, ctx) => {
      if (ctx.hostId === null) return;
      queryClient.setQueryData(
        profileConfigQueryKey(
          ctx.hostId,
          variables.providerId,
          variables.profileId,
        ),
        data,
      );
    },
    onError: (error) =>
      toastFromHostError(error, "Couldn't save environment variable."),
    onSettled: (_data, _error, _variables, ctx) =>
      invalidateProviderFamily(queryClient, ctx?.hostId ?? null),
  });
}

/** Removes one entry from a managed profile's own env (D16). */
export type DeleteProfileEnvVariables = {
  readonly providerId: ProviderId;
  readonly profileId: string;
  readonly key: string;
};

/** Same read-modify-write shape as {@link useProvidersSetProfileEnvOverride}. */
export function useProvidersDeleteProfileEnvOverride(): UseMutationResult<
  ProvidersGetProfileConfigResponse,
  HostRpcError,
  DeleteProfileEnvVariables,
  ProfileEnvMutateContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    ProvidersGetProfileConfigResponse,
    HostRpcError,
    DeleteProfileEnvVariables,
    ProfileEnvMutateContext
  >({
    mutationKey: providersMutationKeys.deleteProfileEnv(),
    mutationFn: async (variables) => {
      const current = await client.request("providers.getProfileConfig", {
        providerId: variables.providerId,
        profileId: variables.profileId,
      });
      const nextEnv = current.config.env.filter(
        (entry) => entry.key !== variables.key,
      );
      return client.request("providers.setProfileConfig", {
        providerId: variables.providerId,
        profileId: variables.profileId,
        config: { ...current.config, env: nextEnv },
        credentialUpdate: { kind: "unchanged" },
      });
    },
    onMutate: () => ({ hostId: client.getActiveHostId() }),
    onSuccess: (data, variables, ctx) => {
      if (ctx.hostId === null) return;
      queryClient.setQueryData(
        profileConfigQueryKey(
          ctx.hostId,
          variables.providerId,
          variables.profileId,
        ),
        data,
      );
    },
    onError: (error) =>
      toastFromHostError(error, "Couldn't remove environment variable."),
    onSettled: (_data, _error, _variables, ctx) =>
      invalidateProviderFamily(queryClient, ctx?.hostId ?? null),
  });
}
