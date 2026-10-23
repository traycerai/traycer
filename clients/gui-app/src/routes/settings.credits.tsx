import { createFileRoute } from "@tanstack/react-router";
import { CreditsSettingsPanel } from "@/components/settings/panels/credits-settings-panel";

export const Route = createFileRoute("/settings/credits")({
  component: CreditsSettingsPanel,
});
