import { createFileRoute } from "@tanstack/react-router";
import { OrchestrationsSettingsPanel } from "@/components/settings/panels/orchestrations-settings-panel";

export const Route = createFileRoute("/settings/orchestrations")({
  component: OrchestrationsSettingsPanel,
});
