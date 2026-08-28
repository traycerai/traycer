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

/**
 * The on-device model is being readied (engine present but not yet usable): the
 * composer shows a "preparing" indicator instead of silently nothing.
 */
export interface DictationPreparingStatus {
  readonly downloadState: "absent" | "downloading" | "ready" | "error";
  // 0..1 while downloading, else null.
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

/**
 * Dictation readiness: polls `speech.getModelStatus`, silently kicks off
 * `speech.ensureModel` when the model is absent, and reports a usable/preparing
 * status. Composers gate the mic button + shortcut on `ready` (so dictation is
 * never offered, and the OS mic prompt never fires, before the on-device model
 * exists) and surface `preparing` as a status indicator while it downloads.
 *
 * DELIBERATELY the app-wide host (`useHostClient()`), not the composer's target
 * host - the documented exception to the composer host-scope rule in
 * `AGENTS.md`. Dictation describes the person at the keyboard, not the run:
 * `speech.dictate` streams live microphone audio and `speech.ensureModel`
 * downloads an on-device model, so following a remote run target would ship a
 * user's audio to a machine they only picked to execute a turn on, and drop a
 * model download there. The accepted cost is that a composer pinned to another
 * host gates its mic on the app-wide host's model rather than that host's. Do
 * not "fix" this by threading a target client through - it is a change to where
 * a user's voice goes, and wants that conversation first.
 */
export function useDictationAvailability(
  enabled: boolean,
): DictationAvailability {
  // The installed mobile app never offers dictation, whatever the setting says.
  // Dictation is HOST-executed: `speech.dictate` streams live microphone audio
  // to the app-wide host (see above) and that host's on-device engine
  // transcribes it. On desktop the app-wide host is the same machine, which is
  // what Settings' "audio never leaves your machine" promise rests on. The
  // mobile app has no local host - every host it can reach is a remote machine
  // - so offering the mic there would stream phone microphone audio off the
  // device and break that promise. Hence the gate is on the BUILD
  // (`isMobileApp()`) and not on viewport width: a phone-width desktop browser
  // can still be talking to an honest localhost host, and keeps its mic.
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

  // Self-heal: if the engine can run but the model isn't present (or a prior
  // download errored), download it - no UI, the mic simply appears once ready.
  // Don't download where the engine is unavailable (e.g. a build without the
  // sherpa addon). Capped retries so a persistent failure can't loop.
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
