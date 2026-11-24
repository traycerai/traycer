import { useMutation, useQueryClient } from "@tanstack/react-query";
import { applyHeldChange } from "@traycer-clients/shared/environment/environment-review";
import type { LocalOverrideTarget } from "@traycer/protocol/host/environment-schemas";
import { usePersonalPageHost } from "@/components/settings/personal/personal-page-context";
import {
  invalidateEnvironmentReads,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import {
  useHostMethodSchemaVersion,
  useHostSupportsMethod,
} from "@/hooks/host/use-host-supports-method";
import { toastFromHostError } from "@/lib/host-error-toast";
import { environmentMutationKeys } from "@/lib/query-keys";
import { withHostMutationErrorBoundary } from "@/lib/query/host-query-error-boundary";
import {
  negotiatedVersionMeetsRequirement,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";

const SAVE_METHOD = "config.env.localOverride.saveToPersonal";
const CLEAR_METHOD = "config.env.localOverride.clear";
const GUARDED_CLEAR = {
  method: CLEAR_METHOD,
  version: { major: 1, minor: 1 },
} as const;

interface OwnValue {
  readonly target: LocalOverrideTarget;
  readonly value: string;
}

export function useSaveOwnValueEverywhere(
  setMethod: "config.env.set" | "providers.setEnvOverride",
  listMethod: "config.env.list" | "providers.list",
  saveLegacy: (entry: OwnValue) => Promise<{ readonly savedLocally?: true }>,
) {
  const { hostId, client } = usePersonalPageHost();
  const queryClient = useQueryClient();
  const cloudSource = useEnvironmentCloud();
  const canSaveToPersonal = useHostSupportsMethod(hostId, SAVE_METHOD);
  const canClear = useHostSupportsMethod(hostId, CLEAR_METHOD);
  const clearVersion = useHostMethodSchemaVersion(hostId, CLEAR_METHOD);
  const setVersion = useHostMethodSchemaVersion(hostId, setMethod);
  const keptSaveMajor = setMethod === "config.env.set" ? 1 : 2;
  const keptSaveMinor = setMethod === "config.env.set" ? 2 : 3;
  const hostSavesLocally =
    setVersion !== null &&
    (setVersion.major > keptSaveMajor ||
      (setVersion.major === keptSaveMajor &&
        setVersion.minor >= keptSaveMinor));
  const exact =
    hostSavesLocally &&
    canSaveToPersonal &&
    negotiatedVersionMeetsRequirement(clearVersion ?? undefined, GUARDED_CLEAR);
  const legacy = canClear && !hostSavesLocally;
  const available = exact || legacy;
  const offer = useHostScopedMutationForClient(client, {
    method: SAVE_METHOD,
    mutationKey: [SAVE_METHOD],
    errorMessage: null,
    requiredHostMethodVersion: () => GUARDED_CLEAR,
    invalidateMethods: [],
  });
  const clear = useHostScopedMutationForClient(client, {
    method: CLEAR_METHOD,
    mutationKey: environmentMutationKeys.localOverrideClear(),
    errorMessage: "Couldn't stop this computer keeping its own value.",
    requiredHostMethodVersion: (request) =>
      request.expectedValue === undefined ? null : GUARDED_CLEAR,
    scope: { id: "config.env.localOverride" },
    invalidateMethods: ["environment.localOverrides", listMethod],
  });
  const publish = useMutation<void, HostRpcError, OwnValue>({
    mutationFn: (entry) =>
      withHostMutationErrorBoundary(SAVE_METHOD, async () => {
        if (!available || client === null || hostId === null)
          throw new Error("Couldn't save the variable.");
        const origin = client.getRequestContext();
        const stillHere = () =>
          client.getActiveHostId() === hostId &&
          client.getRequestContext() === origin;
        if (!exact) {
          const saved = await saveLegacy(entry);
          // A host that upgraded between the manifest read and the save may
          // already keep this edit locally. Only a shared save can release it.
          if (saved.savedLocally !== true && stillHere())
            await clear.mutateAsync({ target: entry.target });
          return;
        }
        const cloud = cloudSource?.() ?? null;
        if (cloud === null) throw new Error("Couldn't save the variable.");
        const receipt = await offer.mutateAsync(entry);
        try {
          if (receipt.reviewRequired || !stillHere() || !cloud.onOriginSignIn())
            return;
          const result = await applyHeldChange(
            cloud,
            receipt.environmentId,
            receipt,
          );
          if (result.outcome !== "applied")
            throw new Error("Couldn't save the variable.");
          if (stillHere() && cloud.onOriginSignIn())
            await clear.mutateAsync({
              target: entry.target,
              expectedValue: entry.value,
            });
        } finally {
          void invalidateEnvironmentReads(queryClient, ["environment.review"]);
        }
      }),
    onError: (error) => {
      if (error.method === SAVE_METHOD)
        toastFromHostError(error, "Couldn't save the variable.");
    },
  });
  return { available, isPending: publish.isPending, mutate: publish.mutate };
}
