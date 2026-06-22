import { createFileRoute } from "@tanstack/react-router";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsPanel,
});
