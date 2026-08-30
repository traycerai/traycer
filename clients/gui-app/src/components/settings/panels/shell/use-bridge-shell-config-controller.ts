import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type {
  ConfigShellProbeResponse,
  ConfigShellSetRequest,
} from "@traycer/protocol/host/config/index";
import type { ITraycerCli } from "@traycer-clients/shared/platform/runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
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
  const queryClient = useQueryClient();

  // Both writes inside ONE `mutationFn`, for the same reason the RPC path does
  // it: the boundary that loses the second half is the OBSERVER, not the
  // transport. Chained onto the set's per-`mutate` `onSuccess` - as this did -
  // closing Settings while the set was in flight dropped the callback, so the
  // old key was never removed and one rename left two live variables. That the
  // bridge speaks IPC rather than RPC changes nothing about it.
  const envRenameMutation = useMutation<
    void,
    Error,
    {
      readonly oldKey: string;
      readonly newKey: string;
      readonly value: string | null;
    }
  >({
    mutationKey: runnerMutationKeys.traycerEnvOverrideRename(),
    mutationFn: async (rename) => {
      await traycerCli.envOverrideSet({
        key: rename.newKey,
        value: rename.value,
      });
      // Create first, then drop, so a failed delete leaves a harmless duplicate
      // rather than a lost value.
      if (rename.oldKey.length === 0) return;
      await traycerCli.envOverrideDelete({ key: rename.oldKey });
    },
    // SETTLED, not success. A rename is two writes: if the set lands and the
    // delete rejects, the store now holds BOTH keys while the editor still
    // shows neither change - invalidating only on success leaves that stale
    // view sitting over a config the host will actually read.
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerEnvOverrideList(traycerCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to rename env override");
    },
  });

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
    refreshShells: () => {
      void shellListQuery.refetch();
    },
    shellsRefreshing: shellListQuery.isFetching,
    overrides: envListQuery.data ?? [],
    shellPending:
      setMutation.isPending ||
      resetMutation.isPending ||
      addMutation.isPending ||
      removeMutation.isPending ||
      revertMutation.isPending,
    envPending:
      envSetMutation.isPending ||
      envDeleteMutation.isPending ||
      envRenameMutation.isPending,
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
    renameEnv: (rename, callbacks) =>
      envRenameMutation.mutate(rename, callbacks),
    deleteEnv: (key, callbacks) => envDeleteMutation.mutate({ key }, callbacks),
  };
}
