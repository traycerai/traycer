import { useMemo } from "react";
import type { LogLevel } from "@traycer/protocol/config/log-level";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { APP_DIAGNOSTICS } from "@/components/settings/panels/app-diagnostics-settings.definitions";
import { HOST_DIAGNOSTICS } from "@/components/settings/panels/diagnostics-settings.definitions";
import type { HostRpcRegistry } from "@/lib/host";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useRunnerLogLevelsQuery } from "@/hooks/runner/use-runner-log-levels-query";
import { useRunnerLogLevelsSet } from "@/hooks/runner/use-runner-log-levels-set-mutation";
import { configMutationKeys } from "@/lib/query-keys";
import {
  getLogLevelsBridge,
  selectScopeLevel,
  type LogLevelScope,
} from "@/lib/desktop-log-levels";

/**
 * One log threshold, with whatever is answering for it already resolved.
 *
 * Log detail is the page's mixed-scope card and always has been: `desktop` is
 * THIS window's own verbosity wherever it points, while `cli` and `host` are
 * machine-user-global fields of the selected host's config store. Since the
 * config RPC landed those two are read and written over that host's own wire,
 * and `desktop` stays on the local Electron bridge — so the row list is no
 * longer one source with a flag, but a list of controls that each know their
 * own transport. The group renders them uniformly and the reset-all sweep
 * walks them without caring which is which.
 */
export interface LogLevelControl {
  readonly scope: LogLevelScope;
  /** The row's label and description, from the page the control belongs to. */
  readonly row: SettingsRowDefinition;
  /** `undefined` until the level has loaded. */
  readonly level: LogLevel | undefined;
  /** This control's own transport is loading, failed, or writing. */
  readonly busy: boolean;
  /** Rejects on failure; each transport has already toasted its own error. */
  readonly set: (level: LogLevel) => Promise<void>;
}

/**
 * The `desktop` row: this window's threshold, always local, offered for every
 * scope the page can be in — including a remote or unreachable host, because
 * its subject never changes with the picker.
 */
export function useDesktopLogLevelControl(): LogLevelControl {
  const query = useRunnerLogLevelsQuery();
  const setMutation = useRunnerLogLevelsSet();
  const snapshot = query.data;
  return {
    scope: "desktop",
    row: APP_DIAGNOSTICS.definitions.appLogLevel,
    level: snapshot === undefined ? undefined : snapshot.desktopLogLevel,
    busy: query.isPending || query.isError || setMutation.isPending,
    set: async (level: LogLevel): Promise<void> => {
      await setMutation.mutateAsync({ scope: "desktop", level });
    },
  };
}

/**
 * The `cli` and `host` rows over the selected host's config RPC.
 *
 * Returns NOTHING — not a pair of rows that can never load — when the host
 * cannot answer: no client bound, a scope with no usable one, or a host that
 * predates the method. Two permanently-"Loading…" selects would be a promise
 * the page cannot keep, and the caller says why in its own words instead.
 */
export function useHostLogLevelControls(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly enabled: boolean;
}): readonly LogLevelControl[] {
  const { client } = props;
  const enabled = props.enabled && client !== null;
  const query = useHostQuery<HostRpcRegistry, "config.logLevels.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "config.logLevels.get",
    params: {},
    options: { enabled },
  });
  const setMutation = useHostScopedMutationForClient(client, {
    method: "config.logLevels.set",
    mutationKey: configMutationKeys.logLevelsSet(),
    errorMessage: "Couldn't update log level",
    invalidateMethods: ["config.logLevels.get"],
  });

  const levels = query.data;
  const busy = query.isPending || query.isError || setMutation.isPending;
  const mutateAsync = setMutation.mutateAsync;
  return useMemo((): readonly LogLevelControl[] => {
    if (!enabled) return [];
    return [
      {
        scope: "cli",
        row: HOST_DIAGNOSTICS.definitions.cliLogLevel,
        level: levels?.cliLogLevel,
        busy,
        set: async (level: LogLevel): Promise<void> => {
          await mutateAsync({ scope: "cli", level });
        },
      },
      {
        scope: "host",
        row: HOST_DIAGNOSTICS.definitions.hostLogLevel,
        level: levels?.hostLogLevel,
        busy,
        set: async (level: LogLevel): Promise<void> => {
          await mutateAsync({ scope: "host", level });
        },
      },
    ];
  }, [enabled, levels, busy, mutateAsync]);
}

/**
 * The `cli` and `host` rows over the local CLI bridge — the stopped-local
 * fallback, where the host process cannot answer for its own config but the
 * file it will read is right here.
 */
export function useBridgeHostLogLevelControls(): readonly LogLevelControl[] {
  const query = useRunnerLogLevelsQuery();
  const setMutation = useRunnerLogLevelsSet();
  const snapshot = query.data;
  const busy = query.isPending || query.isError || setMutation.isPending;
  const mutateAsync = setMutation.mutateAsync;
  // Same rule as the RPC controls: no source, no rows. A shell without the
  // bridge would otherwise get two selects that can never load.
  const available = getLogLevelsBridge() !== null;
  return useMemo((): readonly LogLevelControl[] => {
    if (!available) return [];
    return (["cli", "host"] as const).map((scope) => ({
      scope,
      row:
        scope === "cli"
          ? HOST_DIAGNOSTICS.definitions.cliLogLevel
          : HOST_DIAGNOSTICS.definitions.hostLogLevel,
      level:
        snapshot === undefined ? undefined : selectScopeLevel(snapshot, scope),
      busy,
      set: async (level: LogLevel): Promise<void> => {
        await mutateAsync({ scope, level });
      },
    }));
  }, [available, snapshot, busy, mutateAsync]);
}
