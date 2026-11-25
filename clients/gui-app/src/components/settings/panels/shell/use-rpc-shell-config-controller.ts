import { useContext, useMemo } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  toHostRpcError,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { toastFromHostError } from "@/lib/host-error-toast";
import type { ConfigShellProbeResponse } from "@traycer/protocol/host/config/index";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import {
  useHostQuery,
  useHostQueryEntryHash,
} from "@/hooks/host/use-host-query";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { EnvironmentLocalOverridesResponse } from "@traycer/protocol/host/environment-schemas";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { configMutationKeys, queryKeys } from "@/lib/query-keys";
import type {
  ShellConfigController,
  ShellCommandCallbacks,
  ShellProbeSource,
} from "@/components/settings/panels/shell/shell-config-controller";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { waitForShellEnvRead } from "@/components/settings/panels/shell/wait-for-shell-env-read";
import {
  shellAddSelection,
  shellRemoveSelection,
  shellRevertSelection,
  shellSetSelection,
} from "@/components/settings/panels/shell/shell-save-selection";
import { usePressCapturedMutation } from "@/hooks/use-press-captured-mutation";
import {
  captureSettingsSaveOrigin,
  type SettingsSaveOrigin,
} from "@/lib/environment/settings-save-origin";
import type { SettingsSave } from "@traycer/protocol/host/environment/settings-save-mapping";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import {
  useSettingsSave,
  type PrepareSettingsSave,
} from "@/hooks/environment/use-settings-save";
import {
  everyAnswerProposes,
  sendFollowedSave,
  requestFollowedSettingsSave,
  type PendingSettingsSave,
} from "@/lib/environment/settings-save-follow";

interface PressedEnvRename {
  readonly prepare: PrepareSettingsSave;
  readonly origin: SettingsSaveOrigin;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
}

/**
 * Detected shells barely change; the picker always accepts a typed path. The
 * list stays never-stale, but every panel visit refetches (`refetchOnMount:
 * "always"` below) because one thing on it CAN change mid-session: the
 * `wslHealth` annotation, which flips when the user installs WSL and comes
 * back. The explicit "re-detect" control covers changes while the panel is
 * already open.
 */
const SHELL_LIST_STALE_MS = Number.POSITIVE_INFINITY;

