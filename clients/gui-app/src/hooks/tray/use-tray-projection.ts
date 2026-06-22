import { useEffect } from "react";
import type {
  TrayEpic,
  TrayIndicatorState,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";

export interface TrayProjection {
  readonly epics: readonly TrayEpic[];
  readonly indicator: TrayIndicatorState;
}

/**
 * Forwards GUI-derived tray state into the runner-host tray surface.
 *
 * Tray is always present on `IRunnerHost`; shells without a native tray
 * install a no-op implementation whose events never fire and whose setters
 * do nothing, so this hook drives the same calls everywhere.
 */
export function useTrayProjection(projection: TrayProjection): void {
  const runnerHost = useRunnerHost();

  useEffect(() => {
    // Fire-and-forget: the Electron preload bridges these calls across IPC,
    // so they return a promise. We do not block the render path on the round
    // trip - the next projection update will replace any in-flight value.
    void runnerHost.tray.setEpics(projection.epics).catch(() => undefined);
  }, [runnerHost, projection.epics]);

  useEffect(() => {
    void runnerHost.tray
      .setIndicator(projection.indicator)
      .catch(() => undefined);
  }, [runnerHost, projection.indicator]);
}
