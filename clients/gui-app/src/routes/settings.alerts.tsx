import { createFileRoute } from "@tanstack/react-router";
import { AlertsSettingsPanel } from "@/components/settings/panels/alerts-settings-panel";

export const Route = createFileRoute("/settings/alerts")({
  component: AlertsSettingsPanel,
});
