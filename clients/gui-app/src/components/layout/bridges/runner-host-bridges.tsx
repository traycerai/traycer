import { useCallback, useEffect } from "react";
import { useNotificationClick } from "@/hooks/notifications/use-notifications";
import { useTrayEpicsSource } from "@/hooks/tray/use-tray-epics-source";
import { useTrayProjection } from "@/hooks/tray/use-tray-projection";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRunnerLogLevelsQuery } from "@/hooks/runner/use-runner-log-levels-query";
import { setAppLogLevel } from "@/lib/logger";
import { useNotificationEventsStore } from "@/stores/notifications/notification-events-store";
import { useTrayProjectionStore } from "@/stores/tray/tray-projection-store";

/**
 * Connects GUI-owned runtime state to the always-present tray and
 * notification surfaces `IRunnerHost` exposes.
 *
 * - Sources the tray's recent-epic list from the history store
 *   (`useTrayEpicsSource`) and forwards it + the indicator to `runnerHost.tray`
 *   via `useTrayProjection`.
 * - Subscribes to `runnerHost.notifications.onClick` and routes payloads
 *   into the notification-events store.
 * - Subscribes to `runnerHost.tray.onEpicSelected` and records an open
 *   request in the tray-projection store; `TrayOpenEpicBridge` (mounted inside
 *   the router) consumes it and navigates, since this component sits above
 *   `RouterProvider` and has no `useNavigate`.
 *
 * The runner host contract guarantees tray/notifications are always
 * present (no-op on shells without a native surface), so this bridge does
 * not branch on capability.
 */
export function RunnerHostBridges(): null {
  useTrayEpicsSource();
  const epics = useTrayProjectionStore((state) => state.epics);
  const indicator = useTrayProjectionStore((state) => state.indicator);

  useTrayProjection({ epics, indicator });

  const recordNotificationClick = useNotificationEventsStore(
    (state) => state.recordClick,
  );
  const handleNotificationClick = useCallback(
    (payload: unknown) => {
      recordNotificationClick(payload);
    },
    [recordNotificationClick],
  );
  useNotificationClick(handleNotificationClick);

  const requestOpenEpic = useTrayProjectionStore(
    (state) => state.requestOpenEpic,
  );
  const runnerHost = useRunnerHost();
  useEffect(() => {
    const subscription = runnerHost.tray.onEpicSelected((epicId) => {
      requestOpenEpic(epicId);
    });
    return () => {
      subscription.dispose();
    };
  }, [runnerHost, requestOpenEpic]);

  // Keep the renderer's own log threshold in sync with the configured desktop
  // level (no-op outside the desktop shell, where the query stays disabled).
  const logLevels = useRunnerLogLevelsQuery();
  const desktopLogLevel = logLevels.data?.desktopLogLevel;
  useEffect(() => {
    if (desktopLogLevel !== undefined) {
      setAppLogLevel(desktopLogLevel);
    }
  }, [desktopLogLevel]);

  return null;
}
