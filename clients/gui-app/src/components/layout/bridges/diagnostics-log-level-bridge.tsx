import { useEffect } from "react";
import { useRunnerTraycerDiagnosticsConfigQuery } from "@/hooks/runner/use-runner-traycer-diagnostics-config-query";
import { setAppLogLevel } from "@/lib/logger";

export function DiagnosticsLogLevelBridge() {
  const diagnosticsQuery = useRunnerTraycerDiagnosticsConfigQuery();
  const level = diagnosticsQuery.data?.effective.general.level;

  useEffect(() => {
    setAppLogLevel(level ?? "info");
    return () => {
      setAppLogLevel("info");
    };
  }, [level]);

  return null;
}
