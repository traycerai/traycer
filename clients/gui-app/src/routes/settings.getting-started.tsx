import { createFileRoute } from "@tanstack/react-router";
import { GettingStartedSettingsPanel } from "@/components/settings/panels/getting-started-settings-panel";

export const Route = createFileRoute("/settings/getting-started")({
  component: GettingStartedSettingsPanel,
});