const SAVED_KINDS = ["shell", "variable"] as const;
const CLEAR_LOCAL_OVERRIDE = "config.env.localOverride.clear";
const READ_LOCAL_OVERRIDES = "environment.localOverrides" as const;
const REMOVE_VARIABLE_ERROR = "Couldn't remove the variable";

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
  const hostId = useRequesterHostId(client);

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
    options: {
      enabled: props.enabled,
      staleTime: SHELL_LIST_STALE_MS,
      refetchOnMount: "always",
    },
  });
  const envListQuery = useHostQuery<HostRpcRegistry, "config.env.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "config.env.list",
    params: {},
    options: { enabled: props.enabled },
  });

  const {
    clearSupport,
    legacyDelete,
    canReadKeptVariables,
    localOverrideQueryHash,
    keptOverrides,
    envDeleteDisabled,
  } = useVariableRemoveAuthority(client, hostId, props.enabled);

  const prepareSave = useSettingsSave(client, SAVED_KINDS);

  const cloudSource = useEnvironmentCloud();
  const setMutation = useHostScopedMutationForClient(client, {
    method: "config.shell.set",
    followSettingsSave: {
      source: cloudSource,
      follow: (request, sentOn, pressedOn) =>
        prepareSave(
          { method: "config.shell.set", request },
          sentOn.getActiveHostId(),
          pressedOn,
        ),
      proposes: everyAnswerProposes,
    },
    mutationKey: configMutationKeys.shellSet(),
    errorMessage: "Couldn't update the shell configuration",
    invalidateMethods: ["config.shell.get", "config.shell.listDetected"],
  });
  const resetMutation = useHostScopedMutationForClient(client, {
    method: "config.shell.reset",
    followSettingsSave: {
      source: cloudSource,
      follow: (request, sentOn, pressedOn) =>
        prepareSave(
          { method: "config.shell.reset", request },
          sentOn.getActiveHostId(),
          pressedOn,
        ),
      proposes: everyAnswerProposes,
    },
    mutationKey: configMutationKeys.shellReset(),
    errorMessage: "Couldn't use the system default shell",
    invalidateMethods: ["config.shell.get", "config.shell.listDetected"],
  });
  const addMutation = useHostScopedMutationForClient(client, {
    method: "config.shell.add",
    followSettingsSave: {
      source: cloudSource,
      follow: (request, sentOn, pressedOn) =>
        prepareSave(
          { method: "config.shell.add", request },
          sentOn.getActiveHostId(),
          pressedOn,
        ),
      proposes: everyAnswerProposes,
    },
    mutationKey: configMutationKeys.shellAdd(),
    errorMessage: "Couldn't add that shell",
    invalidateMethods: ["config.shell.get", "config.shell.listDetected"],
  });
  const removeMutation = useHostScopedMutationForClient(client, {
    method: "config.shell.remove",
    followSettingsSave: {
      source: cloudSource,
      follow: (request, sentOn, pressedOn) =>
        prepareSave(
          { method: "config.shell.remove", request },
          sentOn.getActiveHostId(),
          pressedOn,
        ),
      proposes: everyAnswerProposes,
    },
    mutationKey: configMutationKeys.shellRemove(),
    errorMessage: "Couldn't remove that shell",
    invalidateMethods: ["config.shell.get", "config.shell.listDetected"],
  });
  const revertMutation = useHostScopedMutationForClient(client, {
    method: "config.shell.revertArgs",
    followSettingsSave: {
      source: cloudSource,
      follow: (request, sentOn, pressedOn) =>
        prepareSave(
          { method: "config.shell.revertArgs", request },
          sentOn.getActiveHostId(),
          pressedOn,
        ),
      proposes: everyAnswerProposes,
    },
    mutationKey: configMutationKeys.shellRevertArgs(),
    errorMessage: "Couldn't restore the default flags",
    invalidateMethods: ["config.shell.get"],
  });
  const queryClient = useQueryClient();
  const envSetMutation = useHostScopedMutationForClient(client, {
    method: "config.env.set",
    followSettingsSave: {
      source: cloudSource,
      follow: (request, sentOn, pressedOn) =>
        prepareSave(
          { method: "config.env.set", request },
          sentOn.getActiveHostId(),
          pressedOn,
        ),
      proposes: (answer) => answer.savedLocally !== true,
    },
    mutationKey: configMutationKeys.envSet(),
    errorMessage: "Couldn't save the variable",
    invalidateMethods: ["config.env.list", "environment.localOverrides"],
  });
  const envDeleteMutation = useHostScopedMutationForClient(client, {
    method: "config.env.delete",
    followSettingsSave: {
      source: cloudSource,
      follow: (request, sentOn, pressedOn) =>
        prepareSave(
          { method: "config.env.delete", request },
          sentOn.getActiveHostId(),
          pressedOn,
        ),
      proposes: (answer) => answer.savedLocally !== true,
    },
    mutationKey: configMutationKeys.envDelete(),
    errorMessage: REMOVE_VARIABLE_ERROR,
    invalidateMethods: ["config.env.list", "environment.localOverrides"],
  });
  const clearLocalOverride = useHostScopedMutationForClient(client, {
    method: CLEAR_LOCAL_OVERRIDE,
    mutationKey: [CLEAR_LOCAL_OVERRIDE],
    errorMessage: REMOVE_VARIABLE_ERROR,
    scope: { id: "config.env.localOverride" },
    invalidateMethods: ["config.env.list", READ_LOCAL_OVERRIDES],
  });

  // Both host writes use one press's editor, sign-in classification and client.
  const envRenameMutation = usePressCapturedMutation<
    void,
    HostRpcError,
    {
      readonly oldKey: string;
      readonly newKey: string;
      readonly value: string | null;
    },
    PressedEnvRename,
    { readonly hostId: string | null }
  >(
    () => ({
      prepare: prepareSave,
      origin: captureSettingsSaveOrigin(cloudSource),
      client,
      hostId: client?.getActiveHostId() ?? null,
    }),
    {
      mutationKey: configMutationKeys.envRename(),
      mutationFn: async (rename, pressed) => {
        const { client: pressedClient, hostId: sentOn } = pressed;
        if (pressedClient === null) {
          // Normalized so `onError` always receives the `HostRpcError` shape the
          // toast helper reads, rather than a bare `Error` it cannot classify.
          throw toHostRpcError(
            new Error("No host client to rename the environment variable"),
            "config.env.set",
          );
        }
        const prepare = (save: SettingsSave): Promise<PendingSettingsSave> =>
          pressed.prepare(save, sentOn, pressed.origin);
        const set = {
          key: rename.newKey,
          value: rename.value,
        };
        await sendFollowedSave(
          await prepare({ method: "config.env.set", request: set }),
          (requestId) =>
            requestFollowedSettingsSave(
              pressedClient,
              "config.env.set",
              set,
              requestId,
            ),
          (answer) => answer.savedLocally !== true,
        );
        if (rename.oldKey.length === 0) return;
        const remove = { key: rename.oldKey };
        await sendFollowedSave(
          await prepare({ method: "config.env.delete", request: remove }),
          (requestId) =>
            requestFollowedSettingsSave(
              pressedClient,
              "config.env.delete",
              remove,
              requestId,
            ),
          (answer) => answer.savedLocally !== true,
        );
      },
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      // SETTLED, not success - the same two-write staleness the bridge twin has:
      // a set that lands followed by a delete that rejects leaves both keys on
      // the host with the editor showing the pre-rename list.
      onSettled: (_data, _error, _variables, context) => {
        const hostId = context?.hostId ?? null;
        if (hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: queryKeys.hostMethodScope(hostId, "config.env.list"),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.hostMethodScope(
            hostId,
            "environment.localOverrides",
          ),
        });
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't rename the variable");
      },
    },
  );

  const probeSource = useMemo(
    (): ShellProbeSource => ({
      queryKeyFor: (path: string): QueryKey =>
        queryKeys.hostMethod<HostRpcRegistry, "config.shell.probe">(
          hostId,
          "config.shell.probe",
          { path },
        ),
      probe: (
        path: string,
        signal: AbortSignal | undefined,
      ): Promise<ConfigShellProbeResponse> =>
        probeShellPath(client, path, signal),
      pickProgramFile: props.pickProgramFile,
    }),
    [client, hostId, props.pickProgramFile],
  );

  // Invalidation starts the post-write read; success means that read has also
  // finished, including when structural sharing retains the original array.
  const afterEnvRead = (
    callbacks: ShellCommandCallbacks,
  ): ShellCommandCallbacks => ({
    onSuccess: () => {
      void waitForShellEnvRead(
        queryClient,
        queryKeys.hostMethodScope(hostId, "config.env.list"),
      ).then(callbacks.onSuccess, callbacks.onError);
    },
    onError: callbacks.onError,
  });

  const removeKeptVariable = (
    key: string,
    callbacks: ShellCommandCallbacks,
  ): void => {
    clearLocalOverride.mutate(
      { target: { kind: "variable", key } },
      {
        onSuccess: (answer) => {
          if (answer.outcome !== "saved") {
            callbacks.onError(new Error(REMOVE_VARIABLE_ERROR));
            return;
          }
          void Promise.all([
            waitForShellEnvRead(
              queryClient,
              queryKeys.hostMethodScope(hostId, "config.env.list"),
            ),
            waitForShellEnvRead(
              queryClient,
              queryKeys.hostMethodScope(hostId, READ_LOCAL_OVERRIDES),
            ),
          ]).then(callbacks.onSuccess, callbacks.onError);
        },
        onError: callbacks.onError,
      },
    );
  };

  const deleteEnv = (key: string, callbacks: ShellCommandCallbacks): void => {
    // A read can be invalidated between painting the button and the press.
    const state = queryClient
      .getQueryCache()
      .get<EnvironmentLocalOverridesResponse>(localOverrideQueryHash)?.state;
    if (
      !legacyDelete &&
      (!canReadKeptVariables ||
        state?.status !== "success" ||
        state.fetchStatus !== "idle" ||
        state.isInvalidated ||
        state.data === undefined)
    ) {
      callbacks.onError(new Error(REMOVE_VARIABLE_ERROR));
      return;
    }
    if (keepsVariable(state?.data?.overrides ?? keptOverrides, key)) {
      if (clearSupport === true) removeKeptVariable(key, callbacks);
      else callbacks.onError(new Error(REMOVE_VARIABLE_ERROR));
      return;
    }
    envDeleteMutation.mutate({ key }, afterEnvRead(callbacks));
  };

  return {
    config: configQuery.data,
    configError: configQuery.error ?? envListQuery.error,
    retryConfig: () => {
      void configQuery.refetch();
      void shellListQuery.refetch();
      void envListQuery.refetch();
    },
    shells: shellListQuery.data?.shells ?? [],
    refreshShells: () => {
      void shellListQuery.refetch();
    },
    shellsRefreshing: shellListQuery.isFetching,
    overrides: envListQuery.data?.entries ?? [],
    shellPending:
      setMutation.isPending ||
      resetMutation.isPending ||
      addMutation.isPending ||
      removeMutation.isPending ||
      revertMutation.isPending,
    envPending:
      envListQuery.data === undefined ||
      envListQuery.isError ||
      [
        envSetMutation,
        envDeleteMutation,
        clearLocalOverride,
        envRenameMutation,
      ].some(({ isPending }) => isPending),
    envDeleteDisabled,
    canRemoveEnv: (key) =>
      clearSupport !== false || !keepsVariable(keptOverrides, key),
    probeSource,
    setShell: (request, callbacks) =>
      setMutation.mutate(
        {
          ...request,
          selection: shellSetSelection(request, configQuery.data),
        },
        callbacks,
      ),
    resetShell: (callbacks) => resetMutation.mutate({}, callbacks),
    addShell: (path, callbacks) =>
      addMutation.mutate(
        {
          path,
          selection: shellAddSelection(path),
        },
        callbacks,
      ),
    removeShell: (path, callbacks) =>
      removeMutation.mutate(
        {
          path,
          selection: shellRemoveSelection(path, configQuery.data),
        },
        callbacks,
      ),
    revertShellArgs: (path, callbacks) =>
      revertMutation.mutate(
        {
          path,
          selection: shellRevertSelection(path, configQuery.data),
        },
        callbacks,
      ),
    setEnv: (entry, callbacks) =>
      envSetMutation.mutate(entry, afterEnvRead(callbacks)),
    setEnvAsync: (entry) => envSetMutation.mutateAsync(entry),
    deleteEnv,
    renameEnv: (rename, callbacks) =>
      envRenameMutation.mutate(rename, afterEnvRead(callbacks)),
  };
}

