import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostQuery, useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { isMobileApp } from "@/lib/mobile-app";
import { hostQueryKeys, speechMutationKeys } from "@/lib/query-keys";

// `modelId: null` selects the host's default dictation model.
const SPEECH_MODEL_PARAMS = { modelId: null };
// Cap auto-download attempts so a persistently failing download (bad network /
// disk) doesn't loop forever; resets once the model becomes ready.
const MAX_ENSURE_ATTEMPTS = 3;

interface EnsureModelMutationContext {
  readonly hostId: string | null;
}

/** The on-device model is being readied (engine present but not yet usable): the composer shows a "preparing" indicator instead of silently nothing. */
export interface DictationPreparingStatus {
  readonly downloadState: "absent" | "downloading" | "ready" | "error";
  readonly progress: number | null;
}

export interface DictationAvailability {
  // Engine present AND model installed - dictation is usable now.
  readonly ready: boolean;
  // Non-null while the engine is present but the model is still downloading /
  // absent / errored, so the UI can show a status indicator. Null when ready, or
  // when dictation is off/unsupported (no engine) and nothing should show.
  readonly preparing: DictationPreparingStatus | null;
}

/** Dictation readiness on the app-wide host (`useHostClient()`), never the composer's target.
 * `speech.dictate` streams microphone audio; a remote run target must not receive it. */
export function useDictationAvailability(
  enabled: boolean,
): DictationAvailability {
  // Installed mobile app never offers dictation: every reachable host is remote, so mic audio would leave the device. Gate is `isMobileApp()`, not viewport width.
  const available = enabled && !isMobileApp();
  const client = useHostClient();
  const queryClient = useQueryClient();

  const statusQuery = useHostQuery<HostRpcRegistry, "speech.getModelStatus">({
    cacheKeyIdentity: undefined,
    client,
    method: "speech.getModelStatus",
    params: SPEECH_MODEL_PARAMS,
    options: {
      enabled: available,
    },
  });

  const ensureMutation = useHostMutation<
    HostRpcRegistry,
    "speech.ensureModel",
    EnsureModelMutationContext
  >({
    client,
    method: "speech.ensureModel",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: speechMutationKeys.ensureModel(),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_result, _variables, context) => {
        if (context.hostId !== null) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.method<
              HostRpcRegistry,
              "speech.getModelStatus"
            >(context.hostId, "speech.getModelStatus", SPEECH_MODEL_PARAMS),
          });
        }
      },
    },
  });

  // Capped retries so a persistent failure can't loop. a build without the sherpa addon).
  const engineAvailable = statusQuery.data?.engineAvailable ?? false;
  const downloadState = statusQuery.data?.downloadState ?? null;
  const downloadProgress = statusQuery.data?.downloadProgress ?? null;
  const ensure = ensureMutation.mutate;
  const ensurePending = ensureMutation.isPending;
  const activeHostId = client.getActiveHostId();
  // The attempt budget is per-host: a different host has its own model on
  // disk, so switching hosts must reset it (otherwise host A exhausting the
  // budget would permanently disable auto-ensure for host B).
  const attemptsRef = useRef(0);
  const budgetHostRef = useRef(activeHostId);
  useEffect(() => {
    if (budgetHostRef.current !== activeHostId) {
      budgetHostRef.current = activeHostId;
      attemptsRef.current = 0;
    }
    if (!available || !engineAvailable) return;
    if (downloadState === "ready") {
      attemptsRef.current = 0;
      return;
    }
    if (downloadState === "downloading" || ensurePending) return;
    if (
      (downloadState === "absent" || downloadState === "error") &&
      attemptsRef.current < MAX_ENSURE_ATTEMPTS
    ) {
      attemptsRef.current += 1;
      ensure(SPEECH_MODEL_PARAMS);
    }
  }, [
    available,
    engineAvailable,
    downloadState,
    ensurePending,
    ensure,
    activeHostId,
  ]);

  if (!available || !engineAvailable) return { ready: false, preparing: null };
  if (downloadState === "ready") return { ready: true, preparing: null };
  // Engine present, model not ready yet → surface a preparing indicator.
  return {
    ready: false,
    preparing: {
      downloadState: downloadState ?? "absent",
      progress: downloadProgress,
    },
  };
}
