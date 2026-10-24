import {
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  RequiredHostMethodVersion,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useConfigurationEnvironmentId } from "@/components/settings/environment/configuration-source";
import { useHostMutation } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { SECRET_READS } from "@/lib/environment/delta-fed-reads";
import { hostQueryKeys } from "@/lib/query-keys";
import { settingsDetailsMutationKeys } from "@/lib/query-keys/settings-details-query-keys";
import { replaceOutcome } from "@/lib/sandboxes/secret-replace-outcome";

/**
 * The writes that carry a typed secret value: Add a secret's Verify and Save,
 * and Replace value. Each takes a reader the dialog fills, called at
 * dispatch, so the value never becomes the mutation's variables and reaches
 * no query or mutation cache.
 *
 * A team's write carries its `environmentId` at @1.1, so an older host refuses
 * it before it is sent rather than writing the person's own secrets.
 */

type ValueMethod =
  | "environment.secrets.create"
  | "environment.secrets.verify"
  | "environment.secrets.replaceValue";

interface CapturedHost {
  readonly hostId: string | null;
}

function teamFloor(
  environmentId: string | null,
  method: ValueMethod,
): RequiredHostMethodVersion | null {
  return environmentId === null
    ? null
    : { method, version: { major: 1, minor: 1 } };
}

function preflightTeam(
  environmentId: string | null,
  method: ValueMethod,
): void {
  if (environmentId !== null) cloudVerdictPreflight(method)();
}

/** A saved or rotated value moves the list, its versions and its rotation. */
function rereadSecrets(queryClient: QueryClient, hostId: string | null): void {
  for (const method of SECRET_READS) {
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(hostId, method),
    });
  }
}

export function useEnvironmentSecretsCreateMutation(
  client: HostClient<HostRpcRegistry>,
  readRequest: () => RequestOfMethod<
    HostRpcRegistry,
    "environment.secrets.create"
  >,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "environment.secrets.create">,
  HostRpcError,
  void,
  CapturedHost
> {
  const environmentId = useConfigurationEnvironmentId();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "environment.secrets.create",
    CapturedHost,
    void
  >({
    client,
    method: "environment.secrets.create",
    mapVariables: () => {
      preflightTeam(environmentId, "environment.secrets.create");
      return { ...readRequest(), environmentId };
    },
    requiredHostMethodVersion: () =>
      teamFloor(environmentId, "environment.secrets.create"),
    options: {
      mutationKey: settingsDetailsMutationKeys.secretCreate(),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (outcome, _variables, captured) => {
        if (outcome.outcome !== "refused") {
          rereadSecrets(queryClient, captured.hostId);
        }
      },
    },
  });
}

export function useEnvironmentSecretsVerifyCandidateMutation(
  client: HostClient<HostRpcRegistry>,
  readRequest: () => RequestOfMethod<
    HostRpcRegistry,
    "environment.secrets.verify"
  >,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "environment.secrets.verify">,
  HostRpcError,
  void
> {
  const environmentId = useConfigurationEnvironmentId();
  return useHostMutation<
    HostRpcRegistry,
    "environment.secrets.verify",
    unknown,
    void
  >({
    client,
    method: "environment.secrets.verify",
    mapVariables: () => {
      preflightTeam(environmentId, "environment.secrets.verify");
      return { ...readRequest(), environmentId };
    },
    requiredHostMethodVersion: () =>
      teamFloor(environmentId, "environment.secrets.verify"),
    options: {
      mutationKey: settingsDetailsMutationKeys.secretVerifyCandidate(),
    },
  });
}

/** The compare-and-set a replacement names; the value is read at dispatch. */
export interface SecretReplaceTarget {
  readonly secretId: string;
  readonly expectedVersionId: string;
}

export function useEnvironmentSecretsReplaceValueMutation(
  client: HostClient<HostRpcRegistry>,
  readValue: () => string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "environment.secrets.replaceValue">,
  HostRpcError,
  SecretReplaceTarget,
  CapturedHost
> {
  const environmentId = useConfigurationEnvironmentId();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "environment.secrets.replaceValue",
    CapturedHost,
    SecretReplaceTarget
  >({
    client,
    method: "environment.secrets.replaceValue",
    mapVariables: (target) => {
      preflightTeam(environmentId, "environment.secrets.replaceValue");
      return { ...target, value: readValue(), environmentId };
    },
    requiredHostMethodVersion: () =>
      teamFloor(environmentId, "environment.secrets.replaceValue"),
    options: {
      mutationKey: settingsDetailsMutationKeys.secretReplaceValue(),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (answer, _variables, captured) => {
        // Accepted, or changed elsewhere: either way the list moved.
        const outcome = replaceOutcome(answer);
        if (outcome.kind === "accepted" || outcome.reread) {
          rereadSecrets(queryClient, captured.hostId);
        }
      },
    },
  });
}
