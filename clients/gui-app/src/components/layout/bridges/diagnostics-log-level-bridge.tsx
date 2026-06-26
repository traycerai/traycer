import { useEffect } from "react";
import { useRunnerTraycerDiagnosticsConfigQuery } from "@/hooks/runner/use-runner-traycer-diagnostics-config-query";
import { setAppLogLevel } from "@/lib/logger";

export function DiagnosticsLogLevelBridge() {
  const diagnosticsQuery = useRunnerTraycerDiagnosticsConfigQuery();
  const level = diagnosticsQuery.data?.effective.general.level;

  useEffect(() => {
    if (level === undefined) return;
    setAppLogLevel(level);
  }, [level]);

  return null;
}
