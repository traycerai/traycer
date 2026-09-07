import { use, useCallback, useEffect, useSyncExternalStore } from "react";
import {
  getAgentActivitySnapshot,
  subscribeAgentActivity,
} from "@/lib/power/agent-activity";
import { useHostBinding } from "@/lib/host";
import { resolveDesktopPowerBridge } from "@/lib/windows/desktop-capabilities";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useSettingsStore } from "@/stores/settings/settings-store";

/** Holds the OS power-save blocker while the "Prevent sleep while running" setting is on and a local-host agent
 * is in progress (a chat turn is running, or a terminal-agent PTY has not exited). */
export function PreventSleepController() {
  const runnerHost = use(RunnerHostContext);
  const hostBinding = useHostBinding();
  const directory = hostBinding?.directory ?? null;
  const power =
    runnerHost === null ? null : resolveDesktopPowerBridge(runnerHost);
  const preventSleepWhileRunning = useSettingsStore(
    (state) => state.preventSleepWhileRunning,
  );
  const subscribeLocalHostId = useCallback(
    (listener: () => void) => {
      if (directory === null) {
        return () => {};
      }
      const disposable = directory.onChange(listener);
      return () => {
        disposable.dispose();
      };
    },
    [directory],
  );
  const getLocalHostIdSnapshot = useCallback(
    () => directory?.getLocalEntry()?.hostId ?? null,
    [directory],
  );
  const localHostId = useSyncExternalStore(
    subscribeLocalHostId,
    getLocalHostIdSnapshot,
    () => null,
  );
  const subscribeActivity = useCallback(
    (listener: () => void) => subscribeAgentActivity(localHostId, listener),
    [localHostId],
  );
  const getActivitySnapshot = useCallback(
    () => getAgentActivitySnapshot(localHostId),
    [localHostId],
  );
  const anyAgentActive = useSyncExternalStore(
    subscribeActivity,
    getActivitySnapshot,
    () => false,
  );
  const shouldBlock = preventSleepWhileRunning && anyAgentActive;

  useEffect(() => {
    if (power !== null) {
      void power.setSleepBlocked(shouldBlock);
    }
  }, [power, shouldBlock]);

  useEffect(() => {
    return () => {
      void power?.setSleepBlocked(false);
    };
  }, [power]);

  return null;
}
