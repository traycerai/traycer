import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LogLevel } from "@traycer/protocol/config/log-level";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import {
  getLogLevelsBridge,
  type LogLevelScope,
  type LogLevelsSnapshot,
} from "@/lib/desktop-log-levels";
import { setAppLogLevel } from "@/lib/logger";

interface SetLogLevelInput {
  readonly scope: LogLevelScope;
  readonly level: LogLevel;
}

/**
 * Persists one log threshold through the desktop platform bridge. `set` returns
 * the full new snapshot (response equals state), so it is written straight into
 * the query cache rather than refetched, and the renderer's own threshold is
 * kept in lockstep with the desktop level.
 */
export function useRunnerLogLevelsSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: runnerMutationKeys.logLevelsSet(),
    mutationFn: (input: SetLogLevelInput) => {
      const bridge = getLogLevelsBridge();
      if (bridge === null) {
        throw new Error("Log levels are only available in the desktop app.");
      }
      return bridge.set(input.scope, input.level);
    },
    onSuccess: (snapshot: LogLevelsSnapshot) => {
      queryClient.setQueryData(runnerQueryKeys.logLevels(), snapshot);
      setAppLogLevel(snapshot.desktopLogLevel);
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't update log level"),
  });
}
