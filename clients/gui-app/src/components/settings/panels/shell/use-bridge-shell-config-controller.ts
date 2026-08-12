import { useMemo } from "react";
import type { QueryKey } from "@tanstack/react-query";
import type {
  ConfigShellProbeResponse,
  ConfigShellSetRequest,
} from "@traycer/protocol/host/config/index";
import type { ITraycerCli } from "@traycer-clients/shared/platform/runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";
import { useRunnerTraycerEnvOverrideDeleteMutation } from "@/hooks/runner/use-runner-traycer-env-override-delete-mutation";
import { useRunnerTraycerEnvOverrideListQuery } from "@/hooks/runner/use-runner-traycer-env-override-list-query";
import { useRunnerTraycerEnvOverrideSetMutation } from "@/hooks/runner/use-runner-traycer-env-override-set-mutation";
import { useRunnerTraycerShellConfigAddMutation } from "@/hooks/runner/use-runner-traycer-shell-add-mutation";
import { useRunnerTraycerShellConfigQuery } from "@/hooks/runner/use-runner-traycer-shell-config-query";
import { useRunnerTraycerShellConfigRemoveMutation } from "@/hooks/runner/use-runner-traycer-shell-remove-mutation";
import { useRunnerTraycerShellConfigResetMutation } from "@/hooks/runner/use-runner-traycer-shell-config-reset-mutation";
import { useRunnerTraycerShellConfigSetMutation } from "@/hooks/runner/use-runner-traycer-shell-config-set-mutation";
import { useRunnerTraycerShellRevertArgsMutation } from "@/hooks/runner/use-runner-traycer-shell-revert-args-mutation";
import { useRunnerTraycerShellListQuery } from "@/hooks/runner/use-runner-traycer-shell-list-query";
import type {
  ShellConfigController,
  ShellProbeSource,
} from "@/components/settings/panels/shell/shell-config-controller";

/**
 * "Add a shell" validation through the local CLI bridge: this machine's fs,
 * this machine's file dialog, keyed by the bridge instance so it can never
 * share a cache slot with a per-host RPC probe of the same path.
 */
export function bridgeShellProbeSource(
  traycerCli: ITraycerCli,
): ShellProbeSource {
  return {
    queryKeyFor: (path: string): QueryKey =>
      runnerQueryKeys.traycerShellProbe(traycerCli, path),
    // The bridge crosses an IPC channel with no cancellation of its own, so
    // the signal is accepted and dropped. Keeping the parameter means the two
    // sources stay interchangeable behind one query-options builder.
    probe: (
      path: string,
      _signal: AbortSignal | undefined,
    ): Promise<ConfigShellProbeResponse> => traycerCli.shellProbe({ path }),
    // This machine's dialog naming this machine's paths: the fallback only
    // ever describes the local host, so the native picker stays offered.
    pickProgramFile: traycerCli.pickShellProgramFile,
  };
}

/**
 * The Shell panel over the local CLI bridge — the local-host fallback.
 *
 * Every hook here predates the config RPC and is unchanged; this only adapts
 * them to the shared controller so the panel renders one editor either way. It
 * is mounted ONLY where `localConfigFallbackReason` says so — this computer's
 * host, stopped or predating the methods — and there the on-disk store the CLI
 * reads is the very config that host loads.
 */
export function useBridgeShellConfigController(props: {
  readonly traycerCli: ITraycerCli;
}): ShellConfigController {
  const { traycerCli } = props;
  const configQuery = useRunnerTraycerShellConfigQuery();
  const shellListQuery = useRunnerTraycerShellListQuery();
  const envListQuery = useRunnerTraycerEnvOverrideListQuery();
  const setMutation = useRunnerTraycerShellConfigSetMutation();
  const resetMutation = useRunnerTraycerShellConfigResetMutation();
  const addMutation = useRunnerTraycerShellConfigAddMutation();
  const removeMutation = useRunnerTraycerShellConfigRemoveMutation();
  const revertMutation = useRunnerTraycerShellRevertArgsMutation();
  const envSetMutation = useRunnerTraycerEnvOverrideSetMutation();
  const envDeleteMutation = useRunnerTraycerEnvOverrideDeleteMutation();

  const probeSource = useMemo(
    () => bridgeShellProbeSource(traycerCli),
    [traycerCli],
  );

  return {
    config: configQuery.data,
    // The bridge reads the on-disk store directly, so there is no transport to
    // fail the way a host RPC can. Its errors surface through the runner's own
    // toasts; the panel's read-failed arm is for the RPC path.
    configError: null,
    retryConfig: () => {
      void configQuery.refetch();
    },
    shells: shellListQuery.data ?? [],
    overrides: envListQuery.data ?? [],
    shellPending:
      setMutation.isPending ||
      resetMutation.isPending ||
      addMutation.isPending ||
      removeMutation.isPending ||
      revertMutation.isPending,
    envPending: envSetMutation.isPending || envDeleteMutation.isPending,
    probeSource,
    setShell: (request: ConfigShellSetRequest, callbacks) =>
      setMutation.mutate({ path: request.path, args: request.args }, callbacks),
    resetShell: (callbacks) => resetMutation.mutate(undefined, callbacks),
    addShell: (path, callbacks) => addMutation.mutate({ path }, callbacks),
    removeShell: (path, callbacks) =>
      removeMutation.mutate({ path }, callbacks),
    revertShellArgs: (path, callbacks) =>
      revertMutation.mutate({ path }, callbacks),
    setEnv: (entry, callbacks) => envSetMutation.mutate(entry, callbacks),
    // The bridge writes the on-disk store through one IPC channel per call,
    // so there is no cross-observer boundary to lose the delete at the way the
    // RPC path had - but the sequencing still belongs here rather than at the
    // call site, so both controllers expose the same one-shot verb.
    renameEnv: (rename, callbacks) => {
      envSetMutation.mutate(
        { key: rename.newKey, value: rename.value },
        {
          onSuccess: () => {
            if (rename.oldKey.length === 0) {
              callbacks.onSuccess();
              return;
            }
            envDeleteMutation.mutate({ key: rename.oldKey }, callbacks);
          },
          onError: callbacks.onError,
        },
      );
    },
    deleteEnv: (key, callbacks) => envDeleteMutation.mutate({ key }, callbacks),
  };
}
