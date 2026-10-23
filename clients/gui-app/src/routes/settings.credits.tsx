import { createFileRoute } from "@tanstack/react-router";
import { CreditsSettingsPanel } from "@/components/settings/environment/credits-panel-placeholder";

export const Route = createFileRoute("/settings/credits")({
  component: CreditsSettingsPanel,
});
