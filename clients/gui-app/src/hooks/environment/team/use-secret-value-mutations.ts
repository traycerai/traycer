import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  invalidateEnvironmentReads,
  useEnvironmentCloudOperation,
} from "@/hooks/environment/use-environment-cloud";
import { useSecretsEnvironment } from "@/hooks/environment/use-environment-secrets-calls";
import type { HostRpcRegistry } from "@/lib/host";
import { SECRET_READS } from "@/lib/environment/delta-fed-reads";
import { settingsDetailsMutationKeys } from "@/lib/query-keys/settings-details-query-keys";
import { replaceOutcome } from "@/lib/sandboxes/secret-replace-outcome";

/**
 * The writes that carry a typed secret value: Add a secret's Verify and Save,
 * and Replace value. Each takes a reader the dialog fills, called at
 * dispatch, so the value never becomes the mutation's variables and reaches
 * no query or mutation cache.
 *
 * Each is the app's own call to authn on the person's sign-in, naming the
 * environment the page's secrets calls name (`useSecretsEnvironment`). Its
 * operation begins when the mutation runs, which is the press: these writes
 * take no `scope`, and a mutation never pauses.
 */

interface CapturedHost {
  readonly hostId: string | null;
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
  const { environmentId } = useSecretsEnvironment(client);
  const queryClient = useQueryClient();
  const begin = useEnvironmentCloudOperation();
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, "environment.secrets.create">,
    HostRpcError,
    void,
    CapturedHost
  >({
    mutationKey: settingsDetailsMutationKeys.secretCreate(),
    mutationFn: () =>
      begin()("environment.secrets.create", {
        ...readRequest(),
        environmentId,
      }),
    onMutate: () => ({ hostId: null }),
    onSuccess: (outcome) => {
      if (outcome.outcome !== "refused") {
        void invalidateEnvironmentReads(queryClient, SECRET_READS);
      }
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
  const { environmentId } = useSecretsEnvironment(client);
  const begin = useEnvironmentCloudOperation();
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, "environment.secrets.verify">,
    HostRpcError
  >({
    mutationKey: settingsDetailsMutationKeys.secretVerifyCandidate(),
    mutationFn: () =>
      begin()("environment.secrets.verify", {
        ...readRequest(),
        environmentId,
      }),
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
  const { environmentId } = useSecretsEnvironment(client);
  const queryClient = useQueryClient();
  const begin = useEnvironmentCloudOperation();
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, "environment.secrets.replaceValue">,
    HostRpcError,
    SecretReplaceTarget,
    CapturedHost
  >({
    mutationKey: settingsDetailsMutationKeys.secretReplaceValue(),
    mutationFn: (target) =>
      begin()("environment.secrets.replaceValue", {
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
}
