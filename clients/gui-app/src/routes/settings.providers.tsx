import { createFileRoute } from "@tanstack/react-router";
import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";

export const Route = createFileRoute("/settings/providers")({
  component: ProvidersSettingsPanel,
});
