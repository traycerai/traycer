import { createFileRoute } from "@tanstack/react-router";
import { DiagnosticsSettingsPanel } from "@/components/settings/panels/diagnostics-settings-panel";

export const Route = createFileRoute("/settings/diagnostics")({
  component: DiagnosticsSettingsPanel,
});
