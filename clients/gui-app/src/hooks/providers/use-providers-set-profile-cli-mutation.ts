import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  ProfileCliSelection,
  ProvidersGetProfileConfigResponse,
} from "@traycer/protocol/host/provider-profile-config-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { invalidateProviderFamily } from "@/hooks/providers/invalidations";

/**
 * D02/D20: a managed profile's CLI binary pin. `selection: null` gives the
 * pin up and rides the Default account's pick - the same `null` the wire's
 * `profileConfigSchema.cliSelection` uses, never a `{kind:"bundled"}` stand-in
 * (that WOULD be a pin, at the bundled binary).
 */
export interface SetProfileCliSelectionVariables {
  readonly providerId: ProviderId;
  /** Managed profiles only - the Default account keeps `providers.setSelection`. */
  readonly profileId: string;
  readonly selection: ProfileCliSelection | null;
}

/** D02: a managed profile's own terminal-agent args (never the Default
 *  account's, which keeps `providers.setTerminalAgentArgs`). */
export interface SetProfileTerminalAgentArgsVariables {
  readonly providerId: ProviderId;
  readonly profileId: string;
  readonly terminalAgentArgs: string;
}

interface ProfileCliMutateContext {
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
 * D01/D15/D16: `providers.setProfileConfig` takes the WHOLE config and
 * carries no revision token (last-write-wins), so changing the CLI pin reads
 * the current config fresh and writes it back with only `cliSelection`
 * changed. Owns the CLI-pin write for a MANAGED profile and nothing else: it
 * can never reach `provider-overrides.json`, which is what makes the CLI &
 * Args tab stop editing the Default account behind the switcher's back.
 */
export function useProvidersSetProfileCliSelection(): UseMutationResult<
  ProvidersGetProfileConfigResponse,
  HostRpcError,
  SetProfileCliSelectionVariables,
  ProfileCliMutateContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    ProvidersGetProfileConfigResponse,
    HostRpcError,
    SetProfileCliSelectionVariables,
    ProfileCliMutateContext
  >({
    mutationKey: providersMutationKeys.setProfileCliSelection(),
    mutationFn: async (variables) => {
      const current = await client.request("providers.getProfileConfig", {
        providerId: variables.providerId,
        profileId: variables.profileId,
      });
      return client.request("providers.setProfileConfig", {
        providerId: variables.providerId,
        profileId: variables.profileId,
        config: { ...current.config, cliSelection: variables.selection },
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
    onError: (error) => toastFromHostError(error, "Couldn't save CLI binary."),
    onSettled: (_data, _error, _variables, ctx) =>
      invalidateProviderFamily(queryClient, ctx?.hostId ?? null),
  });
}

/** Same read-modify-write shape as
 *  {@link useProvidersSetProfileCliSelection}, for the args field. */
export function useProvidersSetProfileTerminalAgentArgs(): UseMutationResult<
  ProvidersGetProfileConfigResponse,
  HostRpcError,
  SetProfileTerminalAgentArgsVariables,
  ProfileCliMutateContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    ProvidersGetProfileConfigResponse,
    HostRpcError,
    SetProfileTerminalAgentArgsVariables,
    ProfileCliMutateContext
  >({
    mutationKey: providersMutationKeys.setProfileTerminalAgentArgs(),
    mutationFn: async (variables) => {
      const current = await client.request("providers.getProfileConfig", {
        providerId: variables.providerId,
        profileId: variables.profileId,
      });
      return client.request("providers.setProfileConfig", {
        providerId: variables.providerId,
        profileId: variables.profileId,
        config: {
          ...current.config,
          terminalAgentArgs: variables.terminalAgentArgs,
        },
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
      toastFromHostError(error, "Couldn't save CLI arguments."),
    onSettled: (_data, _error, _variables, ctx) =>
      invalidateProviderFamily(queryClient, ctx?.hostId ?? null),
  });
}
