import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import {
  invalidateEnvironmentReads,
  useEnvironmentCloudSender,
} from "@/hooks/environment/use-environment-cloud";
import { useHostMutation } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
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
 * A write that names its environment (a team's, or Personal's) is the app's
 * own call to authn on the person's sign-in. One that names none is the
 * host's own secrets, and stays the host's write.
 */

interface CapturedHost {
  readonly hostId: string | null;
}

/** A saved or rotated value moves the list, its versions and its rotation. */
function rereadSecrets(queryClient: QueryClient, hostId: string | null): void {
  for (const method of SECRET_READS) {
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(
        hostRpcServingTierHostId(
          method,
          hostId,
          readProcessHostRpcTierPlan(),
          null,
        ),
        method,
      ),
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
  const { environmentId } = useAddressedEnvironment();
  const queryClient = useQueryClient();
  const send = useEnvironmentCloudSender();
  const named = useMutation<
    ResponseOfMethod<HostRpcRegistry, "environment.secrets.create">,
    HostRpcError,
    void,
    CapturedHost
  >({
    mutationKey: settingsDetailsMutationKeys.secretCreate(),
    mutationFn: () =>
      send("environment.secrets.create", { ...readRequest(), environmentId }),
    onMutate: () => ({ hostId: null }),
    onSuccess: (outcome) => {
      if (outcome.outcome !== "refused") {
        void invalidateEnvironmentReads(queryClient, SECRET_READS);
      }
    },
  });
  const hostOwn = useHostMutation<
    HostRpcRegistry,
    "environment.secrets.create",
    CapturedHost,
    void
  >({
    client,
    method: "environment.secrets.create",
    mapVariables: () => ({ ...readRequest(), environmentId: null }),
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
  return environmentId === null ? hostOwn : named;
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
  const { environmentId } = useAddressedEnvironment();
  const send = useEnvironmentCloudSender();
  const named = useMutation<
    ResponseOfMethod<HostRpcRegistry, "environment.secrets.verify">,
    HostRpcError
  >({
    mutationKey: settingsDetailsMutationKeys.secretVerifyCandidate(),
    mutationFn: () =>
      send("environment.secrets.verify", { ...readRequest(), environmentId }),
  });
  const hostOwn = useHostMutation<
    HostRpcRegistry,
    "environment.secrets.verify",
    unknown,
    void
  >({
    client,
    method: "environment.secrets.verify",
    mapVariables: () => ({ ...readRequest(), environmentId: null }),
    options: {
      mutationKey: settingsDetailsMutationKeys.secretVerifyCandidate(),
    },
  });
  return environmentId === null ? hostOwn : named;
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
  const { environmentId } = useAddressedEnvironment();
  const queryClient = useQueryClient();
  const send = useEnvironmentCloudSender();
  const named = useMutation<
    ResponseOfMethod<HostRpcRegistry, "environment.secrets.replaceValue">,
    HostRpcError,
    SecretReplaceTarget,
    CapturedHost
  >({
    mutationKey: settingsDetailsMutationKeys.secretReplaceValue(),
    mutationFn: (target) =>
      send("environment.secrets.replaceValue", {
        ...target,
        value: readValue(),
        environmentId,
      }),
    onMutate: () => ({ hostId: null }),
    onSuccess: (answer) => {
      // Accepted, or changed elsewhere: either way the list moved.
      const outcome = replaceOutcome(answer);
      if (outcome.kind === "accepted" || outcome.reread) {
        void invalidateEnvironmentReads(queryClient, SECRET_READS);
      }
    },
  });
  const hostOwn = useHostMutation<
    HostRpcRegistry,
    "environment.secrets.replaceValue",
    CapturedHost,
    SecretReplaceTarget
  >({
    client,
    method: "environment.secrets.replaceValue",
    mapVariables: (target) => ({
      ...target,
      value: readValue(),
      environmentId: null,
    }),
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
  return environmentId === null ? hostOwn : named;
}