function useVariableRemoveAuthority(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
) {
  const clearSupport = useHostMethodSupport(hostId, CLEAR_LOCAL_OVERRIDE);
  const localOverridesSupport = useHostMethodSupport(
    hostId,
    READ_LOCAL_OVERRIDES,
  );
  const personalPage = useContext(PersonalPageContext);
  const localOverrideArgs = {
    cacheKeyIdentity: undefined,
    client,
    method: READ_LOCAL_OVERRIDES,
    params: {},
  };
  const legacyDelete =
    clearSupport === false && localOverridesSupport === false;
  const canReadKeptVariables =
    clearSupport !== null && localOverridesSupport === true;
  const localOverrideQuery = useHostQuery<
    HostRpcRegistry,
    typeof READ_LOCAL_OVERRIDES
  >({
    ...localOverrideArgs,
    options: { enabled: enabled && localOverridesSupport === true },
  });
  const localOverrideQueryHash = useHostQueryEntryHash(localOverrideArgs);
  const keptOverrides =
    localOverrideQuery.data?.overrides ??
    (personalPage?.hostId === hostId ? personalPage.localOverrides : undefined);
  const envDeleteDisabled =
    !legacyDelete &&
    (!canReadKeptVariables ||
      !localOverrideQuery.isSuccess ||
      localOverrideQuery.fetchStatus !== "idle");

  return {
    clearSupport,
    legacyDelete,
    canReadKeptVariables,
    localOverrideQueryHash,
    keptOverrides,
    envDeleteDisabled,
  };
}

function keepsVariable(
  overrides:
    | Readonly<EnvironmentLocalOverridesResponse["overrides"]>
    | undefined,
  key: string,
): boolean {
  return (
    overrides?.some(
      ({ target }) => target.kind === "variable" && target.key === key,
    ) ?? false
  );
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
  signal: AbortSignal | undefined,
): Promise<ConfigShellProbeResponse> {
  if (client === null) {
    return Promise.reject(new Error("No host client to probe the shell path"));
  }
  // `requestWithSignal`, not `request` - the latter hardcodes `undefined` and
  // the probe is exactly the read TanStack cancels most: a new keystroke, a
  // closed popover, or a host swap retires the query while its RPC is still
  // outstanding.
  return client.requestWithSignal("config.shell.probe", { path }, signal);
}
