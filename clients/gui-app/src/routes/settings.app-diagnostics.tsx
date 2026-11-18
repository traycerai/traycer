import { createFileRoute } from "@tanstack/react-router";
import { AppDiagnosticsSettingsPanel } from "@/components/settings/panels/app-diagnostics-settings-panel";

export const Route = createFileRoute("/settings/app-diagnostics")({
  component: AppDiagnosticsSettingsPanel,
});
