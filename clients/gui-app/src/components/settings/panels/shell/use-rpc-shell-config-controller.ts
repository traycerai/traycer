import { useMemo } from "react";
import type { QueryKey } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ConfigShellProbeResponse } from "@traycer/protocol/host/config/index";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { configMutationKeys, queryKeys } from "@/lib/query-keys";
import type {
  ShellConfigController,
  ShellProbeSource,
} from "@/components/settings/panels/shell/shell-config-controller";

/** Detected shells barely change; the picker always accepts a typed path. */
const SHELL_LIST_STALE_MS = Number.POSITIVE_INFINITY;

/**
 * The Shell panel over the selected host's own config RPC.
 *
 * Mounted inside the scope gate, so `useHostClient()` is the SCOPED host's
 * client (the panel re-provides `HostRuntimeContext` for an explicit pick and
 * leaves the ambient binding alone while following the active host). Local and
 * remote hosts run this identical path.
 *
 * Every write invalidates by METHOD scope for the host captured when the
 * mutation was armed (`useHostScopedMutationForClient`), so a host switch
 * mid-flight refreshes the host that was actually written rather than whichever
 * one the picker has landed on by the time the response arrives.
 */
export function useRpcShellConfigController(props: {
  /** `true` while the panel may talk to the host; `false` parks every read. */
  readonly enabled: boolean;
  /** Native file dialog, non-null only when the target machine is this one. */
  readonly pickProgramFile: (() => Promise<string | null>) | null;
}): ShellConfigController {
  // The BINDING rather than `useHostClient()`: this reads the same context the
  // panel re-provides for an explicit pick, but answers `null` instead of
  // throwing when there is no host runtime at all. Every read below is already
  // null-gated, so a shell with no runtime renders the page inert rather than
  // crashing it.
  const client = useHostBinding()?.hostClient ?? null;
  const hostId = client?.getActiveHostId() ?? null;

  const configQuery = useHostQuery<HostRpcRegistry, "config.shell.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "config.shell.get",
    params: {},
    options: { enabled: props.enabled },
  });
  const shellListQuery = useHostQuery<
    HostRpcRegistry,
    "config.shell.listDetected"
  >({
    cacheKeyIdentity: undefined,
    client,
    method: "config.shell.listDetected",
    params: {},
    options: { enabled: props.enabled, staleTime: SHELL_LIST_STALE_MS },
  });
  const envListQuery = useHostQuery<HostRpcRegistry, "config.env.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "config.env.list",
    params: {},
    options: { enabled: props.enabled },
  });

  const setMutation = useHostScopedMutationForClient(client, {
    method: "config.shell.set",
    mutationKey: configMutationKeys.shellSet(),
    errorMessage: "Couldn't update the shell configuration",
    invalidateMethods: ["config.shell.get", "config.shell.listDetected"],
  });
  const resetMutation = useHostScopedMutationForClient(client, {
    method: "config.shell.reset",
    mutationKey: configMutationKeys.shellReset(),
    errorMessage: "Couldn't use the system default shell",
    invalidateMethods: ["config.shell.get", "config.shell.listDetected"],
  });
  const addMutation = useHostScopedMutationForClient(client, {
    method: "config.shell.add",
    mutationKey: configMutationKeys.shellAdd(),
    errorMessage: "Couldn't add that shell",
    invalidateMethods: ["config.shell.get", "config.shell.listDetected"],
  });
  const removeMutation = useHostScopedMutationForClient(client, {
    method: "config.shell.remove",
    mutationKey: configMutationKeys.shellRemove(),
    errorMessage: "Couldn't remove that shell",
    invalidateMethods: ["config.shell.get", "config.shell.listDetected"],
  });
  const revertMutation = useHostScopedMutationForClient(client, {
    method: "config.shell.revertArgs",
    mutationKey: configMutationKeys.shellRevertArgs(),
    errorMessage: "Couldn't restore the default flags",
    invalidateMethods: ["config.shell.get"],
  });
  const envSetMutation = useHostScopedMutationForClient(client, {
    method: "config.env.set",
    mutationKey: configMutationKeys.envSet(),
    errorMessage: "Couldn't save the environment variable",
    invalidateMethods: ["config.env.list"],
  });
  const envDeleteMutation = useHostScopedMutationForClient(client, {
    method: "config.env.delete",
    mutationKey: configMutationKeys.envDelete(),
    errorMessage: "Couldn't remove the environment variable",
    invalidateMethods: ["config.env.list"],
  });

  const probeSource = useMemo(
    (): ShellProbeSource => ({
      queryKeyFor: (path: string): QueryKey =>
        queryKeys.hostMethod<HostRpcRegistry, "config.shell.probe">(
          hostId,
          "config.shell.probe",
          { path },
        ),
      probe: (path: string): Promise<ConfigShellProbeResponse> =>
        probeShellPath(client, path),
      pickProgramFile: props.pickProgramFile,
    }),
    [client, hostId, props.pickProgramFile],
  );

  return {
    config: configQuery.data,
    configError: configQuery.error,
    retryConfig: () => {
      void configQuery.refetch();
      void shellListQuery.refetch();
    },
    shells: shellListQuery.data?.shells ?? [],
    overrides: envListQuery.data?.entries ?? [],
    shellPending:
      setMutation.isPending ||
      resetMutation.isPending ||
      addMutation.isPending ||
      removeMutation.isPending ||
      revertMutation.isPending,
    envPending: envSetMutation.isPending || envDeleteMutation.isPending,
    probeSource,
    setShell: (request, callbacks) => setMutation.mutate(request, callbacks),
    resetShell: (callbacks) => resetMutation.mutate({}, callbacks),
    addShell: (path, callbacks) => addMutation.mutate({ path }, callbacks),
    removeShell: (path, callbacks) =>
      removeMutation.mutate({ path }, callbacks),
    revertShellArgs: (path, callbacks) =>
      revertMutation.mutate({ path }, callbacks),
    setEnv: (entry, callbacks) => envSetMutation.mutate(entry, callbacks),
    deleteEnv: (key, callbacks) => envDeleteMutation.mutate({ key }, callbacks),
  };
}

/**
 * Rejects rather than resolving a fabricated answer when there is no client:
 * the picker's status line reads "not found on this machine" for a `false`
 * probe, and inventing one would tell the user their path is broken when in
 * fact nothing asked.
 */
function probeShellPath(
  client: HostClient<HostRpcRegistry> | null,
  path: string,
): Promise<ConfigShellProbeResponse> {
  if (client === null) {
    return Promise.reject(new Error("No host client to probe the shell path"));
  }
  return client.request("config.shell.probe", { path });
}
